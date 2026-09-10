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

    await expect(page.getByRole('heading', { name: 'رستا — نمای کلی پلتفرم' })).toBeVisible();

    const text = (await page.locator('main section').allTextContents()).join('\n');
    expect(text).not.toBe('');

    // Matched as rendered *figures* rather than as words. The capability map
    // legitimately contains prose saying that rial valuation does not exist
    // yet, and that sentence is the honesty rather than a breach of it.
    expect(text).not.toMatch(/[۰-۹][۰-۹٬]*\s*ریال/);
    expect(text).not.toMatch(/[۰-۹]\s*[٪%]/);
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

    await expect(page.getByRole('heading', { name: 'وضعیت این بخش' })).toBeVisible();
    await expect(
      page.getByText(
        'در این صفحه هیچ تراکنش واقعی انجام نمی‌شود و هیچ داده‌ای ثبت یا ارسال نمی‌گردد.',
      ),
    ).toBeVisible();

    // The exact required wording, verbatim.
    await expect(
      page.getByText('PREVIEW — داده نمایشی است و عملیات واقعی انجام نمی‌شود'),
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

  test('distinguishes the reasons rather than collapsing them', async ({ page }) => {
    // Three different answers to "when will this work", and the screen gives
    // the specific one rather than «به‌زودی».
    await page.goto('/rewards');
    await expect(page.getByText(/منتظر یک تصمیم محصولی یا حاکمیتی است/)).toBeVisible();

    await page.goto('/notifications');
    await expect(page.getByText(/برنامه‌ریزی‌شده اما ساخته نشده/)).toBeVisible();
  });

  test('explains the roadmap without claiming the capability', async ({ page }) => {
    await page.goto('/procurement');

    await expect(page.getByText('این قابلیت چه مشکلی را حل می‌کند')).toBeVisible();
    await expect(page.getByText(/هیچ‌کدام از موارد زیر امروز کار نمی‌کند/)).toBeVisible();
    await expect(page.getByText('پیش‌نیازهای شروع')).toBeVisible();
  });
});

test.describe('routes needing a session', () => {
  test('asks the user to sign in rather than failing', async ({ page }) => {
    // Playwright's 30s default is not enough headroom for the settle described
    // below when the three viewport projects run it at once *and* Keycloak
    // happens to be reachable — the case where the renew runs its full 20s
    // rather than failing at once. The test passed alone and failed in the
    // parallel run, which is a scheduling fact rather than a product one.
    test.setTimeout(90_000);

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

test.describe('the presentation route in the default build', () => {
  test('opens without a session', async ({ page }) => {
    // `/demo` carries no session guard in either mode: it is the route a
    // presenter opens first, and a login wall there defeats the purpose.
    await page.goto('/demo');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('says the data is live, and shows no fixture disclosure', async ({ page }) => {
    await page.goto('/demo');

    // This build set no `NEXT_PUBLIC_DEMO_DATA_MODE`, so the default holds.
    // A fixture banner here would mean the mode had turned itself on.
    await expect(page.getByTestId('fixture-disclosure')).toHaveCount(0);
    await expect(page.getByText('LIVE').first()).toBeVisible();
    await expect(page.getByText('دادهٔ زنده').first()).toBeVisible();
  });

  test('sends the tour to list screens rather than to invented records', async ({ page }) => {
    await page.goto('/demo');
    await page.getByRole('button', { name: 'شروع روایت', exact: true }).click();

    // A live tenant has no record with a known id, so a deep link would 404 on
    // every deployment but the fixture one.
    await expect(page).toHaveURL(/\/organizations$/);
  });
});
