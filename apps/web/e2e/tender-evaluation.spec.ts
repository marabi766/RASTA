import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

import {
  installLiveSession,
  installProvisionedSession,
  type ProvisionedPerson,
} from './live-session';
import { provisionedAccessToken } from './provisioned-people';
import { castForRun, gateway, openedTender, TENDER_CRITERIA, type TenderCast } from './tender-cast';

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
 * and **every test opens a tender of its own** — published, bid on by two
 * qualified contractors, closed by the service at its deadline and opened by
 * two people through the gateway (`openedTender`). What the evaluator, the
 * awarder and the approver do is done **in the browser**, through the
 * portal's own forms.
 *
 * ## Who does what
 *
 * - **the evaluator** — an `ORGANIZATION_ADMIN` who takes no other part:
 *   qualifies the contractor, disqualifies the rival, scores, completes.
 * - **the author** — awards: took no part in the evaluation
 *   (`AWARDER_NOT_EVALUATOR`, on by default), and asks for the award's approval.
 * - **the approver** — the authority the award policy names; never the person
 *   who asked, never an evaluator.
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
async function strangersFindNothing(browser: Browser, cast: TenderCast, id: string): Promise<void> {
  const missing = `TND_E2E_MISSING_${RUN}`;
  const context = await browser.newContext();
  try {
    const admin = (await installLiveSession(context, 'orgAdminB')).accessToken;
    const page = await context.newPage();
    await page.goto(ownPage(id));
    await expect(page.getByText('این مناقصه پیدا نشد')).toBeVisible();
    await expect(page.getByRole('form')).toHaveCount(0);
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
  test.describe.configure({ mode: 'default' });
  test.setTimeout(420_000);

  let cast: TenderCast;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    // Per hook run: a retry in a new worker makes a cast of its own.
    cast = await castForRun(`${RUN}e${randomUUID().slice(0, 4)}`, { evaluation: true });
  });

  test('evaluated by one person, awarded by another, approved by a third; each contractor sees only its own; a stranger nothing', async ({
    browser,
  }) => {
    const tender = await openedTender(cast, PRICE);
    const rival = cast.rival!;
    await strangersFindNothing(browser, cast, tender.id);
    expect((await held(cast, tender.id)).status).toBe('EVALUATING');
    const evaluator = await as(browser, cast.evaluatorPerson!);
    const author = await as(browser, cast.authorPerson);
    const approver = await as(browser, cast.approverPerson);
    try {
      // -- the evaluation, in the evaluator's browser ------------------------------------
      const { page } = evaluator;
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

      // -- the award, asked by the author --------------------------------------------------
      const AWARD = 'درخواست واگذاری';
      await author.page.goto(ownPage(tender.id));
      await expect(bidForm(author.page, AWARD, rival.organizationId)).toHaveCount(0);
      await bidForm(author.page, AWARD, cast.contractor.organizationId)
        .getByRole('button', { name: AWARD })
        .click();
      await expect(
        author.page.getByText('درخواست موافقت با واگذاری ثبت شد و در انتظار مرجع است.'),
      ).toBeVisible();
      // Its own request: the rejection is the author's to make, the grant never.
      await expect(form(author.page, 'موافقت با واگذاری')).toHaveCount(0);
      await expect(form(author.page, 'رد درخواست واگذاری')).toBeVisible();
      expect((await held(cast, tender.id)).status).toBe('EVALUATED');

      // -- approved by the approver, who sees the bid the step names -----------------------
      await approver.page.goto(ownPage(tender.id));
      const award = approver.page.getByRole('region', { name: 'واگذاری' });
      await expect(award).toContainText(cast.contractor.organizationId);
      await expect(award).toContainText('بی‌دلیل (تنها رتبهٔ نخست)');
      await form(approver.page, 'موافقت با واگذاری')
        .getByRole('button', { name: 'موافقت با واگذاری' })
        .click();
      await expect(approver.page.getByText('موافقت شما با واگذاری ثبت شد.')).toBeVisible();

      // -- executed by the author ----------------------------------------------------------
      await executeAward(author.page, cast, tender.id);
      await author.page.goto(ownPage(tender.id));
      const record = author.page.getByRole('region', { name: 'واگذاری' });
      await expect(record).toContainText('۴٬۲۰۰٬۰۰۰٬۰۰۰');
      await expect(record).toContainText('اجراشده');
      await expect(author.page.getByRole('form')).toHaveCount(0);
      await expectAccessible(author.page);
      // Awarded: the stranger still finds nothing, the award included.
      await strangersFindNothing(browser, cast, tender.id);
    } finally {
      await evaluator.close();
      await author.close();
      await approver.close();
    }

    // -- each contractor, on the bidder's door: its own bid, nothing of the other's ---------
    const winner = await as(browser, cast.contractor);
    const loser = await as(browser, rival);
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
