import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

import { toLatinDigits, toPersianDigits } from '../src/lib/format';
import {
  RETURN_CANCEL_NOT_IN_PORTAL,
  RETURN_REFUSAL_TEXT,
  RETURN_SHIPMENT_UNVERIFIED,
} from '../src/lib/return-fields';
import {
  installLiveSession,
  installProvisionedSession,
  liveAccessToken,
  type LivePersona,
  type ProvisionedPerson,
} from './live-session';
import { provisionPerson } from './provisioned-people';

/**
 * Returns through the real stack (EXP-003, RUN-005): the portal, the real
 * gateway, a real marketplace-service and inventory-service on a real
 * PostgreSQL, real tokens.
 *
 * ## The data
 *
 * The orders are the "Portal in a browser" job's fixture
 * (`e2e/fixtures/marketplace-returns.sql`, which says why they are rows and
 * not routes): ORG-DEH-0001 bought from ORG-DEH-0002, one order completed two
 * days ago and one four hundred days ago, with the job's return window set to
 * thirty days (`MARKETPLACE_RETURN_WINDOW_DAYS`, a value for this stack only:
 * Q-132 leaves the real one open). Everything else is made here: the requests
 * are asked, decided and withdrawn **in the browser**, through the portal's own
 * forms; the goods' side — inventory-service's commands, which the portal does
 * not offer — through its API, as the supplier.
 *
 * ## Who does what
 *
 * - **the buyer** — `dehyari.admin` (ORG-DEH-0001): asks, is refused the old
 *   order in fixed words, withdraws its second request; is offered no decision.
 * - **the supplier** — `dehyari.admin.b` (ORG-DEH-0002): sees the request on
 *   its side and authorizes it; records the goods on their way and received.
 * - **a third organization** — provisioned with ORGANIZATION_ADMIN into an
 *   organization of its own: records a shipment into its own warehouse naming
 *   the buyer and the request (inventory-service takes the references on
 *   trust), which the buyer is shown only as "not borne out", never as
 *   progress; and the request and the order are, to it, the same absence as
 *   an id that does not exist.
 *
 * The buyer withdraws only a request not yet authorized (PR 336 review 2, PM
 * ruling): a withdrawal form drawn before the supplier authorized is refused
 * when sent after, and nothing is sent; an authorized request — moving or not,
 * marketplace-service says AUTHORIZED either way while its mirror is off in
 * this stack — offers none, and says so.
 *
 * No money moves and none is claimed to: a return is not a refund (Q-76).
 */

const RECENT_ORDER = 'ORD_01JE2ERETVRNS0000000000001';
const OLD_ORDER = 'ORD_01JE2ERETVRNS0000000000002';
const LINE_AGGREGATE = 'OLN_01JE2ERETVRNS00000000000A1';
const LINE_CEMENT = 'OLN_01JE2ERETVRNS00000000000B1';
const BUYER = 'ORG-DEH-0001';
const OUTSIDER_ORGANIZATION = 'ORG-E2E-OUTSIDER';
const MISSING_RETURN = 'RET_01JZZZZZZZZZZZZZZZZZZZZZZZ';
const RUN = randomUUID().slice(0, 8);
const REASON = `سه تن شن خیس و کلوخه رسید — آزمون ${RUN}`;

const WCAG_2_1_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function mainText(page: Page): Promise<string> {
  return (await page.locator('main').innerText()).trim();
}

async function expectAccessible(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_2_1_AA).analyze();
  expect(violations).toEqual([]);
}

/** The number after «قابل بازگشت:» in the hint of a line's input, read back from Persian digits. */
async function availableOn(input: Locator): Promise<number> {
  const described = await input.evaluate((element) =>
    (element.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' '),
  );
  const text = toLatinDigits(described);
  const match = /قابل بازگشت: (\d+)/.exec(text);
  if (!match) throw new Error(`no available quantity in "${text}"`);
  return Number(match[1]);
}

