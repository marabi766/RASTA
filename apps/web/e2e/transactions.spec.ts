import { randomUUID } from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { installLiveSession } from './live-session';

/**
 * `/transactions/[id]` and its dispute through the real stack: a real token,
 * the real gateway, a real economic-service on a real PostgreSQL.
 *
 * ## The data
 *
 * Made through the gateway the way `settlements.spec.ts` makes its own (top-up
 * → obligation with a hold), then disputed and resolved **in the browser**:
 *
 * - **own** — ORG-DEH-0001 pays ORG-DEH-0002, funds held. Both are parties.
 * - **third** — ORG-DEH-0001 pays `ORG-E2E-THIRD`. ORG-DEH-0002 is **not** a
 *   party (the same stand-in third organization as the settlement scenarios).
 *
 * Money moves nowhere: the payment provider is the mock one, and nothing here
 * settles.
 *
 * ## Who does what
 *
 * The payer's administrator opens the dispute; the payee's administrator sees
 * it and is offered no form (economic-service refuses it 403); the union's
 * administrator — a platform role — resolves it, which puts the transaction
 * back in the settlement queue and settles nothing.
 */

const GROSS_MINOR = '3456789';
const GROSS_SHOWN = '۳٬۴۵۶٬۷۸۹';
const THIRD_ORGANIZATION = 'ORG-E2E-THIRD';
const OWN_PAYEE = 'ORG-DEH-0002';
const MISSING_TRANSACTION = 'TXN_01JZZZZZZZZZZZZZZZZZZZZZZZ';
const REASON = `کالا تحویل نشده و پاسخی نیامده است — آزمون ${randomUUID().slice(0, 8)}`;
const RESOLUTION = `تحویل با رسید تأیید شد؛ اعتراض برطرف است — آزمون ${randomUUID().slice(0, 8)}`;

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
      ...(method === 'post' ? { 'idempotency-key': `e2e-transactions-${randomUUID()}` } : {}),
    },
    ...(body === undefined ? {} : { data: body }),
  });
  return { status: response.status(), body: (await response.json()) as T };
}

/** One obligation with its funds held, as the paying organization's administrator. */
async function hold(
  request: APIRequestContext,
  token: string,
  counterpartyOrganizationId: string,
): Promise<string> {
  const wallet = await call<{ id: string }>(request, token, 'get', '/v1/wallets/me');
  expect(wallet.status).toBe(200);

  const topUp = await call(request, token, 'post', `/v1/wallets/${wallet.body.id}/top-up`, {
    amountMinor: '10000000',
  });
  expect(topUp.status).toBe(201);

  const created = await call<{ id: string; status: string }>(
    request,
    token,
    'post',
    '/v1/transactions',
    {
      transactionType: 'MAINTENANCE_SERVICE',
      counterpartyOrganizationId,
      grossAmountMinor: GROSS_MINOR,
      currency: 'IRR',
      sourceType: 'E2E',
      sourceReference: `e2e-transactions-${randomUUID()}`,
      holdFunds: true,
    },
  );
  expect(created.status).toBe(201);
  expect(created.body.status).toBe('HELD');
  return created.body.id;
}

async function mainText(page: Page): Promise<string> {
  return (await page.locator('main').innerText()).trim();
}

