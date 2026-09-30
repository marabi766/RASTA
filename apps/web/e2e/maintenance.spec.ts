import { expect, test } from '@playwright/test';

/**
 * `/maintenance` in a real browser.
 *
 * ## What this job can and cannot prove today
 *
 * Unchanged from `organizations.spec.ts`: the `Portal in a browser` job starts
 * the portal with identity, fleet and the gateway only — no maintenance-service,
 * no asset-service — so nothing here signs in and no request can actually be
 * reported. That gap is named in the PR rather than papered over: a test
 * against a stubbed gateway would assert that the stub works.
 *
 * What a browser can prove without a session is the thing worth proving for a
 * route that now *writes*: that it is not reachable, and that nothing in the
 * URL can make it show a form, a confirmation, or a machine's identity to a
 * stranger.
 */

test.describe('the maintenance route', () => {
  test('sends a visitor with no session to the login page', async ({ page }) => {
    await page.goto('/maintenance');

    // Server-side, before anything renders: there is no moment where the
    // report form appears to somebody signed out.
    await expect(page).toHaveURL(
      /\/login\?returnTo=%2Fmaintenance|\/login\?returnTo=\/maintenance/,
    );
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ورود به رستا');
    await expect(page.getByRole('button', { name: 'ثبت درخواست' })).toHaveCount(0);
  });

  test('does not let a prefilled machine id conjure the form', async ({ page }) => {
    // `?assetId=` prefills the form for somebody who arrived from a dossier.
    // It is attacker-controllable, and it must not become a way to render the
    // form, or echo an id back, for somebody with no session.
    await page.goto('/maintenance?assetId=AST_01J00000000000000000000000#report-request');

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByLabel(/شناسهٔ ماشین/)).toHaveCount(0);
    expect(await page.content()).not.toContain('AST_01J00000000000000000000000');
  });

  test('keeps a request detail closed, and its confirmation with it', async ({ page }) => {
    await page.goto('/maintenance/MRQ_1?created=1');

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/درخواست ثبت شد/)).toHaveCount(0);
  });

  test('stays closed with javascript disabled', async ({ browser }) => {
    // The form is a plain post to a server action, so it survives a blocked
    // bundle by design. The guard in front of it has to survive it too.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    await page.goto('/maintenance');
    await expect(page.getByRole('link', { name: /ورود با حساب سازمانی/ })).toBeVisible();
    await expect(page.locator('form[action*="maintenance"]')).toHaveCount(0);

    await context.close();
  });

  test('leaks nothing into browser storage on the way', async ({ page }) => {
    await page.goto('/maintenance');

    const stored = await page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));

    expect(stored.local).toEqual([]);
    expect(stored.session).toEqual([]);
  });
});