/** A fresh browser context signed in as one person, for one step of the story. */
async function as(
  browser: Browser,
  who: LivePersona | ProvisionedPerson,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ locale: 'fa-IR', timezoneId: 'Asia/Tehran' });
  if (typeof who === 'string') await installLiveSession(context, who);
  else await installProvisionedSession(context, who);
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

function gatewayUrl(path: string): string {
  const base = process.env.API_GATEWAY_URL;
  if (!base) throw new Error('The live return scenarios require API_GATEWAY_URL');
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** A provisioned person's access token, by the realm's password grant, for its own API calls. */
async function tokenOf(person: ProvisionedPerson): Promise<string> {
  const issuer = (process.env.OIDC_ISSUER_URL ?? '').replace(/\/+$/, '');
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: process.env.OIDC_CLIENT_ID ?? '',
      username: person.username,
      password: person.password,
      scope: 'openid',
    }),
  });
  if (!response.ok) throw new Error(`no token for ${person.username} (${response.status})`);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** One inventory-service command, through the gateway — as the supplier unless told otherwise. */
async function asSupplier(
  path: string,
  body: unknown,
  token?: string,
): Promise<{ id: string; version: number }> {
  const bearer = token ?? (await liveAccessToken('orgAdminB'));
  const response = await fetch(gatewayUrl(path), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      'idempotency-key': `e2e-returns-${randomUUID()}`,
    },
    body: JSON.stringify(body),
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as { id: string; version: number };
}

// Under CI the job sets the flag; a skip there would be a green job with no evidence.
if (process.env.CI && process.env.WEB_LIVE_STACK_E2E_RETURNS !== 'true') {
  test('CI runs the live return scenarios, none skipped', () => {
    throw new Error(
      'WEB_LIVE_STACK_E2E_RETURNS must be \'true\' in CI: the "Portal in a browser" job loads ' +
        'the marketplace return fixture and sets the return window for these scenarios.',
    );
  });
}

