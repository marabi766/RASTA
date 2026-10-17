import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

import {
  installLiveSession,
  installProvisionedSession,
  liveAccessToken,
  type LivePersona,
  type ProvisionedPerson,
} from './live-session';
import { provisionPerson } from './provisioned-people';

/**
 * A contract's own commands through the real stack: the portal, the real
 * gateway, a real contract-service on a real PostgreSQL, real tokens.
 *
 * ## The data
 *
 * Three **drafts nobody has signed** (`e2e/fixtures/contract-commands.sql`,
 * which says why they are rows): CTR_E2E_SIGNING and CTR_E2E_CANCEL, where
 * ORG-DEH-0001 employs ORG-E2E-CONTRACTOR, and CTR_E2E_UNGOVERNED, where
 * ORG-DEH-0002 does. The employer ORG-DEH-0001 signs under the
 * `contract.signature` policy of `contract-statements.sql` (its
 * ORGANIZATION_ADMIN); ORG-DEH-0002 has none in force. Everything else is done
 * here, **in the browser**, through the portal's own forms.
 *
 * ## Who does what
 *
 * - **the contractor** — provisioned into ORG-E2E-CONTRACTOR with CONTRACTOR:
 *   signs the contracts and the amendment for its side; is offered no
 *   cancellation, no proposal and no milestone.
 * - **the employer's administrator** — `dehyari.admin`: signs for the employer
 *   (the policy names its role), cancels, proposes the amendment and signs it,
 *   plans and changes the milestone. Its cancel form, drawn before the
 *   contractor signed, is refused by contract-service once the contractor has —
 *   said in the page's own fixed words.
 * - **another employer** — `dehyari.admin.b` (ORG-DEH-0002): nobody may sign
 *   for its organization (no policy in force), and the page says so; the
 *   other organization's contract is the same absence as an id that does not
 *   exist.
 *
 * The contracts are fixed rows, so the scenario runs once per database (the CI
 * job's is fresh); a second local run finds them already signed.
 */

const SIGNING = 'CTR_E2E_SIGNING';
const CANCELLING = 'CTR_E2E_CANCEL';
const UNGOVERNED = 'CTR_E2E_UNGOVERNED';
const CONTRACTOR_ORGANIZATION = 'ORG-E2E-CONTRACTOR';
const MISSING = 'CTR_E2E_COMMANDS_MISSING';
const RUN = randomUUID().slice(0, 8);
const REASON = `افزایش محدودهٔ کار — آزمون ${RUN}`;
const MILESTONE = `تحویل فاز یک — ${RUN}`;
const MILESTONE_CHANGED = `تحویل فاز یک، بازبینی‌شده — ${RUN}`;

const WCAG_2_1_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** The fixed words of `lib/contract-command-fields.ts` the scenario expects. */
const SIGNATURE_RECORDED =
  'یکی از طرفین این پیش‌نویس را امضا کرده است و دیگر لغو نمی‌شود؛ چیزی ثبت نشد.';
const NO_POLICY = /برای کارفرما سیاست امضای برقراری نیست/;
const SIGNED_FOR_YOUR_SIDE = 'پذیرش قرارداد از سوی طرف شما ثبت شد.';

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
  test('CI runs the live contract command scenarios, none skipped', () => {
    throw new Error(
      'WEB_LIVE_STACK_E2E_CONTRACTS must be \'true\' in CI: the "Portal in a browser" job starts ' +
        'contract-service and loads its fixtures for these scenarios.',
    );
  });
}

