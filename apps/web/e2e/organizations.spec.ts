import { expect, test } from '@playwright/test';

/**
 * `/organizations` in a real browser.
 *
 * ## What this job can and cannot prove today
 *
 * Unchanged from `usage.spec.ts`: the `Portal in a browser` job starts **only
 * the portal**, with no gateway, no Keycloak and no identity-service, and
 * none of the portal's server variables set. So nothing here signs in, and no
 * member's roles can actually be changed. That gap is named in the PR rather
 * than papered over — a test against a stubbed gateway would assert that the
 * stub works.
 *
 * This route deserves the check more than most, because it is the one that
 * administers **who may do what**. If it were ever reachable without a
 * session, the page would be offering role management to a stranger. So what
 * a browser can prove without a session is exactly the thing worth proving:
 * that it is not reachable.
 */

test.describe('the organizations route', () => {
  test('sends a visitor with no session to the login page', async ({ page }) => {
    await page.goto('/organizations');

    // Server-side, before anything renders: there is no moment where a member
    // list or a role picker appears to somebody signed out.
    await expect(page).toHaveURL(
      /\/login\?returnTo=%2Forganizations|\/login\?returnTo=\/organizations/,
    );
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ورود به رستا');
  });

  test('stays closed with javascript disabled', async ({ browser }) => {
    // The forms are plain posts to server actions, so they survive a blocked
    // bundle by design. The guard in front of them has to survive it too —
    // and a guard that only held while React was running would be no guard.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    await page.goto('/organizations');
    await expect(page.getByRole('link', { name: /ورود با حساب سازمانی/ })).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);

    await context.close();
  });

  test('leaks nothing into browser storage on the way', async ({ page }) => {
    await page.goto('/organizations');

    const stored = await page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));

    expect(stored.local).toEqual([]);
    expect(stored.session).toEqual([]);
  });

  test('does not reveal the route through a query it was never given', async ({ page }) => {
    // The confirmation banner is rendered from the query (`?saved=`), which is
    // attacker-controllable. It must not become a way to render anything for
    // somebody with no session — the redirect happens first, whatever the URL
    // says.
    await page.goto('/organizations?saved=roles&revoked=1');

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText('نقش‌های عضو ذخیره شد.')).toHaveCount(0);
  });
});