test.describe.serial('returns, live (EXP-003)', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E_RETURNS !== 'true',
    'needs e2e/fixtures/marketplace-returns.sql loaded and MARKETPLACE_RETURN_WINDOW_DAYS set, ' +
      'alongside the usual live stack — set WEB_LIVE_STACK_E2E_RETURNS=true locally after ' +
      'starting it (the "Portal in a browser" CI job always does)',
  );
  test.setTimeout(120_000);

  let outsider: ProvisionedPerson;
  let returnPath = '';

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    outsider = await provisionPerson(
      await liveAccessToken('systemAdmin'),
      `e2e.returns.${RUN}.outsider`,
      OUTSIDER_ORGANIZATION,
      ['ORGANIZATION_ADMIN'],
    );
  });

  test('the buyer asks to return goods of the completed order', async ({ browser }) => {
    const { page, close } = await as(browser, 'orgAdmin');
    try {
      await page.goto(`/orders/${RECENT_ORDER}`);
      const form = page.getByRole('form', { name: 'درخواست بازگشت کالا' });
      await expect(form).toBeVisible();
      // What the gravel line still allows: 10 on a fresh database, less what an
      // earlier attempt's open request (a retry, a local re-run) already takes.
      const allowed = await availableOn(form.locator(`[name="quantity.${LINE_AGGREGATE}"]`));
      expect(allowed).toBeGreaterThanOrEqual(3);
      await expectAccessible(page);

      await form.getByLabel('دلیل بازگشت').fill(REASON);
      await form.locator(`[name="quantity.${LINE_AGGREGATE}"]`).fill('۳');
      await form.getByRole('button', { name: 'درخواست بازگشت کالا' }).click();

      await expect(page).toHaveURL(/\/returns\/RET_[^?]+\?flash=/);
      returnPath = new URL(page.url()).pathname;
      await expect(
        page.getByText('درخواست بازگشت ثبت شد و برای تأمین‌کننده فرستاده شد.'),
      ).toBeVisible();
      await expect(
        page.getByText('درخواست‌شده، در انتظار تصمیم تأمین‌کننده').first(),
      ).toBeVisible();
      await expect(page.getByText(REASON)).toBeVisible();
      await expect(page.getByText('درخواست بازگشت بازپرداخت نیست', { exact: false })).toBeVisible();
      // The buyer withdraws; it never decides.
      await expect(page.getByRole('form', { name: 'لغو درخواست بازگشت' })).toBeVisible();
      await expect(page.getByRole('form', { name: 'پذیرفتن بازگشت' })).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'جابه‌جایی و بازرسی کالا' })).toContainText(
        'هنوز محموله‌ای',
      );
      await expectAccessible(page);

      // Back on the order, the line now allows what is left.
      await page.goto(`/orders/${RECENT_ORDER}`);
      await expect(page.getByRole('form', { name: 'درخواست بازگشت کالا' })).toContainText(
        `قابل بازگشت: ${toPersianDigits(String(allowed - 3))}`,
      );
      await expect(page.getByRole('list', { name: 'درخواست‌های بازگشت این سفارش' })).toBeVisible();
    } finally {
      await close();
    }
  });

  test('an order completed long ago is refused in the portal’s own words', async ({ browser }) => {
    const { page, close } = await as(browser, 'orgAdmin');
    try {
      await page.goto(`/orders/${OLD_ORDER}`);
      const form = page.getByRole('form', { name: 'درخواست بازگشت کالا' });
      await form.getByLabel('دلیل بازگشت').fill(REASON);
      await form.locator('input[name^="quantity."]').first().fill('1');
      await form.getByRole('button', { name: 'درخواست بازگشت کالا' }).click();
      await expect(page.getByText(RETURN_REFUSAL_TEXT.WINDOW_ELAPSED)).toBeVisible();
      expect(await mainText(page)).not.toMatch(/elapsed|window/i);
      await expectAccessible(page);
    } finally {
      await close();
    }
  });

  test('the supplier finds it on its side and authorizes it; the buyer’s earlier withdrawal form is then refused', async ({
    browser,
  }) => {
    expect(returnPath).not.toBe('');
    // The buyer has the request open, its withdrawal form drawn while REQUESTED.
    const buyer = await as(browser, 'orgAdmin');
    await buyer.page.goto(returnPath);
    const stale = buyer.page.getByRole('form', { name: 'لغو درخواست بازگشت' });
    await expect(stale).toBeVisible();

    const { page, close } = await as(browser, 'orgAdminB');
    try {
      await page.goto('/returns?role=SUPPLIER');
      const row = page
        .getByRole('listitem')
        .filter({ has: page.locator(`a[href="${returnPath}"]`) });
      await expect(row).toContainText('اقدامی از سوی شما لازم است');
      await expectAccessible(page);

      await page.goto(returnPath);
      await expect(page.getByText(REASON)).toBeVisible();
      await expect(page.getByRole('form', { name: 'لغو درخواست بازگشت' })).toHaveCount(0);
      await page
        .getByRole('form', { name: 'پذیرفتن بازگشت' })
        .getByRole('button', { name: 'پذیرفتن بازگشت' })
        .click();
      await expect(
        page.getByText('بازگشت پذیرفته شد. کالا هنوز باید فرستاده، دریافت و بازرسی شود.'),
      ).toBeVisible();
      await expect(page.getByText('پذیرفته‌شده، در انتظار ارسال کالا').first()).toBeVisible();
      await expect(page.getByRole('form', { name: 'رد درخواست بازگشت' })).toHaveCount(0);
      await expectAccessible(page);
    } finally {
      await close();
    }

    try {
      // Sent after the authorization: the action re-reads the request and
      // refuses — nothing reaches marketplace-service, which would take it.
      await stale.getByRole('button', { name: 'لغو درخواست بازگشت' }).click();
      await expect(buyer.page.getByText(RETURN_REFUSAL_TEXT.CANCEL_NOT_IN_PORTAL)).toBeVisible();
      await expectAccessible(buyer.page);
      await buyer.page.goto(returnPath);
      await expect(buyer.page.getByText('پذیرفته‌شده، در انتظار ارسال کالا').first()).toBeVisible();
      await expect(
        buyer.page.getByRole('list', { name: 'سابقهٔ درخواست بازگشت' }),
      ).not.toContainText('خریدار درخواست را لغو کرد');
      await expect(buyer.page.getByRole('form', { name: 'لغو درخواست بازگشت' })).toHaveCount(0);
      await expect(buyer.page.getByRole('region', { name: 'اقدام بعدی شما' })).toContainText(
        RETURN_CANCEL_NOT_IN_PORTAL,
      );
      await expectAccessible(buyer.page);
    } finally {
      await buyer.close();
    }
  });

  test('a third organization’s shipment naming the buyer and this request is never shown as its progress', async ({
    browser,
  }) => {
    expect(returnPath).not.toBe('');
    const returnId = returnPath.split('/').pop()!;
    // An operator outside the request names it on a shipment into its own warehouse
    // (PR 336 review 1, finding 1). Since #339 inventory-service resolves the return
    // request first and refuses: nothing is recorded, so the buyer has nothing to read.
    const outsiderToken = await tokenOf(outsider);
    const theirs = await asSupplier(
      '/v1/warehouses',
      { name: `انبار بیگانه ${RUN}` },
      outsiderToken,
    );
    const refused = await fetch(gatewayUrl('/v1/return-shipments'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${outsiderToken}`,
        'content-type': 'application/json',
        'idempotency-key': `e2e-returns-${randomUUID()}`,
      },
      body: JSON.stringify({
        returnRequestId: returnId,
        orderId: RECENT_ORDER,
        buyerOrganizationId: BUYER,
        destinationWarehouseId: theirs.id,
        lines: [
          { orderLineId: LINE_AGGREGATE, productId: 'PRD_01JE2ERETVRNS00000000000P1', quantity: 3 },
        ],
        carrierName: 'باربری جعلی',
      }),
    });
    expect(refused.status).toBe(404);

    const buyer = await as(browser, 'orgAdmin');
    try {
      await buyer.page.goto(returnPath);
      const goods = buyer.page.getByRole('region', { name: 'جابه‌جایی و بازرسی کالا' });
      await expect(goods).toContainText(RETURN_SHIPMENT_UNVERIFIED);
      await expect(goods).toContainText('هنوز محموله‌ای');
      expect(await goods.innerText()).not.toContain('باربری جعلی');
      // Authorized: no withdrawal in the portal, whatever inventory lists.
      await expect(buyer.page.getByRole('form', { name: 'لغو درخواست بازگشت' })).toHaveCount(0);
      await expect(buyer.page.getByRole('region', { name: 'اقدام بعدی شما' })).toContainText(
        RETURN_CANCEL_NOT_IN_PORTAL,
      );
      await expectAccessible(buyer.page);
    } finally {
      await buyer.close();
    }
  });

  test('the goods come back: both parties see them on their way, then received; still no withdrawal', async ({
    browser,
  }) => {
    expect(returnPath).not.toBe('');
    const returnId = returnPath.split('/').pop()!;
    const warehouse = await asSupplier('/v1/warehouses', { name: `انبار بازگشت ${RUN}` });
    const shipment = await asSupplier('/v1/return-shipments', {
      returnRequestId: returnId,
      orderId: RECENT_ORDER,
      buyerOrganizationId: BUYER,
      destinationWarehouseId: warehouse.id,
      lines: [
        { orderLineId: LINE_AGGREGATE, productId: 'PRD_01JE2ERETVRNS00000000000P1', quantity: 3 },
      ],
      carrierName: 'باربری آزمون',
    });

    const buyer = await as(browser, 'orgAdmin');
    try {
      await buyer.page.goto(returnPath);
      const goods = buyer.page.getByRole('region', { name: 'جابه‌جایی و بازرسی کالا' });
      await expect(goods).toContainText('در راه بازگشت');
      await expect(goods).toContainText('باربری آزمون');
      // marketplace-service still says AUTHORIZED (its mirror is off here), yet
      // the goods left: withdrawing now would release units already coming
      // back (PR 336 reviews 1 and 2, finding 2).
      await expect(buyer.page.getByText('پذیرفته‌شده، در انتظار ارسال کالا').first()).toBeVisible();
      await expect(buyer.page.getByRole('form', { name: 'لغو درخواست بازگشت' })).toHaveCount(0);
      await expect(buyer.page.getByRole('region', { name: 'اقدام بعدی شما' })).toContainText(
        RETURN_CANCEL_NOT_IN_PORTAL,
      );
      await expectAccessible(buyer.page);
    } finally {
      await buyer.close();
    }

    await asSupplier(`/v1/return-shipments/${shipment.id}/receive`, {
      lines: [{ orderLineId: LINE_AGGREGATE, receivedQuantity: 3 }],
    });
    const supplier = await as(browser, 'orgAdminB');
    try {
      await supplier.page.goto(returnPath);
      const goods = supplier.page.getByRole('region', { name: 'جابه‌جایی و بازرسی کالا' });
      await expect(goods).toContainText('دریافت‌شده، در انتظار بازرسی');
      await expect(goods).toContainText('کالا دریافت شد');
    } finally {
      await supplier.close();
    }
  });

  test('the buyer withdraws a second request before anything moves', async ({ browser }) => {
    const { page, close } = await as(browser, 'orgAdmin');
    try {
      await page.goto(`/orders/${RECENT_ORDER}`);
      const form = page.getByRole('form', { name: 'درخواست بازگشت کالا' });
      await form.getByLabel('دلیل بازگشت').fill(`${REASON} — سیمان`);
      await form.locator(`[name="quantity.${LINE_CEMENT}"]`).fill('2');
      await form.getByRole('button', { name: 'درخواست بازگشت کالا' }).click();
      await expect(page).toHaveURL(/\/returns\/RET_[^?]+\?flash=/);

      await page
        .getByRole('form', { name: 'لغو درخواست بازگشت' })
        .getByRole('button', { name: 'لغو درخواست بازگشت' })
        .click();
      await expect(page.getByText('درخواست بازگشت لغو شد.')).toBeVisible();
      await expect(page.getByText('لغوشده', { exact: true }).first()).toBeVisible();
      await expect(page.getByRole('list', { name: 'سابقهٔ درخواست بازگشت' })).toContainText(
        'خریدار درخواست را لغو کرد',
      );
      await expect(page.getByRole('form')).toHaveCount(0);
      await expectAccessible(page);
    } finally {
      await close();
    }
  });

  test('a third organization sees the request, and the order, as ids that do not exist', async ({
    browser,
  }) => {
    expect(returnPath).not.toBe('');
    const { page, close } = await as(browser, outsider);
    try {
      await page.goto(returnPath);
      await expect(page.getByText('این درخواست بازگشت پیدا نشد')).toBeVisible();
      const theirs = await mainText(page);
      expect(theirs).not.toContain(REASON);
      await page.goto(`/returns/${MISSING_RETURN}`);
      await expect(page.getByText('این درخواست بازگشت پیدا نشد')).toBeVisible();
      expect(await mainText(page)).toBe(theirs);

      await page.goto(`/orders/${RECENT_ORDER}`);
      await expect(page.getByText('سفارشی با این شناسه یافت نشد')).toBeVisible();
      await expect(page.getByRole('form', { name: 'درخواست بازگشت کالا' })).toHaveCount(0);

      await page.goto('/returns?role=BUYER');
      expect(await mainText(page)).not.toContain(returnPath.split('/').pop()!);
    } finally {
      await close();
    }
  });
});
