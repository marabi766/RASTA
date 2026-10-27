import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { test, type Browser, type Page, type Route } from './expect';
import { expect } from './expect';

import {
  installLiveSession,
  installProvisionedSession,
  type ProvisionedPerson,
} from './live-session';
import { provisionedAccessToken } from './provisioned-people';
import {
  awardApprovedTender,
  awardedTender,
  awardRequestedTender,
  castForRun,
  evaluatedTender,
  freshCast,
  gateway,
  openedTender,
  TENDER_CRITERIA,
  type TenderCast,
} from './tender-cast';

/**
 * The evaluation and the award of a tender through the real stack: the portal,
 * the real gateway, construction-service with a tender key, audit-service
 * holding the bids' receipts, supplier-service answering for each contractor's
 * standing, organization-service and identity-service, real tokens.
 *
 * ## The data
 *
 * Nothing seeded: `tender-cast.ts` makes the owner, its publication and award
 * policies, its project and the people once per run (`{ evaluation: true }`),
 * and **every test makes the tender it needs** through the cast's helpers —
 * `openedTender` (published, bid on by two qualified contractors, closed by the
 * service at its deadline, opened by two people), and from it, through the
 * gateway, `evaluatedTender`, `awardRequestedTender`, `awardApprovedTender` and
 * `awardedTender`. No test depends on another having run, or on what one left
 * behind (AGENTS.md § 5; PR 346 review 2, finding 4), so the tests run in
 * parallel; each has at most one accessibility scan (review 1, finding 5).
 * What a test is about — the evaluator's, the author's, the reviewer's or a
 * contractor's part — is done **in the browser**, through the portal's own
 * forms.
 *
 * ## Who does what
 *
 * - **the evaluator** — an `ORGANIZATION_ADMIN` who takes no other part:
 *   qualifies the contractor, disqualifies the rival, scores, completes.
 * - **the author** — awards: took no part in the evaluation
 *   (`AWARDER_NOT_EVALUATOR`, on by default), asks for the award's approval,
 *   and executes it once approved.
 * - **the reviewer** — the authority the award policy names: the
 *   `ORGANIZATION_ADMIN` of **another organization**, who cannot read the
 *   owner's tender (a `404`, as to anyone outside it) and decides its step from
 *   the approval inbox (PR 346 review 1, finding 3).
 * - **the contractor and the rival** — each reads its own bid on the bidder's
 *   door, and nothing of the other's or of the scores.
 * - **another tenant's administrator** — `dehyari.admin.b`, ORG-DEH-0002: the
 *   evaluation and the award are the same absence as an id that does not exist.
 */

const RUN = randomUUID().replace(/-/g, '').slice(0, 8);
const WCAG_2_1_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const PRICE = { contractor: '4200000000', rival: '3900000000' } as const;
const [TECHNICAL, COMPLIANCE] = TENDER_CRITERIA;

/** `lib/tender-owner-fields.ts`'s and `lib/tender-evaluation-fields.ts`'s fixed words. */
const UNCONFIRMED = 'نتوانستیم تأیید کنیم که';
const SET_ASIDE = 'وضعیت مناقصه را دیدم؛ این درخواست را کنار بگذار';
const RESTORED = 'این درخواست پیش از تازه‌شدن صفحه فرستاده شد';
const AWARDER_IS_EVALUATOR = 'شما در ارزیابی این مناقصه نقش داشته‌اید';

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

const ownPage = (id: string) => `/tenders/${encodeURIComponent(id)}?view=own`;
const openPage = (id: string) => `/tenders/${encodeURIComponent(id)}?view=open`;
const form = (page: Page, name: string | RegExp) => page.getByRole('form', { name });
/** A bid's form is named by its command and its bidder. */
const bidForm = (page: Page, label: string, bidder: string) =>
  form(page, new RegExp(`^${label} — ${bidder}$`));

async function held(cast: TenderCast, id: string) {
  return gateway(cast.author, 'GET', `/v1/tenders/${id}`, 200) as Promise<{
    status: string;
    version: number;
  }>;
}

/**
 * An executed award whose answer may be lost — audit-service still catching
 * up, a slow supplier-service: an award is never sent again (the service keeps
 * no result under its key), so the person looks, sets it aside, and executes
 * anew from a fresh form.
 */