test.describe('transaction disputes through the live stack', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E !== 'true',
    'needs the live stack the Portal in a browser job starts',
  );
  test.describe.configure({ mode: 'serial' });

  let ownId = '';
  let thirdId = '';

  test.beforeAll(async ({ browser, playwright }) => {
    const context = await browser.newContext();
    const session = await installLiveSession(context, 'orgAdmin');
    await context.close();

    const request = await playwright.request.newContext();
    try {
      ownId = await hold(request, session.accessToken, OWN_PAYEE);
      thirdId = await hold(request, session.accessToken, THIRD_ORGANIZATION);
    } finally {
      await request.dispose();
    }
  });

  test('the payer reaches the transaction from the wallet and opens a dispute', async ({
    context,
    page,
    request,
  }) => {
    const session = await installLiveSession(context, 'orgAdmin');
    await page.goto('/wallet');
    await expect(page.locator(`a[href="/transactions/${ownId}"]`)).toBeVisible();

    await page.goto(`/transactions/${ownId}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('جزئیات تراکنش');
    const before = await mainText(page);
    expect(before).toContain(GROSS_SHOWN);
    expect(before).toContain('اعتراضی ثبت نشده است');
    expect(before).toContain('به هیچ بانک یا درگاه واقعی متصل نیست');
    // An organization administrator is never offered the resolution.
    await expect(page.getByRole('form', { name: 'رسیدگی به اعتراض' })).toHaveCount(0);

    const form = page.getByRole('form', { name: 'ثبت اعتراض' });
    await form.getByLabel('دلیل اعتراض').fill(REASON);
    await form.getByRole('button', { name: 'ثبت اعتراض' }).click();

    await page.waitForURL(`**/transactions/${ownId}?done=DISPUTE`);
    const after = await mainText(page);
    expect(after).toContain('اعتراض ثبت شد');
    expect(after).toContain('تسویهٔ آن متوقف است');
    expect(after).toContain(REASON);
    await expect(page.getByRole('form', { name: 'ثبت اعتراض' })).toHaveCount(0);

    // The record agrees with the screen.
    const read = await call<{ status: string; disputeReason: string | null }>(
      request,
      session.accessToken,
      'get',
      `/v1/transactions/${ownId}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.status).toBe('DISPUTED');
    expect(read.body.disputeReason).toBe(REASON);
  });

  test('the payee sees the dispute and is offered no form', async ({ context, page }) => {
    await installLiveSession(context, 'orgAdminB');
    await page.goto(`/transactions/${ownId}`);

    const text = await mainText(page);
    expect(text).toContain('تسویهٔ آن متوقف است');
    expect(text).toContain(REASON);
    expect(text).toContain('ORG-DEH-0001');
    await expect(page.locator('main form')).toHaveCount(0);
  });

  test('another tenant’s transaction is answered exactly as a missing one', async ({
    context,
    page,
    request,
  }) => {
    const session = await installLiveSession(context, 'orgAdminB');

    // The service: same status, same code. (The message may name the id asked
    // for, so it is compared with that id taken out.)
    const theirs = await call<{ code?: string; message?: string }>(
      request,
      session.accessToken,
      'get',
      `/v1/transactions/${thirdId}`,
    );
    const missing = await call<{ code?: string; message?: string }>(
      request,
      session.accessToken,
      'get',
      `/v1/transactions/${MISSING_TRANSACTION}`,
    );
    expect(theirs.status).toBe(404);
    expect(theirs.status).toBe(missing.status);
    expect(theirs.body.code).toBe(missing.body.code);
    expect((theirs.body.message ?? '').replace(thirdId, '<id>')).toBe(
      (missing.body.message ?? '').replace(MISSING_TRANSACTION, '<id>'),
    );

    // And a dispute aimed at it is refused the same way, changing nothing.
    const disputed = await call<{ code?: string }>(
      request,
      session.accessToken,
      'post',
      `/v1/transactions/${thirdId}/dispute`,
      { reason: 'دلیلی برای آزمون جداسازی مستأجر' },
    );
    expect(disputed.status).toBe(404);

    // The screen: the same words, and nothing that admits the transaction exists.
    await page.goto(`/transactions/${thirdId}`);
    const shownForTheirs = await mainText(page);
    await page.goto(`/transactions/${MISSING_TRANSACTION}`);
    const shownForMissing = await mainText(page);

    expect(shownForTheirs).toBe(shownForMissing);
    expect(shownForTheirs).toContain('تراکنشی یافت نشد');
    expect(shownForTheirs).not.toContain(GROSS_SHOWN);
    expect(shownForTheirs).not.toContain(THIRD_ORGANIZATION);
  });

  test('a platform operator resolves it back to the settlement queue, settling nothing', async ({
    context,
    page,
    request,
  }) => {
    const session = await installLiveSession(context, 'unionAdmin');
    await page.goto(`/transactions/${ownId}`);

    const form = page.getByRole('form', { name: 'رسیدگی به اعتراض' });
    await expect(form).toContainText('تسویه نمی‌کند');
    await form.getByLabel('شرح تصمیم').fill(RESOLUTION);
    await form.getByRole('button', { name: 'رسیدگی به اعتراض' }).click();

    await page.waitForURL(`**/transactions/${ownId}?done=RESOLVE_DISPUTE`);
    const text = await mainText(page);
    expect(text).toContain('تسویه انجام نشده است');
    expect(text).toContain('در انتظار تسویه');
    expect(text).toContain('اعتراض ثبت شده بود');

    const read = await call<{ status: string; settlement: unknown }>(
      request,
      session.accessToken,
      'get',
      `/v1/transactions/${ownId}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.status).toBe('PENDING_SETTLEMENT');
    expect(read.body.settlement).toBeNull();
  });
});
