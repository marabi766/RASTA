import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

import { installProvisionedSession, type ProvisionedPerson } from './live-session';
import { provisionedAccessToken } from './provisioned-people';
import { castForRun, gateway, publishedTender, type TenderCast } from './tender-cast';

/**
 * A contractor's own bid through the real stack: the portal, the real
 * gateway, a real construction-service (with a tender key-encryption key, so
 * a tender can be published and a bid sealed), supplier-service deciding the
 * contractor's standing at the moment it bids, organization-service and
 * identity-service, real tokens.
 *
 * ## The data
 *
 * Nothing seeded: `tender-cast.ts` makes the owner, its policies, its project
 * and the people once per run through the platform's routes, and **every test
 * publishes its own tender** — so a retry bids on a tender nobody has bid on.
 * Everything a bidder does is done **in the browser**: submit, replace,
 * withdraw, through the portal's own forms; what the service then holds is
 * read back with the same person's token.
 *
 * ## Who does what
 *
 * - **the contractor** — qualified for CONTRACTING, invited: submits, replaces
 *   and withdraws its bid.
 * - **an unqualified contractor** — invited, so the form is drawn, and refused
 *   by construction-service as supplier-service says, in the page's words.
 * - **the contractor again, at the deadline** — a form drawn while the window
 *   was open, sent after it closed: refused, in the page's words.
 * - **another tenant's contractor** — the restricted tender is the same
 *   absence as an id that does not exist, and no bid of its own is shown.
 *
 * The owner's side — closing, opening, evaluation, award — is not this slice.
 */

const RUN = randomUUID().replace(/-/g, '').slice(0, 8);
const WCAG_2_1_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** `lib/bid-fields.ts`'s fixed words, as the page says them. */
const NOT_ELIGIBLE =
  'سرویس تأمین‌کنندگان سازمان شما را اکنون واجد صلاحیت پیمانکاری (CONTRACTING) نمی‌داند — صلاحیتی تأییدنشده یا تعلیق — پس پیشنهاد پذیرفته نشد و چیزی ثبت نشد.';
const WINDOW_CLOSED =
  'مهلت پذیرش پیشنهاد این مناقصه گذشته است؛ چیزی ثبت نشد. پس از مهلت پیشنهادی ثبت، جایگزین یا پس گرفته نمی‌شود.';

async function expectAccessible(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_2_1_AA).analyze();
  expect(violations).toEqual([]);
}