async function executeAward(page: Page, cast: TenderCast, id: string): Promise<void> {
  const EXECUTE = /^اجرای واگذاری \(موافقت گرفته شده\)/;
  await page.goto(ownPage(id));
  await form(page, EXECUTE).getByRole('button').click();
  await expect
    .poll(
      async () => {
        if ((await held(cast, id)).status === 'AWARDED') return true;
        if (await page.getByText(UNCONFIRMED).isVisible()) {
          await expect(
            page.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
          ).toHaveCount(0);
          await page.getByRole('link', { name: SET_ASIDE }).click();
          await page.waitForLoadState();
          if ((await held(cast, id)).status === 'AWARDED') return true;
          await form(page, EXECUTE).getByRole('button').click();
        }
        return false;
      },
      { timeout: 90_000, intervals: [3000] },
    )
    .toBe(true);
}

/**
 * Another tenant's administrator and a bidding contractor, through the gateway:
 * every evaluation and award read and command on the owner's tender is the 404
 * of an id that does not exist — ownership is judged first, whatever the
 * tender's state — and in the browser the owner's page is the same absence.
 */
async function strangersFindNothing(
  browser: Browser,
  cast: TenderCast,
  id: string,
  { scan = false }: { readonly scan?: boolean } = {},
): Promise<void> {
  const missing = `TND_E2E_MISSING_${RUN}`;
  const context = await browser.newContext();
  try {
    const admin = (await installLiveSession(context, 'orgAdminB')).accessToken;
    const page = await context.newPage();
    await page.goto(ownPage(id));
    await expect(page.getByText('این مناقصه پیدا نشد')).toBeVisible();
    await expect(page.getByRole('form')).toHaveCount(0);
    if (scan) await expectAccessible(page);
    const theirs = (await page.locator('main').innerText()).trim();
    await page.goto(ownPage(missing));
    expect((await page.locator('main').innerText()).trim()).toBe(theirs);

    const contractor = await provisionedAccessToken(cast.contractor);
    for (const target of [id, missing]) {
      const t = `/v1/tenders/${target}`;
      await gateway(admin, 'GET', `${t}/approvals?workflowKey=tender.award&limit=1`, 404);
      for (const who of [admin, contractor]) {
        await gateway(who, 'GET', `${t}/evaluation`, 404);
        await gateway(who, 'GET', `${t}/award`, 404);
        await gateway(who, 'POST', `${t}/bids/BID_ANY/qualification`, 404, {
          decision: 'QUALIFIED',
        });
        await gateway(who, 'POST', `${t}/evaluate`, 404, {});
        await gateway(who, 'POST', `${t}/award`, 404, { bidId: 'BID_ANY' });
      }
    }
  } finally {
    await context.close();
  }
}

// Under CI the job sets the flag; a skip there would be a green job with no evidence.
if (process.env.CI && process.env.WEB_LIVE_STACK_E2E_TENDERS !== 'true') {
  test('CI runs the live evaluation scenarios, none skipped', () => {
    throw new Error(
      'WEB_LIVE_STACK_E2E_TENDERS must be \'true\' in CI: the "Portal in a browser" job starts ' +
        'construction-service with a tender key, supplier-service and audit-service for these scenarios.',
    );
  });
}

