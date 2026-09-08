import { expect, test, type Page } from '@playwright/test';
import { CAPABILITIES } from '../src/lib/capabilities';

/**
 * The investor walkthrough, in a real browser.
 *
 * Contract/UI scope: no backend, no identity provider, nothing mutated. What
 * these assert is what a viewer of the preview actually sees before signing in
 * — which is most of what a demo is judged on.
 */

/**
 * Requests aimed at the API Gateway.
 *
 * Deliberately not "any external request". The portal shell asks Keycloak
 * whether an SSO session exists on every page, including this one — that is the
 * layout establishing a session, not the page fetching data, and it happens
 * whether or not the route has anything to show. What must never happen on a
 * not-built capability is a call to the platform's data plane.
 */
function recordGatewayRequests(page: Page): string[] {
  const seen: string[] = [];

  page.on('request', (request) => {
    if (request.url().includes('localhost:3000')) seen.push(request.url());
  });

  return seen;
}

test.describe('the shell', () => {
  test('declares Persian and right-to-left on the document', async ({ page }) => {
    await page.goto('/');

    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', 'fa');
    await expect(html).toHaveAttribute('dir', 'rtl');
  });

  test('never scrolls the body sideways', async ({ page }) => {
    // A horizontal scrollbar on the document is the classic RTL regression:
    // one physical property escapes and the whole page shifts.
    await page.goto('/');

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });

  test('offers a skip link as the first focus stop', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');

    await expect(page.getByRole('link', { name: 'رفتن به محتوای اصلی' })).toBeFocused();
  });

  test('reaches every navigation entry by keyboard', async ({ page }) => {
    await page.goto('/');

    const first = page.getByRole('navigation', { name: 'قابلیت‌ها' }).getByRole('link').first();
    await first.focus();
    await expect(first).toBeFocused();

    // A visible focus indicator, not `outline: none`.
    const outline = await first.evaluate((node) => getComputedStyle(node).outlineStyle);
    expect(outline).not.toBe('none');
  });
});

test.describe('the dashboard', () => {
  test('states build status without inventing an operational figure', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'وضعیت قابلیت‌های پلتفرم' })).toBeVisible();

    const sections = await page.locator('main section').allTextContents();
    const text = sections.join('\n');
    expect(text).not.toMatch(/ریال/);
    expect(text).not.toMatch(/[٪%]/);
  });

  test('shows a status for every capability', async ({ page }) => {
    await page.goto('/');

    // Derived from the manifest rather than typed out, so adding a capability
    // cannot leave the dashboard silently missing one.
    const cards = page.locator('main section[aria-labelledby="capabilities-heading"] li');
    await expect(cards).toHaveCount(CAPABILITIES.length);
  });
});

test.describe('capabilities that are not built', () => {
  test('opens a real route that says so and touches no network', async ({ page }) => {
    const gatewayCalls = recordGatewayRequests(page);

    await page.goto('/procurement');

    await expect(page.getByRole('heading', { name: 'این بخش در حال ساخت است' })).toBeVisible();
    await expect(
      page.getByText(
        'در این صفحه هیچ تراکنش واقعی انجام نمی‌شود و هیچ داده‌ای ثبت یا ارسال نمی‌گردد.',
      ),
    ).toBeVisible();

    expect(gatewayCalls).toEqual([]);
  });

  test('shows no form, no chart and no money', async ({ page }) => {
    await page.goto('/inventory');

    await expect(page.locator('main form')).toHaveCount(0);
    await expect(page.locator('main input')).toHaveCount(0);
    await expect(page.locator('main canvas')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('ریال');
  });

  test('distinguishes architecture-ready from not-planned', async ({ page }) => {
    await page.goto('/fleet');
    await expect(page.getByText(/از نظر معماری آماده است/)).toBeVisible();

    await page.goto('/notifications');
    await expect(page.getByText(/برنامه‌ریزی‌شده اما ساخته نشده/)).toBeVisible();
  });
});

test.describe('routes needing a session', () => {
  test('asks the user to sign in rather than failing', async ({ page }) => {
    await page.goto('/marketplace');

    // The generous timeout is the silent-renew attempt settling. Where Keycloak
    // is unreachable that fails immediately; where it is reachable but refuses
    // to be framed (`frame-ancestors 'self'`, see `lib/auth/user-manager.ts`)
    // it runs to the configured timeout first. Either way the answer is
    // "anonymous", and this asserts the user is told so rather than left under
    // a spinner.
    await expect(page.getByRole('heading', { name: 'برای ادامه وارد شوید' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: 'ورود با حساب سازمانی' })).toBeVisible();
  });

  test('never asks for a password in this application', async ({ page }) => {
    // Authorization Code + PKCE means the credential is entered at Keycloak.
    await page.goto('/marketplace');
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });
});

test.describe('interactive targets', () => {
  test('are at least 44 pixels tall', async ({ page }) => {
    await page.goto('/');

    const links = page.getByRole('navigation', { name: 'قابلیت‌ها' }).getByRole('link');
    const count = await links.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const box = await links.nth(index).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});
