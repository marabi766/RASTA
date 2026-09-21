import { expect, test } from '@playwright/test';

/**
 * The first browser test in this repository.
 *
 * `playwright.config.ts` has said since EXP-001 that a browser job which runs
 * against no screens asserts nothing, and that it would join the pipeline with
 * the first real surface. This is that surface.
 *
 * What is asserted here is deliberately only what a *browser* can prove. The
 * markup, the copy and the accessibility tree are already covered by the
 * component suite, which is faster and more precise; repeating them here would
 * buy nothing and cost a container. These three cannot be shown any other way:
 *
 *   1. The document really is served right-to-left and in Persian. That is an
 *      attribute on `<html>`, produced by the server, and every layout rule in
 *      the design system depends on it.
 *   2. The way in is a real navigation. A link that needs no JavaScript is a
 *      claim about the rendered page, not about the component that made it.
 *   3. **Nothing is stored in the browser.** ADR-059 says no token reaches
 *      `localStorage` or `sessionStorage` and adds that it is "provable with a
 *      test rather than a promise". A unit test cannot prove an absence in a
 *      browser; this can.
 *
 * The page needs no session and no configured environment: a visitor without a
 * cookie never reaches the code that reads one.
 */

test.describe('the way into the portal', () => {
  test('is served right-to-left and in Persian', async ({ page }) => {
    await page.goto('/login');

    const html = page.locator('html');
    await expect(html).toHaveAttribute('dir', 'rtl');
    await expect(html).toHaveAttribute('lang', 'fa');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ورود به رستا');
  });

  test('offers a way in that works without javascript', async ({ browser }) => {
    // Scripts off, because a slow rural connection and a blocked bundle are
    // the same thing to a person trying to sign in (docs/16 § 16.2).
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/login');

    const link = page.getByRole('link', { name: /ورود با حساب سازمانی/ });
    await expect(link).toHaveAttribute('href', '/auth/login');
    await expect(page.getByText(/گذرواژهٔ شما هرگز به این پورتال وارد نمی‌شود/)).toBeVisible();

    await context.close();
  });

  test('puts nothing in browser storage', async ({ page }) => {
    await page.goto('/login');

    const stored = await page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));

    // The whole point of ADR-059: an XSS on this page has nothing to take.
    expect(stored.local).toEqual([]);
    expect(stored.session).toEqual([]);
  });
});
