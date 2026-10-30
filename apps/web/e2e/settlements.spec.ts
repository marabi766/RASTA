import { randomUUID } from 'node:crypto';

import { test, type APIRequestContext, type Page } from './expect';
import { expect } from './expect';

import { installLiveSession } from './live-session';
import { withContext } from '../src/lib/page-context';

/**
 * `/settlements` through the real stack: a real token, the real gateway, a real
 * economic-service on a real PostgreSQL.
 *
 * ## The data
 *
 * A settlement is made by `POST /v1/settlements`, which the organization's own
 * administrator may call. The portal only reads them, so the scenario makes its
 * two settlements through the gateway the way the economic suite does (top-up
 * → obligation with a hold → authorise → settle) and then looks at them in the
 * browser:
 *
 * - **own** — ORG-DEH-0001 pays ORG-DEH-0002. Both are parties.
 * - **third** — ORG-DEH-0001 pays `ORG-E2E-THIRD`. ORG-DEH-0002 is **not** a
 *   party. The development realm has no third organization with a signed-in
 *   administrator (the others are the union and the province, whose people are
 *   not tenant administrators), and economic-service does not require a
 *   counterparty to exist as a user — so the payee here is an id no seeded
 *   person belongs to, and the non-party is the second tenant's administrator.
 *   What is tested is exactly the service's rule (a settlement answers only to
 *   its payer and its payee), not that a third *signed-in* organization exists.
 *
 * Money moves nowhere: the payment provider is the mock one.
 *
 * ## Non-disclosure
 *
 * The key assertion is equality: another tenant's settlement is answered
 * exactly as one that does not exist — same status, same error code, same
 * words on the screen.
 */

const GROSS_MINOR = '7654321';
const GROSS_SHOWN = '۷٬۶۵۴٬۳۲۱';
const THIRD_ORGANIZATION = 'ORG-E2E-THIRD';
const OWN_PAYEE = 'ORG-DEH-0002';
const MISSING_SETTLEMENT = 'SET_01JZZZZZZZZZZZZZZZZZZZZZZZ';

function gatewayUrl(path: string): string {
  const base = process.env.API_GATEWAY_URL;
  if (!base) throw new Error('The live portal browser test requires API_GATEWAY_URL');
  return `${base.replace(/\/+$/, '')}${path}`;
}

async function call<T>(
  request: APIRequestContext,
  token: string,
  method: 'get' | 'post',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await request[method](gatewayUrl(path), {
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === 'post' ? { 'idempotency-key': `e2e-settlements-${randomUUID()}` } : {}),
    },
    ...(body === undefined ? {} : { data: body }),
  });
  return { status: response.status(), body: (await response.json()) as T };
}

/** The whole path to one settlement, as the paying organization's administrator. */
async function settle(
  request: APIRequestContext,
  token: string,
  counterpartyOrganizationId: string,
): Promise<string> {
  const wallet = await call<{ id: string }>(request, token, 'get', '/v1/wallets/me');
  expect(wallet.status).toBe(200);

  const topUp = await call(request, token, 'post', `/v1/wallets/${wallet.body.id}/top-up`, {
    amountMinor: '40000000',
  });
  expect(topUp.status).toBe(201);

  const reference = `e2e-settlements-${randomUUID()}`;
  const created = await call<{ id: string }>(request, token, 'post', '/v1/transactions', {
    transactionType: 'MAINTENANCE_SERVICE',
    counterpartyOrganizationId,
    grossAmountMinor: GROSS_MINOR,
    currency: 'IRR',
    sourceType: 'E2E',
    sourceReference: reference,
    holdFunds: true,
  });
  expect(created.status).toBe(201);

  const authorised = await call(
    request,
    token,
    'post',
    `/v1/transactions/${created.body.id}/authorise-settlement`,
  );
  expect(authorised.status).toBe(200);

  const settled = await call<{ settlementId: string }>(request, token, 'post', '/v1/settlements', {
    transactionId: created.body.id,
  });
  expect(settled.status).toBe(201);
  return settled.body.settlementId;
}

