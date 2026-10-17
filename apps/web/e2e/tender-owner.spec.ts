import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

import {
  installLiveSession,
  installProvisionedSession,
  type ProvisionedPerson,
} from './live-session';
import {
  castForRun,
  contractorBid,
  draftTender,
  gateway,
  publishedTender,
  type TenderCast,
} from './tender-cast';

/**
 * The owner's side of a tender through the real stack: the portal, the real
 * gateway, a real construction-service (with a tender key-encryption key),
 * audit-service holding the bids' receipts the opening is checked against,
 * supplier-service, organization-service and identity-service, real tokens.
 *
 * ## The data
 *
 * Nothing seeded: `tender-cast.ts` makes the owner, its policies, its project
 * and the people once per run through the platform's routes, and **every test
 * drafts its own tender** — so a retry acts on a tender nobody has acted on.
 * What the owner does is done **in the browser**, through the portal's own
 * forms: request publication, decide it, execute it, propose the opening and
 * open the bids. A contractor's bid is put in through the gateway (its own
 * browser path is `tender-bids.spec.ts`), and what the service then holds is
 * read back with the same person's token.
 *
 * ## Who does what
 *
 * - **the author** — the owner's `ORGANIZATION_ADMIN` who asks for publication
 *   and executes it once granted, and proposes the opening.
 * - **the approver** — the owner's other `ORGANIZATION_ADMIN`: the authority
 *   the publication policy names, and the second person of the opening. The
 *   person who asks never decides; the person who proposes never opens.
 * - **another tenant's administrator** — `dehyari.admin.b`, ORG-DEH-0002: the
 *   owner's tender is the same absence as an id that does not exist.
 *
 * Closing has no form: construction-service closes a tender itself at its
 * deadline. Evaluation and award are the next slice.
 */

const RUN = randomUUID().replace(/-/g, '').slice(0, 8);
const WCAG_2_1_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** `lib/tender-owner-fields.ts`'s fixed words, as the page says them. */
const OWN_REQUEST =
  'درخواست انتشار را شما داده‌اید و در انتظار تصمیم مرجع است. تفکیک وظایف: کسی که درخواست داده خودش آن را تأیید نمی‌کند.';
const CRITERIA_REQUIRED = 'معیار ارزیابی‌ای برای مناقصه تعیین نشده است.';
const SECOND_PERSON_REQUIRED =
  'تفکیک وظایف: گشایش را شخصی جز پیشنهاددهنده انجام می‌دهد؛ چیزی گشوده نشد.';
const UNCONFIRMED = 'نتوانستیم تأیید کنیم که';

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
const form = (page: Page, name: string) => page.getByRole('form', { name });

async function send(page: Page, name: string): Promise<void> {
  await form(page, name).getByRole('button', { name }).click();
}

/** What the service holds of the tender, read with the author's token. */
async function held(cast: TenderCast, id: string) {
  return gateway(cast.author, 'GET', `/v1/tenders/${id}`, 200) as Promise<{
    status: string;
    version: number;
  }>;
}

// Under CI the job sets the flag; a skip there would be a green job with no evidence.
if (process.env.CI && process.env.WEB_LIVE_STACK_E2E_TENDERS !== 'true') {
  test('CI runs the live owner scenarios, none skipped', () => {
    throw new Error(
      'WEB_LIVE_STACK_E2E_TENDERS must be \'true\' in CI: the "Portal in a browser" job starts ' +
        'construction-service with a tender key, supplier-service and audit-service for these scenarios.',
    );
  });
}

