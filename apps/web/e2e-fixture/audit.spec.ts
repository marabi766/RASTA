import { expect, test } from '@playwright/test';
import { FIXTURE_ENTRY_POINTS } from '../src/lib/demo/entry-points';

/**
 * The audit evidence screens, in a real browser, against the built fixture
 * bundle — no backend in reach (AUD-001 through AUD-003).
 *
 * This file proves what the jsdom specs in `src/components/audit/audit.spec.tsx`
 * cannot: that the four verification outcomes are actually reachable through
 * the page's own preset buttons once Next has split, streamed and hydrated the
 * real build, and that the fixture disclosure survives onto these two new
 * routes exactly as it does everywhere else.
 */

const AUDIT_EVENT_ID = FIXTURE_ENTRY_POINTS.auditEventId;

test.describe('the fixture disclosure follows onto the audit screens', () => {
  for (const href of ['/audit', `/audit/${AUDIT_EVENT_ID}`]) {
    test(`is visible on ${href}`, async ({ page }) => {
      await page.goto(href);
      await expect(page.getByTestId('fixture-disclosure')).toBeVisible();
    });
  }
});

test.describe('the audit list', () => {
  test('renders records from the dataset, not an empty state', async ({ page }) => {
    await page.goto('/audit');

    await expect(page.getByText('asset.asset_registered')).toBeVisible();
  });

  test('links a row to its own detail page', async ({ page }) => {
    await page.goto('/audit');

    const row = page.getByRole('row', { name: /asset\.asset_registered/ });
    await row.getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/audit/${AUDIT_EVENT_ID}`));
  });

  test('shows no control that writes', async ({ page }) => {
    await page.goto('/audit');

    for (const button of await page.getByRole('button').all()) {
      const name = (await button.textContent()) ?? '';
      expect(name).not.toMatch(/اصلاح|حذف|خروجی|Export|Purge/i);
    }
  });
});

test.describe('the audit detail page', () => {
  test(`renders the record at ${AUDIT_EVENT_ID}`, async ({ page }) => {
    await page.goto(`/audit/${AUDIT_EVENT_ID}`);

    await expect(page.getByText('asset.asset_registered')).toBeVisible();
    await expect(page.getByText('ast_demo_grader')).toBeVisible();
  });

  test('never renders a raw JSON payload block', async ({ page }) => {
    await page.goto(`/audit/${AUDIT_EVENT_ID}`);
    await expect(page.getByText('asset.asset_registered')).toBeVisible();

    await expect(page.locator('pre')).toHaveCount(0);
  });
});

test.describe('hash-chain verification — all four outcomes', () => {
  test('VALID', async ({ page }) => {
    await page.goto('/audit');
    await page.getByRole('button', { name: 'زنجیرهٔ معتبر' }).click();
    await page.getByRole('button', { name: 'بررسی زنجیره' }).click();

    await expect(page.getByText('معتبر', { exact: true })).toBeVisible();
    await expect(page.getByText(/غیرقابل دست‌کاری است/)).toHaveCount(0);
  });

  test('DIVERGENT', async ({ page }) => {
    await page.goto('/audit');
    await page.getByRole('button', { name: 'زنجیرهٔ واگرا' }).click();
    await page.getByRole('button', { name: 'بررسی زنجیره' }).click();

    await expect(page.getByText('واگرا', { exact: true })).toBeVisible();
    await expect(page.getByText('نخستین واگرایی', { exact: true })).toBeVisible();
  });

  test('EMPTY', async ({ page }) => {
    await page.goto('/audit');
    await page.getByRole('button', { name: 'بازهٔ خالی' }).click();
    await page.getByRole('button', { name: 'بررسی زنجیره' }).click();

    await expect(page.getByText('بدون رکورد')).toBeVisible();
  });

  test('UNVERIFIABLE_LEGACY', async ({ page }) => {
    await page.goto('/audit');
    await page.getByRole('button', { name: 'بازهٔ پیش از AUD-003' }).click();
    await page.getByRole('button', { name: 'بررسی زنجیره' }).click();

    await expect(page.getByText('غیرقابل‌تأیید (پیش از AUD-003)')).toBeVisible();
    await expect(page.getByText(/نامعتبر است/)).toHaveCount(0);
  });
});

test.describe('capability state', () => {
  test('the audit screen badges itself BETA, not LIVE', async ({ page }) => {
    await page.goto('/audit');

    // Scoped to `<main>`: the same badge text also appears, compacted, in the
    // navigation rail, which collapses off-screen at narrower viewports.
    const main = page.locator('main');
    await expect(main.getByText('ناقص').first()).toBeVisible();
    await expect(main.getByText('BETA').first()).toBeVisible();
  });
});