test.describe.serial('a contract’s own commands, live (EXP-004)', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E_CONTRACTS !== 'true',
    'needs contract-service with e2e/fixtures/contract-statements.sql and contract-commands.sql ' +
      'loaded, alongside the usual live stack — set WEB_LIVE_STACK_E2E_CONTRACTS=true locally ' +
      'after starting it (the "Portal in a browser" CI job always does)',
  );
  test.setTimeout(120_000);

  let contractor: ProvisionedPerson;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const systemAdmin = await liveAccessToken('systemAdmin');
    contractor = await provisionPerson(
      systemAdmin,
      `e2e.commands.${RUN}.contractor`,
      CONTRACTOR_ORGANIZATION,
      ['CONTRACTOR'],
    );
  });

  test('another employer: its own draft offers no signature and says why; ours is absent', async ({
    browser,
  }) => {
    const { page, close } = await as(browser, 'orgAdminB');
    try {
      await page.goto(`/contracts/${UNGOVERNED}`);
      await expect(page.getByText(NO_POLICY)).toBeVisible();
      await expect(page.getByRole('form', { name: /امضای قرارداد/ })).toHaveCount(0);
      // Cancelling is not a signature: its administrator may still end the draft.
      await expect(page.getByRole('form', { name: 'لغو پیش‌نویس قرارداد' })).toBeVisible();
      await expectAccessible(page);

      await page.goto(`/contracts/${SIGNING}`);
      await expect(page.getByText('این قرارداد پیدا نشد')).toBeVisible();
      const theirs = await mainText(page);
      await page.goto(`/contracts/${MISSING}`);
      expect(await mainText(page)).toBe(theirs);
    } finally {
      await close();
    }
  });

  test('a cancel form drawn before the contractor signed is refused once it has, in fixed words', async ({
    browser,
  }) => {
    const employer = await as(browser, 'orgAdmin');
    const theContractor = await as(browser, contractor);
    try {
      await employer.page.goto(`/contracts/${CANCELLING}`);
      const cancel = employer.page.getByRole('form', { name: 'لغو پیش‌نویس قرارداد' });
      await expect(cancel).toBeVisible();

      await theContractor.page.goto(`/contracts/${CANCELLING}`);
      await expect(
        theContractor.page.getByRole('form', { name: 'لغو پیش‌نویس قرارداد' }),
      ).toHaveCount(0);
      await theContractor.page
        .getByRole('form', { name: 'امضای قرارداد — از سوی پیمانکار' })
        .getByRole('button', { name: 'امضای قرارداد' })
        .click();
      await expect(theContractor.page.getByText(SIGNED_FOR_YOUR_SIDE)).toBeVisible();

      await cancel.getByRole('combobox', { name: 'دلیل' }).selectOption('TERMS_NOT_AGREED');
      await cancel.getByRole('button', { name: 'لغو پیش‌نویس قرارداد' }).click();
      await expect(cancel.getByText(SIGNATURE_RECORDED)).toBeVisible();
      await expectAccessible(employer.page);

      await employer.page.reload();
      await expect(employer.page.getByRole('form', { name: 'لغو پیش‌نویس قرارداد' })).toHaveCount(
        0,
      );
      await expect(employer.page.getByText('پیش‌نویس', { exact: true })).toBeVisible();
    } finally {
      await employer.close();
      await theContractor.close();
    }
  });

  test('both sides accept the draft — the contractor, then the employer — and it is signed', async ({
    browser,
  }) => {
    const theContractor = await as(browser, contractor);
    try {
      await theContractor.page.goto(`/contracts/${SIGNING}`);
      await theContractor.page
        .getByRole('form', { name: 'امضای قرارداد — از سوی پیمانکار' })
        .getByRole('button', { name: 'امضای قرارداد' })
        .click();
      await expect(theContractor.page.getByText(SIGNED_FOR_YOUR_SIDE)).toBeVisible();
      await expect(theContractor.page.getByRole('form', { name: /امضای قرارداد/ })).toHaveCount(0);
    } finally {
      await theContractor.close();
    }

    const { page, close } = await as(browser, 'orgAdmin');
    try {
      await page.goto(`/contracts/${SIGNING}`);
      const sign = page.getByRole('form', { name: 'امضای قرارداد — از سوی کارفرما' });
      await expect(sign).toBeVisible();
      // One side has signed: by default the draft is no longer withdrawn.
      await expect(page.getByRole('form', { name: 'لغو پیش‌نویس قرارداد' })).toHaveCount(0);
      await sign.getByRole('button', { name: 'امضای قرارداد' }).click();
      await expect(page.getByText(SIGNED_FOR_YOUR_SIDE)).toBeVisible();
      await expect(page.getByText('امضاشده', { exact: true })).toBeVisible();
      await expectAccessible(page);
    } finally {
      await close();
    }
  });

  test('the employer proposes an amendment, both sides sign it, and the price moves', async ({
    browser,
  }) => {
    const employer = await as(browser, 'orgAdmin');
    try {
      await employer.page.goto(`/contracts/${SIGNING}`);
      const propose = employer.page.getByRole('form', { name: 'پیشنهاد الحاقیه' });
      await propose.getByLabel(/مبلغ الحاقیه/).fill('۲٬۰۰۰٬۰۰۰');
      await propose.getByRole('combobox', { name: 'دلیل' }).selectOption('SCOPE_CHANGE');
      await propose.getByLabel(/شرح دلیل/).fill(REASON);
      await propose.getByRole('button', { name: 'پیشنهاد الحاقیه' }).click();
      await expect(employer.page.getByText('الحاقیه پیشنهاد شد.')).toBeVisible();
      await expect(employer.page.getByText(REASON)).toBeVisible();

      const signAmendment = employer.page.getByRole('form', {
        name: 'امضای الحاقیه — الحاقیهٔ ۱ — از سوی کارفرما',
      });
      await signAmendment.getByRole('button', { name: 'امضای الحاقیه' }).click();
      await expect(employer.page.getByText('امضای الحاقیه از سوی طرف شما ثبت شد.')).toBeVisible();
    } finally {
      await employer.close();
    }

    const { page, close } = await as(browser, contractor);
    try {
      await page.goto(`/contracts/${SIGNING}`);
      await expect(page.getByRole('form', { name: 'پیشنهاد الحاقیه' })).toHaveCount(0);
      await expect(page.getByRole('form', { name: 'برنامه‌ریزی Milestone' })).toHaveCount(0);
      await page
        .getByRole('form', { name: 'امضای الحاقیه — الحاقیهٔ ۱ — از سوی پیمانکار' })
        .getByRole('button', { name: 'امضای الحاقیه' })
        .click();
      await expect(page.getByText('امضای الحاقیه از سوی طرف شما ثبت شد.')).toBeVisible();
      await expect(page.getByText('اجراشده', { exact: true })).toBeVisible();
      await expect(page.getByText('۵۰۲٬۰۰۰٬۰۰۰ ریال')).toBeVisible();
      await expectAccessible(page);
    } finally {
      await close();
    }
  });

  test('the employer plans a milestone and changes it', async ({ browser }) => {
    const { page, close } = await as(browser, 'orgAdmin');
    try {
      await page.goto(`/contracts/${SIGNING}`);
      const plan = page.getByRole('form', { name: 'برنامه‌ریزی Milestone' });
      await plan.getByLabel(/^عنوان/).fill(MILESTONE);
      await plan.getByLabel(/روز برنامه‌ریزی‌شده/).fill('2026-12-20');
      await plan.getByLabel(/سهم از مبلغ قرارداد/).fill('۲۵');
      await plan.getByRole('button', { name: 'برنامه‌ریزی Milestone' }).click();
      await expect(page.getByText('Milestone برنامه‌ریزی شد.')).toBeVisible();
      await expect(page.getByText(MILESTONE, { exact: true })).toBeVisible();
      await expect(page.getByText(/سهم برنامه‌ریزی‌شده: ۲۵٪/)).toBeVisible();

      await page.getByText(`ویرایش «${MILESTONE}»`).click();
      const change = page.getByRole('form', { name: `ویرایش Milestone — ${MILESTONE}` });
      await change.getByLabel(/^عنوان/).fill(MILESTONE_CHANGED);
      await change.getByRole('button', { name: 'ویرایش Milestone' }).click();
      await expect(page.getByText('Milestone ویرایش شد.')).toBeVisible();
      await expect(page.getByText(MILESTONE_CHANGED, { exact: true })).toBeVisible();
      await expectAccessible(page);
    } finally {
      await close();
    }
  });
});
