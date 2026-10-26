import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { test, type Browser, type Page } from '@playwright/test';
import { expect } from './expect';

import {
  installLiveSession,
  installProvisionedSession,
  liveAccessToken,
  type LivePersona,
  type ProvisionedPerson,
} from './live-session';
import { provisionPerson } from './provisioned-people';

/**
 * A contract's statements through the real stack: the portal, the real
 * gateway, a real contract-service on a real PostgreSQL, real tokens.
 *
 * ## The data
 *
 * The contract is the "Portal in a browser" job's fixture
 * (`e2e/fixtures/contract-statements.sql`, which says why it is rows and not
 * routes): `CTR_E2E_STATEMENTS`, SIGNED, ORG-DEH-0001 employing
 * ORG-E2E-CONTRACTOR, with a technical chain whose one step is ORG-DEH-0001's
 * ORGANIZATION_ADMIN and a financial chain whose one step is its
 * FLEET_MANAGER. Everything else is made here, **in the browser**: the
 * statement is drafted, submitted and decided through the portal's own forms.
 *
 * ## Who does what
 *
 * - **the contractor** — provisioned into ORG-E2E-CONTRACTOR with CONTRACTOR:
 *   drafts and submits; is offered no decision.
 * - **the employer's administrator** — `dehyari.admin` (ORGANIZATION_ADMIN and
 *   FLEET_MANAGER): approves the technical step, and is then offered the
 *   financial step too (it holds the role) — which contract-service refuses,
 *   separation of duties: one person decides one step of a statement. The page
 *   says so in its own fixed words.
 * - **a second person of the employer** — provisioned with FLEET_MANAGER only:
 *   not a contract reader, so the contract itself is refused; reads the
 *   statement as the step's authority and approves the financial step.
 * - **a third organization** — `dehyari.admin.b`: the contract and the
 *   statement are the same absence as an id that does not exist.
 *
 * Settlement is not reached: an approved statement moves no money
 * (ADR-068 § 6), and the economic side is out of this slice.
 */

const CONTRACT = 'CTR_E2E_STATEMENTS';
const CONTRACTOR_ORGANIZATION = 'ORG-E2E-CONTRACTOR';
const EMPLOYER = 'ORG-DEH-0001';
const MISSING_CONTRACT = 'CTR_E2E_STATEMENTS_MISSING';
const MISSING_STATEMENT = 'STM_01JZZZZZZZZZZZZZZZZZZZZZZZ';
const RUN = randomUUID().slice(0, 8);
const LINE = `روکش آسفالت خیابان اصلی — آزمون ${RUN}`;
const GROSS_SHOWN = '۱٬۵۰۰٬۰۰۰ ریال';

const WCAG_2_1_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** The separation-of-duties refusal, as `lib/statement-fields.ts` words it. */
const ALREADY_DECIDED =
  'تفکیک وظایف: هر شخص از یک صورت‌وضعیت، در هر دو زنجیره، فقط یک مرحله را بررسی می‌کند و شما پیش‌تر مرحله‌ای از آن را بررسی کرده‌اید؛ چیزی ثبت نشد.';

async function mainText(page: Page): Promise<string> {
  return (await page.locator('main').innerText()).trim();
}

async function expectAccessible(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_2_1_AA).analyze();
  expect(violations).toEqual([]);
}