test.describe('settlements through the live stack', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E !== 'true',
    'needs the live stack the Portal in a browser job starts',
  );
  test.describe.configure({ mode: 'serial' });

  let ownId = '';
  let thirdId = '';

  async function mainText(page: Page): Promise<string> {
    return (await page.locator('main').innerText()).trim();
  }

  test.beforeAll(async ({ browser, newApiContext }) => {
    const context = await browser.newContext();
    const session = await installLiveSession(context, 'orgAdmin');
    await context.close();

    const request = await newApiContext();
    try {
      ownId = await settle(request, session.accessToken, OWN_PAYEE);
      thirdId = await settle(request, session.accessToken, THIRD_ORGANIZATION);
    } finally {
      await request.dispose();
    }
  });

  test('the payer sees what it paid, with the amount and the simulation notice', async ({
    context,
    page,
  }) => {
    await installLiveSession(context, 'orgAdmin');
    await page.goto('/settlements');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('تسویه‌ها');
    const text = await mainText(page);
    expect(text).toContain(ownId);
    expect(text).toContain(thirdId);
    expect(text).toContain(OWN_PAYEE);
    expect(text).toContain(GROSS_SHOWN);
    // Honest about what this is, and never a bank.
    expect(text).toContain('به هیچ بانک یا درگاه واقعی متصل نیستند');

    // The navigation offers the entry to a role the endpoint admits.
    await expect(
      page.getByRole('navigation', { name: 'ناوبری اصلی' }).getByRole('link', { name: 'تسویه‌ها' }),
    ).toBeVisible();
  });

  test('the payer’s received side holds neither of them', async ({ context, page }) => {
    const session = await installLiveSession(context, 'orgAdmin');
    await page.goto(withContext(session.context, '/settlements?view=RECEIVED'));

    const text = await mainText(page);
    expect(text).not.toContain(ownId);
    expect(text).not.toContain(thirdId);
  });

  test('the payee sees the settlement that paid it, on its received side only', async ({
    context,
    page,
  }) => {
    const session = await installLiveSession(context, 'orgAdminB');

    await page.goto(withContext(session.context, '/settlements?view=RECEIVED'));
    const received = await mainText(page);
    expect(received).toContain(ownId);
    expect(received).toContain('ORG-DEH-0001');
    expect(received).toContain(GROSS_SHOWN);
    expect(received).not.toContain(thirdId);

    await page.goto('/settlements');
    const paid = await mainText(page);
    expect(paid).not.toContain(ownId);
    expect(paid).not.toContain(thirdId);
  });

  test('a party opens the settlement and sees both sides of it', async ({ context, page }) => {
    await installLiveSession(context, 'orgAdminB');
    await page.goto(`/settlements/${ownId}`);

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('جزئیات تسویه');
    const text = await mainText(page);
    expect(text).toContain('ORG-DEH-0001');
    expect(text).toContain('ORG-DEH-0002');
    expect(text).toContain(GROSS_SHOWN);
  });

  test('another tenant’s settlement is answered exactly as a missing one', async ({
    context,
    page,
    request,
  }) => {
    const session = await installLiveSession(context, 'orgAdminB');

    // The service: same status, same code. (The message names the id asked
    // for, so it is compared with that id taken out.)
    const theirs = await call<{ code?: string; message?: string }>(
      request,
      session.accessToken,
      'get',
      `/v1/settlements/${thirdId}`,
    );
    const missing = await call<{ code?: string; message?: string }>(
      request,
      session.accessToken,
      'get',
      `/v1/settlements/${MISSING_SETTLEMENT}`,
    );
    expect(theirs.status).toBe(404);
    expect(theirs.status).toBe(missing.status);
    expect(theirs.body.code).toBe(missing.body.code);
    expect((theirs.body.message ?? '').replace(thirdId, '<id>')).toBe(
      (missing.body.message ?? '').replace(MISSING_SETTLEMENT, '<id>'),
    );

    // The screen: the same words, and nothing that admits the settlement exists.
    await page.goto(`/settlements/${thirdId}`);
    const shownForTheirs = await mainText(page);
    await page.goto(`/settlements/${MISSING_SETTLEMENT}`);
    const shownForMissing = await mainText(page);

    expect(shownForTheirs).toBe(shownForMissing);
    expect(shownForTheirs).toContain('تسویه‌ای یافت نشد');
    expect(shownForTheirs).not.toContain(GROSS_SHOWN);
    expect(shownForTheirs).not.toContain(THIRD_ORGANIZATION);
  });
});