async function as(
  browser: Browser,
  who: ProvisionedPerson,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  await installProvisionedSession(context, who);
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

const tenderPage = (id: string) => `/tenders/${encodeURIComponent(id)}?view=open`;
const ownBid = (page: Page) => page.getByRole('region', { name: 'پیشنهاد سازمان شما' });

/** What the service holds of this person's bid, read with the person's own token. */
async function mine(person: ProvisionedPerson, tenderId: string, status = 200) {
  return gateway(
    await provisionedAccessToken(person),
    'GET',
    `/v1/tenders/${tenderId}/bids/mine`,
    status,
  ) as Promise<Record<string, unknown>>;
}

async function fillContent(page: Page, form: string, price: string, answer: string) {
  const scope = page.getByRole('form', { name: form });
  await scope.getByRole('textbox', { name: /مبلغ پیشنهاد/ }).fill(price);
  await scope.getByRole('textbox', { name: 'روش اجرا (نمونه)' }).fill(answer);
}

// Under CI the job sets the flag; a skip there would be a green job with no evidence.
if (process.env.CI && process.env.WEB_LIVE_STACK_E2E_TENDERS !== 'true') {
  test('CI runs the live bid scenarios, none skipped', () => {
    throw new Error(
      'WEB_LIVE_STACK_E2E_TENDERS must be \'true\' in CI: the "Portal in a browser" job starts ' +
        'construction-service with a tender key and supplier-service for these scenarios.',
    );
  });
}

test.describe('a contractor’s own bid, live (EXP-004)', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E_TENDERS !== 'true',
    'needs construction-service with CONSTRUCTION_TENDER_KEKS and supplier-service, alongside the ' +
      'usual live stack — set WEB_LIVE_STACK_E2E_TENDERS=true locally after starting them (the ' +
      '"Portal in a browser" CI job always does)',
  );
  // One worker runs the file in order; each test still publishes its own tender.
  test.describe.configure({ mode: 'default' });
  test.setTimeout(180_000);

  let cast: TenderCast;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    // Per hook run: a retry in a new worker makes a cast of its own.
    cast = await castForRun(`${RUN}${randomUUID().slice(0, 4)}`);
  });

  test('the contractor submits its bid, replaces it and withdraws it — the receipt, never the content', async ({
    browser,
  }) => {
    const tender = await publishedTender(cast, 30 * 60_000);
    const { page, close } = await as(browser, cast.contractor);
    try {
      await page.goto(tenderPage(tender.id));
      await expect(ownBid(page)).toContainText(
        'سازمان شما برای این مناقصه پیشنهادی ثبت نکرده است.',
      );
      await fillContent(page, 'ثبت پیشنهاد', '۴٬۲۰۰٬۰۰۰٬۰۰۰', 'روش اجرا با ماشین‌آلات خودی');
      await page
        .getByRole('form', { name: 'ثبت پیشنهاد' })
        .getByRole('button', { name: 'ثبت پیشنهاد' })
        .click();
      await expect(page.getByText('پیشنهاد ثبت شد. رسید آن در زیر آمده است.')).toBeVisible();
      await expect(ownBid(page)).toContainText('ثبت‌شده');
      await expect(ownBid(page)).not.toContainText('۴٬۲۰۰٬۰۰۰٬۰۰۰');
      const submitted = await mine(cast.contractor, tender.id);
      expect(submitted).toMatchObject({ tenderId: tender.id, status: 'SUBMITTED', revision: 1 });
      expect(submitted).not.toHaveProperty('content');
      await expect(ownBid(page)).toContainText(String(submitted.receipt));
      await expectAccessible(page);

      await fillContent(page, 'جایگزینی پیشنهاد', '4100000000', 'روش اجرا، بازنگری‌شده');
      await page
        .getByRole('form', { name: 'جایگزینی پیشنهاد' })
        .getByRole('button', { name: 'جایگزینی پیشنهاد' })
        .click();
      await expect(
        page.getByText('پیشنهاد جایگزین ثبت شد. رسید تازهٔ آن در زیر آمده است.'),
      ).toBeVisible();
      expect(await mine(cast.contractor, tender.id)).toMatchObject({
        status: 'SUBMITTED',
        revision: 2,
      });
      await expect(ownBid(page)).toContainText('۲');

      await page
        .getByRole('form', { name: 'انصراف از پیشنهاد' })
        .getByRole('button', { name: 'انصراف از پیشنهاد' })
        .click();
      await expect(page.getByText('پیشنهاد پس گرفته شد.')).toBeVisible();
      await expect(ownBid(page)).toContainText('پس‌گرفته');
      await expect(page.getByRole('form')).toHaveCount(0);
      expect(await mine(cast.contractor, tender.id)).toMatchObject({
        status: 'WITHDRAWN',
        revision: 2,
      });
    } finally {
      await close();
    }
  });

  test('an invited contractor supplier-service does not hold qualified is refused, in fixed words', async ({
    browser,
  }) => {
    const tender = await publishedTender(cast, 30 * 60_000);
    const { page, close } = await as(browser, cast.unqualified);
    try {
      await page.goto(tenderPage(tender.id));
      await fillContent(page, 'ثبت پیشنهاد', '5000000000', 'روش اجرا');
      await page
        .getByRole('form', { name: 'ثبت پیشنهاد' })
        .getByRole('button', { name: 'ثبت پیشنهاد' })
        .click();
      await expect(page.getByRole('alert').filter({ hasText: NOT_ELIGIBLE })).toBeVisible();
      await expect(page.getByRole('main')).not.toContainText('Bid refused');
      // What was typed is still there, and nothing was recorded.
      await expect(
        page
          .getByRole('form', { name: 'ثبت پیشنهاد' })
          .getByRole('textbox', { name: /مبلغ پیشنهاد/ }),
      ).toHaveValue('5000000000');
      await mine(cast.unqualified, tender.id, 404);
      await expectAccessible(page);
    } finally {
      await close();
    }
  });

  test('a form drawn before the deadline and sent after it is refused, in fixed words', async ({
    browser,
  }) => {
    const tender = await publishedTender(cast, 45_000);
    const { page, close } = await as(browser, cast.contractor);
    try {
      await page.goto(tenderPage(tender.id));
      await fillContent(page, 'ثبت پیشنهاد', '4300000000', 'روش اجرا');
      // The deadline is waited for on the clock, never with a fixed sleep.
      await expect
        .poll(() => Date.now() > tender.closesAt + 1000, { timeout: 90_000, intervals: [1000] })
        .toBe(true);
      await page
        .getByRole('form', { name: 'ثبت پیشنهاد' })
        .getByRole('button', { name: 'ثبت پیشنهاد' })
        .click();
      await expect(page.getByRole('alert').filter({ hasText: WINDOW_CLOSED })).toBeVisible();
      await mine(cast.contractor, tender.id, 404);

      // Drawn again after the deadline, no form is offered at all.
      await page.goto(tenderPage(tender.id));
      await expect(page.getByRole('heading', { name: 'جزئیات مناقصه' })).toBeVisible();
      await expect(page.getByRole('form')).toHaveCount(0);
      await expectAccessible(page);
    } finally {
      await close();
    }
  });

  test('another tenant’s contractor sees the restricted tender as an id that does not exist', async ({
    browser,
  }) => {
    const tender = await publishedTender(cast, 30 * 60_000);
    const { page, close } = await as(browser, cast.stranger);
    try {
      await page.goto(tenderPage(tender.id));
      await expect(page.getByText('این مناقصه پیدا نشد')).toBeVisible();
      await expect(ownBid(page)).toHaveCount(0);
      await expect(page.getByRole('form')).toHaveCount(0);
      const theirs = (await page.locator('main').innerText()).trim();
      await page.goto(tenderPage(`TND_E2E_MISSING_${RUN}`));
      await expect(page.getByText('این مناقصه پیدا نشد')).toBeVisible();
      expect((await page.locator('main').innerText()).trim()).toBe(theirs);
      await expectAccessible(page);

      // And through the gateway, as the same person: its own bid there is the
      // same 404 as on a missing id, and a bid on it the same refusal — the
      // stranger is not qualified, which construction-service says before it
      // looks for the tender at all, for the tender and a missing id alike.
      const token = await provisionedAccessToken(cast.stranger);
      const missing = `TND_E2E_MISSING_${RUN}`;
      await gateway(token, 'GET', `/v1/tenders/${tender.id}/bids/mine`, 404);
      await gateway(token, 'GET', `/v1/tenders/${missing}/bids/mine`, 404);
      const bid = { content: { priceMinor: '1', answers: [] } };
      const refusal = (body: unknown) => {
        const { code, details } = body as { code: unknown; details?: { code?: unknown }[] };
        return { code, reasons: (details ?? []).map((detail) => detail.code) };
      };
      const onTender = refusal(
        await gateway(token, 'POST', `/v1/tenders/${tender.id}/bids`, 422, bid),
      );
      expect(onTender).toEqual({
        code: 'BUSINESS_RULE_VIOLATION',
        reasons: ['BIDDER_NOT_ELIGIBLE'],
      });
      expect(
        refusal(await gateway(token, 'POST', `/v1/tenders/${missing}/bids`, 422, bid)),
      ).toEqual(onTender);
    } finally {
      await close();
    }
  });
});