test.describe('the owner’s side of a tender, live (EXP-004)', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E_TENDERS !== 'true',
    'needs construction-service with CONSTRUCTION_TENDER_KEKS, supplier-service and audit-service, ' +
      'alongside the usual live stack — set WEB_LIVE_STACK_E2E_TENDERS=true locally after starting ' +
      'them (the "Portal in a browser" CI job always does)',
  );
  // One worker runs the file in order; each test still drafts its own tender.
  test.describe.configure({ mode: 'default' });
  test.setTimeout(240_000);

  let cast: TenderCast;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    // Per hook run: a retry in a new worker makes a cast of its own.
    cast = await castForRun(`${RUN}o${randomUUID().slice(0, 4)}`);
  });

  test('publication through its approval: the author asks, the approver grants, the author executes', async ({
    browser,
  }) => {
    const tender = await draftTender(cast, 30 * 60_000);
    const author = await as(browser, cast.authorPerson);
    const approver = await as(browser, cast.approverPerson);
    try {
      const { page } = author;
      await page.goto(ownPage(tender.id));
      await expect(
        page.getByText('هنوز درخواست انتشاری برای این مناقصه ثبت نشده است.'),
      ).toBeVisible();
      await send(page, 'درخواست انتشار');
      await expect(
        page.getByText('درخواست موافقت با انتشار ثبت شد و در انتظار مرجع است.'),
      ).toBeVisible();
      // The person who asked is never offered the decision.
      await expect(page.getByText(OWN_REQUEST)).toBeVisible();
      await expect(form(page, 'موافقت با انتشار')).toHaveCount(0);
      await expect(page.getByRole('form')).toHaveCount(0);
      expect((await held(cast, tender.id)).status).toBe('DRAFT');
      await expectAccessible(page);

      await approver.page.goto(ownPage(tender.id));
      await expect(form(approver.page, 'رد درخواست انتشار')).toBeVisible();
      await send(approver.page, 'موافقت با انتشار');
      await expect(approver.page.getByText('موافقت شما ثبت شد.')).toBeVisible();

      await page.goto(ownPage(tender.id));
      await send(page, 'اجرای انتشار (موافقت گرفته شده)');
      await expect(page.getByText('مناقصه منتشر شد و معیارهای آن منجمد شدند.')).toBeVisible();
      // Executed on the version the request was granted for; publishing moves it on.
      const published = await held(cast, tender.id);
      expect(published.status).toBe('PUBLISHED');
      expect(published.version).toBeGreaterThan(tender.version);
      // Published: the publication's forms are gone; the bids are counted, not shown.
      await expect(form(page, 'درخواست انتشار')).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'پیشنهادهای رسیده' })).toContainText(
        'پیشنهادی نرسیده',
      );
    } finally {
      await author.close();
      await approver.close();
    }
  });

  test('a draft that cannot be published is refused, every reason in fixed words', async ({
    browser,
  }) => {
    const tender = await draftTender(cast, 30 * 60_000, { criteria: false });
    const { page, close } = await as(browser, cast.authorPerson);
    try {
      await page.goto(ownPage(tender.id));
      await send(page, 'درخواست انتشار');
      await expect(form(page, 'درخواست انتشار').getByText(CRITERIA_REQUIRED)).toBeVisible();
      await expect(page.getByRole('main')).not.toContainText('CRITERIA_REQUIRED');
      expect(await held(cast, tender.id)).toMatchObject({
        status: 'DRAFT',
        version: tender.version,
      });
      // Nothing was asked: the approval round never opened.
      expect(
        await gateway(
          cast.author,
          'GET',
          `/v1/tenders/${tender.id}/approvals?workflowKey=tender.publication&limit=1`,
          200,
        ),
      ).toMatchObject({ items: [] });
      await expectAccessible(page);
    } finally {
      await close();
    }
  });

  test('the opening takes two people: proposed by one, refused to the same one, opened by the other', async ({
    browser,
  }) => {
    const tender = await publishedTender(cast, 60_000);
    await contractorBid(cast, tender.id, '4200000000');
    const author = await as(browser, cast.authorPerson);
    const approver = await as(browser, cast.approverPerson);
    try {
      const { page } = author;
      // Before the deadline: how many, never who or what, and no opening form.
      await page.goto(ownPage(tender.id));
      const bids = page.getByRole('region', { name: 'پیشنهادهای رسیده' });
      await expect(bids).toContainText('۱ پیشنهاد رسیده است');
      await expect(bids).not.toContainText('۴٬۲۰۰٬۰۰۰٬۰۰۰');
      await expect(form(page, 'پیشنهاد گشایش پیشنهادها')).toHaveCount(0);

      // construction-service closes it itself at the deadline; nobody closes it by hand.
      await expect
        .poll(async () => (await held(cast, tender.id)).status, {
          timeout: 120_000,
          intervals: [2000],
        })
        .toBe('CLOSED');

      await page.goto(ownPage(tender.id));
      await send(page, 'پیشنهاد گشایش پیشنهادها');
      await expect(
        page.getByText('پیشنهاد گشایش ثبت شد؛ گشایش با تأیید نفر دوم انجام می‌شود.'),
      ).toBeVisible();
      await send(page, 'گشایش پیشنهادها (نفر دوم)');
      await expect(
        form(page, 'گشایش پیشنهادها (نفر دوم)').getByText(SECOND_PERSON_REQUIRED),
      ).toBeVisible();
      expect((await held(cast, tender.id)).status).toBe('CLOSED');
      await expectAccessible(page);

      // The second person. audit-service may still be catching up with the
      // receipt: the page cannot confirm, and the same request is sent again
      // under its key until it can.
      const other = approver.page;
      await other.goto(ownPage(tender.id));
      await send(other, 'گشایش پیشنهادها (نفر دوم)');
      const done = other.getByText('پیشنهادها گشوده شدند و مناقصه در حال ارزیابی است.');
      await expect
        .poll(
          async () => {
            if (await done.isVisible()) return true;
            const retry = other.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' });
            if (await other.getByText(UNCONFIRMED).isVisible()) {
              if (await retry.isEnabled()) await retry.click();
            }
            return false;
          },
          { timeout: 90_000, intervals: [3000] },
        )
        .toBe(true);
      expect((await held(cast, tender.id)).status).toBe('EVALUATING');
      const opened = other.getByRole('region', { name: 'پیشنهادهای رسیده' });
      await expect(opened).toContainText('۴٬۲۰۰٬۰۰۰٬۰۰۰');
      await expect(opened).toContainText(cast.contractor.organizationId);
      await expect(other.getByRole('form')).toHaveCount(0);
      await expectAccessible(other);
    } finally {
      await author.close();
      await approver.close();
    }
  });

  test('another tenant’s administrator sees the owner’s tender as an id that does not exist', async ({
    browser,
  }) => {
    const draft = await draftTender(cast, 30 * 60_000);
    const context = await browser.newContext();
    try {
      const token = (await installLiveSession(context, 'orgAdminB')).accessToken;
      const page = await context.newPage();
      const missing = `TND_E2E_MISSING_${RUN}`;
      await page.goto(ownPage(draft.id));
      await expect(page.getByText('این مناقصه پیدا نشد')).toBeVisible();
      await expect(page.getByRole('form')).toHaveCount(0);
      const theirs = (await page.locator('main').innerText()).trim();
      await page.goto(ownPage(missing));
      await expect(page.getByText('این مناقصه پیدا نشد')).toBeVisible();
      expect((await page.locator('main').innerText()).trim()).toBe(theirs);
      await expectAccessible(page);

      // And through the gateway, as the same person: every owner command and
      // read is the 404 of an id that does not exist, and nothing changed.
      for (const id of [draft.id, missing]) {
        const t = `/v1/tenders/${id}`;
        await gateway(token, 'GET', `${t}/approvals?workflowKey=tender.publication&limit=1`, 404);
        await gateway(token, 'GET', `${t}/bids`, 404);
        await gateway(token, 'POST', `${t}/publish`, 404, { expectedVersion: draft.version });
        await gateway(token, 'POST', `${t}/open-bids/proposal`, 404, {});
        await gateway(token, 'POST', `${t}/open-bids`, 404, {});
      }
      expect(await held(cast, draft.id)).toMatchObject({ status: 'DRAFT', version: draft.version });
    } finally {
      await context.close();
    }
  });
});