/** A fresh browser context signed in as one person, for one step of the story. */
async function as(
  browser: Browser,
  who: LivePersona | ProvisionedPerson,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  if (typeof who === 'string') await installLiveSession(context, who);
  else await installProvisionedSession(context, who);
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

// Under CI the job sets the flag; a skip there would be a green job with no evidence.
if (process.env.CI && process.env.WEB_LIVE_STACK_E2E_CONTRACTS !== 'true') {
  test('CI runs the live statement scenarios, none skipped', () => {
    throw new Error(
      'WEB_LIVE_STACK_E2E_CONTRACTS must be \'true\' in CI: the "Portal in a browser" job starts ' +
        'contract-service and loads its fixture for these scenarios.',
    );
  });
}

test.describe.serial('a contract’s statements, live (EXP-004)', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E_CONTRACTS !== 'true',
    'needs contract-service with e2e/fixtures/contract-statements.sql loaded, alongside the usual ' +
      'live stack — set WEB_LIVE_STACK_E2E_CONTRACTS=true locally after starting it (the ' +
      '"Portal in a browser" CI job always does)',
  );
  test.setTimeout(120_000);

  let contractor: ProvisionedPerson;
  let finance: ProvisionedPerson;
  let statementPath = '';

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const systemAdmin = await liveAccessToken('systemAdmin');
    contractor = await provisionPerson(
      systemAdmin,
      `e2e.statements.${RUN}.contractor`,
      CONTRACTOR_ORGANIZATION,
      ['CONTRACTOR'],
    );
    finance = await provisionPerson(systemAdmin, `e2e.statements.${RUN}.finance`, EMPLOYER, [
      'FLEET_MANAGER',
    ]);
  });

  test('a third organization sees the contract as it sees an id that does not exist', async ({
    browser,
  }) => {
    const { page, close } = await as(browser, 'orgAdminB');
    try {
      await page.goto(`/contracts/${CONTRACT}`);
      await expect(page.getByText('این قرارداد پیدا نشد')).toBeVisible();
      await expect(page.getByRole('region', { name: 'صورت‌وضعیت‌ها' })).toHaveCount(0);
      const theirs = await mainText(page);
      await page.goto(`/contracts/${MISSING_CONTRACT}`);
      await expect(page.getByText('این قرارداد پیدا نشد')).toBeVisible();
      expect(await mainText(page)).toBe(theirs);
    } finally {
      await close();
    }
  });

  test('the contractor drafts a statement on the signed contract, and submits it', async ({
    browser,
  }) => {
    const { page, close } = await as(browser, contractor);
    try {
      await page.goto(`/contracts/${CONTRACT}`);
      const draft = page.getByRole('form', { name: 'ثبت پیش‌نویس صورت‌وضعیت' });
      await expect(draft).toBeVisible();
      await expectAccessible(page);

      await draft.getByLabel('شرح کار — ردیف ۱').fill(LINE);
      await draft.getByLabel('مبلغ (ریال) — ردیف ۱').fill('۱٬۵۰۰٬۰۰۰');
      await draft.getByRole('button', { name: 'ثبت پیش‌نویس صورت‌وضعیت' }).click();

      await expect(page).toHaveURL(
        new RegExp(`/contracts/${CONTRACT}/statements/STM_[^?]+\\?flash=`),
      );
      await expect(page.getByText('پیش‌نویس صورت‌وضعیت ثبت شد.')).toBeVisible();
      statementPath = new URL(page.url()).pathname;
      await expect(page.getByText(LINE)).toBeVisible();
      await expect(page.getByText(GROSS_SHOWN).first()).toBeVisible();
      await expect(page.getByText('پیش‌نویس', { exact: true })).toBeVisible();
      await expectAccessible(page);

      await page.getByRole('button', { name: 'ارسال صورت‌وضعیت برای تأیید' }).click();
      await expect(
        page.getByText('صورت‌وضعیت برای تأیید ارسال شد و زنجیره‌های تأیید آن ثبت شد.'),
      ).toBeVisible();
      await expect(page.getByText('ارسال‌شده، در انتظار تأیید فنی')).toBeVisible();
      await expect(page.getByRole('region', { name: 'زنجیرهٔ تأیید فنی' })).toContainText(
        'ناظر فنی کارفرما',
      );
      await expect(page.getByRole('region', { name: 'زنجیرهٔ تأیید مالی' })).toContainText(
        'مسئول مالی کارفرما',
      );
      // The contractor decides nothing on its own claim.
      await expect(page.getByRole('button', { name: 'تأیید این مرحله' })).toHaveCount(0);
      await expectAccessible(page);
    } finally {
      await close();
    }
  });

  test('the employer approves the technical step, and is refused the financial one in fixed words', async ({
    browser,
  }) => {
    expect(statementPath).not.toBe('');
    const { page, close } = await as(browser, 'orgAdmin');
    try {
      await page.goto(statementPath);
      await page
        .getByRole('form', { name: 'تأیید این مرحله' })
        .getByRole('button', { name: 'تأیید این مرحله' })
        .click();
      await expect(page.getByText('تأیید این مرحله ثبت شد.')).toBeVisible();
      await expect(page.getByText('تأیید فنی شده، در انتظار تأیید مالی')).toBeVisible();
      await expect(page.getByRole('region', { name: 'زنجیرهٔ تأیید فنی' })).toContainText(
        'تأیید شد',
      );

      // The same person holds the financial step's role, so the form is drawn; the
      // service refuses it (separation of duties), and the page says why — never the
      // service's own English.
      await page
        .getByRole('form', { name: 'تأیید این مرحله' })
        .getByRole('button', { name: 'تأیید این مرحله' })
        .click();
      await expect(page.getByText(ALREADY_DECIDED)).toBeVisible();
      expect(await mainText(page)).not.toMatch(/Separation|ALREADY_DECIDED/);
      await expectAccessible(page);

      await page.reload();
      await expect(page.getByText('تأیید فنی شده، در انتظار تأیید مالی')).toBeVisible();
      await expect(page.getByRole('region', { name: 'زنجیرهٔ تأیید مالی' })).toContainText(
        'در انتظار تصمیم',
      );
    } finally {
      await close();
    }
  });

  test('a second person of the employer, the financial step’s authority, approves it without reading the contract', async ({
    browser,
  }) => {
    expect(statementPath).not.toBe('');
    const { page, close } = await as(browser, finance);
    try {
      await page.goto(`/contracts/${CONTRACT}`);
      await expect(page.getByText('این قرارداد در اختیار شما نیست.')).toBeVisible();

      await page.goto(statementPath);
      await expect(page.getByText(LINE)).toBeVisible();
      await page
        .getByRole('form', { name: 'تأیید این مرحله' })
        .getByRole('button', { name: 'تأیید این مرحله' })
        .click();
      await expect(page.getByText('تأیید این مرحله ثبت شد.')).toBeVisible();
      await expect(page.getByText('تأییدشده', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'تأیید این مرحله' })).toHaveCount(0);
      await expectAccessible(page);
    } finally {
      await close();
    }
  });

  test('both parties see the approved statement in the contract’s list', async ({ browser }) => {
    expect(statementPath).not.toBe('');
    const { page, close } = await as(browser, 'orgAdmin');
    try {
      await page.goto(`/contracts/${CONTRACT}`);
      const list = page.getByRole('region', { name: 'صورت‌وضعیت‌ها' });
      const row = list.getByRole('listitem').filter({
        has: page.locator(`a[href="${statementPath}"]`),
      });
      await expect(row).toContainText('تأییدشده');
      await expect(row).toContainText(GROSS_SHOWN);
      // The employer drafts nothing.
      await expect(page.getByRole('form', { name: 'ثبت پیش‌نویس صورت‌وضعیت' })).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('a third organization sees the statement as it sees one that does not exist', async ({
    browser,
  }) => {
    expect(statementPath).not.toBe('');
    const { page, close } = await as(browser, 'orgAdminB');
    try {
      await page.goto(statementPath);
      await expect(page.getByText('این صورت‌وضعیت پیدا نشد')).toBeVisible();
      const theirs = await mainText(page);
      expect(theirs).not.toContain(LINE);
      await page.goto(`/contracts/${CONTRACT}/statements/${MISSING_STATEMENT}`);
      await expect(page.getByText('این صورت‌وضعیت پیدا نشد')).toBeVisible();
      expect(await mainText(page)).toBe(theirs);
    } finally {
      await close();
    }
  });
});
