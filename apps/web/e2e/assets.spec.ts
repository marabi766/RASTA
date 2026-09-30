import { expect, test } from '@playwright/test';

/**
 * `/assets` in a real browser.
 *
 * ## What this job can and cannot prove today
 *
 * Unchanged from `organizations.spec.ts`: the `Portal in a browser` job starts
 * the portal with identity, fleet and the gateway only — no asset-service — so
 * nothing here signs in and no machine can actually be registered or edited.
 * That gap is named in the PR rather than papered over: a test against a
 * stubbed gateway would assert that the stub works.
 *
 * What a browser can prove without a session is the thing worth proving for a
 * route that now *writes*: that it is not reachable, and that nothing in the
 * URL can make it show a form, a confirmation, or a machine to a stranger.
 */

test.describe('the assets routes', () => {
  test('send a visitor with no session to the login page', async ({ page }) => {
    await page.goto('/assets');

    // Server-side, before anything renders: there is no moment where the
    // registration form appears to somebody signed out.
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fassets|\/login\?returnTo=\/assets/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ورود به رستا');
    await expect(page.getByRole('button', { name: 'ثبت ماشین' })).toHaveCount(0);
    await expect(page.getByLabel(/نوع ماشین/)).toHaveCount(0);
  });

  test('keep a machine dossier, its edit form and its confirmations closed', async ({ page }) => {
    // `?created=1` and `?updated=1` are attacker-controllable; they must not
    // become a way to render a confirmation, a form or an id for a stranger.
    await page.goto('/assets/AST_01J00000000000000000000000?created=1&updated=1');

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/ماشین ثبت شد|مشخصات ماشین ذخیره شد/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'ذخیرهٔ مشخصات' })).toHaveCount(0);
    // The login page keeps the *path* the person asked for, so they land back
    // on it after signing in; that is their own input, echoed to them. The
    // query is not kept: a confirmation flag never outlives the redirect.
    const content = await page.content();
    expect(content).not.toContain('created=1');
    expect(content).not.toContain('updated=1');
  });

  test('stay closed with javascript disabled', async ({ browser }) => {
    // The forms are plain posts to server actions, so they survive a blocked
    // bundle by design. The guard in front of them has to survive it too.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    await page.goto('/assets');
    await expect(page.getByRole('link', { name: /ورود با حساب سازمانی/ })).toBeVisible();
    await expect(page.locator('form[action*="assets"]')).toHaveCount(0);

    await context.close();
  });

  test('leak nothing into browser storage on the way', async ({ page }) => {
    await page.goto('/assets');

    const stored = await page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));

    expect(stored.local).toEqual([]);
    expect(stored.session).toEqual([]);
  });
});