test.describe('the evaluation and the award of a tender, live (EXP-004)', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E_TENDERS !== 'true',
    'needs construction-service with CONSTRUCTION_TENDER_KEKS, supplier-service and audit-service, ' +
      'alongside the usual live stack — set WEB_LIVE_STACK_E2E_TENDERS=true locally after starting ' +
      'them (the "Portal in a browser" CI job always does)',
  );
  // Independent tests, each with a tender of its own: they may run at once.
  test.describe.configure({ mode: 'parallel' });
  test.setTimeout(360_000);

  let made: TenderCast;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    // Per hook run: each worker, and a retry in a new one, makes a cast of its own.
    made = await castForRun(`${RUN}e${randomUUID().slice(0, 4)}`, { evaluation: true });
  });

  test('another tenant’s administrator and a contractor find nothing of the evaluation or the award', async ({
    browser,
  }) => {
    const cast = await freshCast(made);
    const tender = await openedTender(cast, PRICE);
    await strangersFindNothing(browser, cast, tender.id, { scan: true });
    expect((await held(cast, tender.id)).status).toBe('EVALUATING');
  });

  test('the evaluator qualifies, disqualifies, scores and completes — and is not the one to award', async ({
    browser,
  }) => {
    const cast = await freshCast(made);
    const tender = await openedTender(cast, PRICE);
    const rival = cast.rival!;
    const { page, close } = await as(browser, cast.evaluatorPerson!);
    try {
      await page.goto(ownPage(tender.id));
      const evaluation = page.getByRole('region', { name: 'ارزیابی پیشنهادها' });
      await expect(evaluation).toContainText(cast.contractor.organizationId);
      await expect(evaluation).toContainText(rival.organizationId);
      // Nothing to complete while a bid is undecided, and nothing to award yet.
      await expect(form(page, 'تکمیل ارزیابی')).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'واگذاری' })).toHaveCount(0);

      const QUALIFY = 'اعلام واجد شرایط بودن';
      await bidForm(page, QUALIFY, cast.contractor.organizationId)
        .getByRole('button', { name: QUALIFY })
        .click();
      await expect(page.getByText('پیشنهاد واجد شرایط شناخته شد.')).toBeVisible();

      const DISQUALIFY = 'اعلام فاقد شرایط بودن';
      const disqualify = bidForm(page, DISQUALIFY, rival.organizationId);
      await disqualify.getByLabel(/^دلیل/).selectOption('NON_RESPONSIVE');
      await disqualify.getByLabel(/شرح دلیل/).fill('مدارک فنی پیوست نشده بود (آزمون)');
      await disqualify.getByRole('button', { name: DISQUALIFY }).click();
      await expect(page.getByText('پیشنهاد فاقد شرایط اعلام شد.')).toBeVisible();

      // Points in Persian digits with the Persian decimal mark; a pass for the pass/fail.
      const SCORE = 'ثبت امتیاز';
      const scoring = bidForm(page, SCORE, cast.contractor.organizationId);
      await scoring.getByLabel(TECHNICAL.label).fill('۸٫۵');
      await scoring.getByLabel(COMPLIANCE.label).selectOption(String(COMPLIANCE.maxScore));
      await scoring.getByRole('button', { name: SCORE }).click();
      await expect(page.getByText('امتیازهای شما ثبت شد.')).toBeVisible();
      // 7000 × 850 + 3000 × 100 = 6 250 000: 6.25 weighted points, rank 1.
      await expect(evaluation).toContainText('امتیاز وزنی ۶٫۲۵');
      await expectAccessible(page);

      await form(page, 'تکمیل ارزیابی').getByRole('button', { name: 'تکمیل ارزیابی' }).click();
      await expect(page.getByText('ارزیابی کامل شد و ماتریس امتیازها منجمد شد.')).toBeVisible();
      expect((await held(cast, tender.id)).status).toBe('EVALUATED');
      // The evaluator does not award (AWARDER_NOT_EVALUATOR).
      await expect(page.getByRole('region', { name: 'واگذاری' })).toContainText(
        AWARDER_IS_EVALUATOR,
      );
      await expect(form(page, /^درخواست واگذاری/)).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('the author asks for the award of the qualified bid; deciding it is the reviewer’s', async ({
    browser,
  }) => {
    const cast = await freshCast(made);
    const tender = await evaluatedTender(cast, PRICE);
    const AWARD = 'درخواست واگذاری';
    const { page, close } = await as(browser, cast.authorPerson);
    try {
      await page.goto(ownPage(tender.id));
      await expect(bidForm(page, AWARD, cast.rival!.organizationId)).toHaveCount(0);
      await bidForm(page, AWARD, cast.contractor.organizationId)
        .getByRole('button', { name: AWARD })
        .click();
      await expect(
        page.getByText('درخواست موافقت با واگذاری ثبت شد و در انتظار مرجع است.'),
      ).toBeVisible();
      // The step names the reviewer's organization: neither the grant nor the rejection is the
      // author's, and the page says the request is theirs, waiting on its authority.
      await expect(page.getByRole('region', { name: 'واگذاری' })).toContainText(
        'درخواست واگذاری را شما داده‌اید',
      );
      await expect(form(page, 'موافقت با واگذاری')).toHaveCount(0);
      await expect(form(page, 'رد درخواست واگذاری')).toHaveCount(0);
      await expectAccessible(page);
      expect((await held(cast, tender.id)).status).toBe('EVALUATED');
    } finally {
      await close();
    }
  });

  test('the reviewer of another organization, who cannot read the tender, grants from its inbox', async ({
    browser,
  }) => {
    const cast = await freshCast(made);
    const tender = await awardRequestedTender(cast, PRICE);
    const reviewer = cast.reviewerPerson!;
    // The tender stays the owner's own: to the reviewer, the absence of an id that does not exist.
    await gateway(await provisionedAccessToken(reviewer), 'GET', `/v1/tenders/${tender.id}`, 404);
    const { page, close } = await as(browser, reviewer);
    try {
      await page.goto(ownPage(tender.id));
      const step = page.getByRole('region', { name: 'موافقت با واگذاری مناقصه' });
      await expect(step).toContainText(cast.contractor.organizationId);
      await expect(step).toContainText('بی‌دلیل (تنها رتبهٔ نخست)');
      await expect(page.getByText('این مناقصه پیدا نشد')).toHaveCount(0);
      await expectAccessible(page);
      await form(page, 'موافقت با واگذاری')
        .getByRole('button', { name: 'موافقت با واگذاری' })
        .click();
      await expect(page.getByText('موافقت شما با واگذاری ثبت شد.')).toBeVisible();
      await expect(page.getByRole('form')).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('the reviewer’s grant of its last step, its answer lost: the reload keeps the record beside the absence, and it is set aside (PR 346 review 4)', async ({
    browser,
  }) => {
    const cast = await freshCast(made);
    const tender = await awardRequestedTender(cast, PRICE);
    const awardRequest = async () =>
      (
        (await gateway(
          cast.author,
          'GET',
          `/v1/tenders/${tender.id}/approvals?workflowKey=tender.award&limit=1`,
          200,
        )) as { items: { status: string }[] }
      ).items[0]?.status;
    const { page, close } = await as(browser, cast.reviewerPerson!);
    try {
      await page.goto(ownPage(tender.id));
      // The decision reaches the service and is kept; its answer never reaches the browser.
      const lose = async (route: Route) => {
        if (route.request().method() === 'POST' && route.request().headers()['next-action']) {
          await route.fetch();
          await route.abort('connectionreset');
        } else {
          await route.continue();
        }
      };
      await page.route('**/tenders/**', lose);
      await form(page, 'موافقت با واگذاری')
        .getByRole('button', { name: 'موافقت با واگذاری' })
        .click();
      await expect(page.getByText(UNCONFIRMED)).toBeVisible();
      await page.unroute('**/tenders/**', lose);
      await expect.poll(awardRequest, { timeout: 30_000 }).toBe('APPROVED');

      // The inbox holds no pending step now: the page is the absence, the record beside it.
      await page.reload();
      await expect(page.getByText('این مناقصه پیدا نشد')).toBeVisible();
      await expect(page.getByText(RESTORED)).toBeVisible();
      await expect(page.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toHaveCount(0);
      await expectAccessible(page);
      await page.getByRole('link', { name: SET_ASIDE }).click();
      await page.waitForLoadState();
      await expect(page.getByText('این مناقصه پیدا نشد')).toBeVisible();
      await expect(page.getByText(RESTORED)).toHaveCount(0);
      await page.reload();
      await expect(page.getByText(RESTORED)).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('the author executes the approved award; a stranger still finds nothing', async ({
    browser,
  }) => {
    const cast = await freshCast(made);
    const tender = await awardApprovedTender(cast, PRICE);
    const { page, close } = await as(browser, cast.authorPerson);
    try {
      await executeAward(page, cast, tender.id);
      await page.goto(ownPage(tender.id));
      const record = page.getByRole('region', { name: 'واگذاری' });
      await expect(record).toContainText('۴٬۲۰۰٬۰۰۰٬۰۰۰');
      await expect(record).toContainText('اجراشده');
      await expect(page.getByRole('form')).toHaveCount(0);
      await expectAccessible(page);
    } finally {
      await close();
    }
    // Awarded: the stranger still finds nothing, the award included.
    await strangersFindNothing(browser, cast, tender.id);
  });

  test('each contractor, on the bidder’s door, sees its own bid and nothing of the other’s', async ({
    browser,
  }) => {
    const cast = await freshCast(made);
    const tender = await awardedTender(cast, PRICE);
    const winner = await as(browser, cast.contractor);
    const loser = await as(browser, cast.rival!);
    try {
      await winner.page.goto(openPage(tender.id));
      const own = winner.page.getByRole('region', { name: 'پیشنهاد سازمان شما' });
      await expect(own).toContainText('برنده');
      await loser.page.goto(openPage(tender.id));
      const theirs = loser.page.getByRole('region', { name: 'پیشنهاد سازمان شما' });
      await expect(theirs).toContainText('فاقد شرایط');
      const main = await loser.page.locator('main').innerText();
      for (const leak of [
        cast.contractor.organizationId,
        '۴٬۲۰۰٬۰۰۰٬۰۰۰',
        '۶٫۲۵',
        'مدارک فنی پیوست نشده بود',
      ]) {
        expect(main).not.toContain(leak);
      }
      await expectAccessible(loser.page);
    } finally {
      await winner.close();
      await loser.close();
    }
  });
});
