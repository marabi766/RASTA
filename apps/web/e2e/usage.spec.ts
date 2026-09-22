import { expect, test } from '@playwright/test';

/**
 * `/usage` in a real browser.
 *
 * ## What this job can and cannot prove today
 *
 * The `Portal in a browser` job starts **only the portal** (`playwright.config.ts`,
 * `webServer`). There is no gateway, no Keycloak and no fleet-service in it,
 * and it sets none of the portal's server variables — so nothing here can
 * sign in, and a real submission cannot be made. Standing one up would mean
 * PostgreSQL, Kafka, Keycloak, api-gateway and fleet-service in this job,
 * plus a `WEB_SESSION_SECRET` and a way to mint a session cookie without a
 * browser login. That is a change to CI, not to this file, and it is named in
 * the PR rather than faked here: a test that stubbed the gateway would assert
 * that the stub works.
 *
 * What a browser *can* prove without any of that is the part of the write
 * path that must hold before a person is ever signed in:
 *
 *   1. the route is closed to a visitor with no session — server-side, not by
 *      a hidden link;
 *   2. nothing is put in browser storage on the way (ADR-059's central claim,
 *      extended from `/login` to this route);
 *   3. the redirect carries the person back to where they were going.
 */

test.describe('the usage route', () => {
  test('sends a visitor with no session to the login page', async ({ page }) => {
    await page.goto('/usage');

    // Server-side: the page redirects before rendering anything, so there is
    // no moment where a form for a machine appears to somebody signed out.
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fusage|\/login\?returnTo=\/usage/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ورود به رستا');
  });

  test('works with javascript disabled, all the way to the login page', async ({ browser }) => {
    // The whole write path is built to survive a blocked bundle: a plain form
    // post to a server action. The guard in front of it has to survive it too.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    await page.goto('/usage');
    await expect(page.getByRole('link', { name: /ورود با حساب سازمانی/ })).toBeVisible();

    await context.close();
  });

  test('puts nothing in browser storage on this route either', async ({ page }) => {
    await page.goto('/usage');

    const stored = await page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));

    expect(stored.local).toEqual([]);
    expect(stored.session).toEqual([]);
  });
});
