import { test, type BrowserContext, type Page } from './expect';
import { expect } from './expect';

import { SUBMISSION_FIELD } from '../src/lib/form-fields';
import { SESSION_COOKIE, newCsrfToken, sealSession } from '../src/server/session';
import { userThemeCookieName } from '../src/server/theme-cookie';
import { actingAccessToken } from '../src/test/session-token';
import { THEME_COOKIE_NAME } from '../src/ui/theme/theme';
import { installLiveSession } from './live-session';

/**
 * The light / dark theme in a real browser (owner decision 2026-10-24).
 *
 * Light for everyone whatever the device prefers; dark by a switch; the choice
 * remembered per person on the device, in a cookie the SERVER reads — so the
 * HTML the server sends already carries the right `data-theme`.
 *
 * What a browser alone can show, and so what is here (the resolver, the cookie
 * name and the component are unit-tested):
 *
 *   1. a device that asks for dark still gets a light page, in the HTML and in
 *      the painted colours;
 *   2. the switch changes the page in place, survives a reload, and is dark in
 *      the response itself — not only after hydration — under the production
 *      content security policy, which allows no inline script;
 *   3. nothing but the theme cookie is added, and nothing in storage;
 *   4. two people on one browser each get their own choice;
 *   5. a half-filled form keeps what was typed when the page is switched.
 */

const SWITCH = { name: 'حالت تیره' } as const;

/** The `<html …>` start tag of the HTML the server sent — before any script ran. */
async function serverHtmlTag(response: Awaited<ReturnType<Page['goto']>>): Promise<string> {
  const body = (await response!.text()) as string;
  const tag = /<html\b[^>]*>/.exec(body);
  expect(tag).not.toBeNull();
  return tag![0];
}

/**
 * The page's own background, as the browser painted it (0 black … 1 white).
 * Chromium reports an `oklch()` token as written, so the colour is drawn on a
 * one-pixel canvas and read back as sRGB.
 */
async function backgroundLightness(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.fillStyle = getComputedStyle(document.body).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });
}

async function themeCookies(context: BrowserContext) {
  return (await context.cookies()).filter((cookie) => cookie.name.startsWith('rasta_theme'));
}

/** A signed-in person whose access token grants their pinned organization nothing:
 * `/account/recovery` is theirs, and it draws no tenant data, so it needs no gateway. */
function sessionCookie(subject: string) {
  const secret = process.env.WEB_SESSION_SECRET;
  if (!secret) throw new Error('This scenario needs WEB_SESSION_SECRET (the portal has it).');
  const now = Math.floor(Date.now() / 1000);
  return {
    name: SESSION_COOKIE,
    value: sealSession(
      {
        subject,
        username: subject,
        organizationId: 'ORG-E2E-LOST',
        accessToken: actingAccessToken('ORG-E2E-OTHER'),
        accessTokenExpiresAt: now + 3600,
        refreshToken: 'e2e-refresh',
        csrfToken: newCsrfToken(),
        issuedAt: now - 60,
      },
      secret,
    ),
    domain: 'localhost',
    path: '/',
    httpOnly: true,
    sameSite: 'Strict' as const,
  };
}

test.describe('the theme (visitor)', () => {
  test('a device that prefers dark still gets the light page', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'dark', locale: 'fa-IR' });
    const page = await context.newPage();

    const response = await page.goto('/login');
    expect(await serverHtmlTag(response)).toContain('data-theme="light"');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(
      true,
    );
    expect(await backgroundLightness(page)).toBeGreaterThan(0.9);
    // Native controls follow the theme, not the device.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
      'light',
    );
    await expect(page.getByRole('button', SWITCH)).toHaveAttribute('aria-pressed', 'false');
    // Choosing nothing writes nothing.
    expect(await themeCookies(context)).toEqual([]);

    await context.close();
  });

  test('the switch changes the page in place, and dark survives a reload — in the server HTML', async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: 'light', locale: 'fa-IR' });
    const page = await context.newPage();
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/content security policy|refused to (execute|apply)/i.test(message.text())) {
        violations.push(message.text());
      }
    });

    const first = await page.goto('/login');
    // The production policy: scripts only by nonce, none inline of ours.
    const policy = (await first!.allHeaders())['content-security-policy'] ?? '';
    expect(policy).toMatch(/script-src [^;]*'nonce-/);
    expect(policy).not.toContain("'unsafe-inline'");

    const toggle = page.getByRole('button', SWITCH);
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(await backgroundLightness(page)).toBeLessThan(0.2);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
      'dark',
    );

    // Nothing reloaded: the document is the one we loaded.
    expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);

    const cookies = await themeCookies(context);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({
      name: 'rasta_theme',
      value: 'dark',
      path: '/',
      sameSite: 'Lax',
      httpOnly: false,
    });
    // A year, give or take the test's own clock.
    expect(cookies[0].expires - Date.now() / 1000).toBeGreaterThan(364 * 24 * 3600);

    // The response itself says dark — read before any script runs.
    const reloaded = await page.reload();
    expect(await serverHtmlTag(reloaded)).toContain('data-theme="dark"');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // And with scripts blocked altogether.
    const bare = await browser.newContext({
      javaScriptEnabled: false,
      storageState: await context.storageState(),
    });
    const barePage = await bare.newPage();
    const bareResponse = await barePage.goto('/login');
    expect(await serverHtmlTag(bareResponse)).toContain('data-theme="dark"');
    expect(await backgroundLightness(barePage)).toBeLessThan(0.2);
    await bare.close();

    // Back to light, and that is remembered too.
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await serverHtmlTag(await page.reload())).toContain('data-theme="light"');

    expect(violations).toEqual([]);
    await context.close();
  });

  test('is operated from the keyboard, after the way in', async ({ page }) => {
    await page.goto('/login');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: /ورود با حساب سازمانی/ })).toBeFocused();
    await page.keyboard.press('Tab');
    const toggle = page.getByRole('button', SWITCH);
    await expect(toggle).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // It never navigated: still the login page, nothing submitted.
    await expect(page).toHaveURL(/\/login$/);
  });

  test('puts only the theme cookie in the browser, and nothing in storage', async ({
    context,
    page,
  }) => {
    await page.goto('/login');
    await page.getByRole('button', SWITCH).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    const stored = await page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
      cookies: document.cookie,
    }));
    expect(stored.local).toEqual([]);
    expect(stored.session).toEqual([]);
    expect(stored.cookies).toBe('rasta_theme=dark');

    // The narrow allow-list: every cookie the login page leaves is a theme
    // cookie, named and valued as the theme defines — and nothing of a session.
    for (const cookie of await context.cookies()) {
      expect(cookie.name).toMatch(THEME_COOKIE_NAME);
      expect(['light', 'dark']).toContain(cookie.value);
    }
  });

  test('a cookie that is not exactly light or dark is light', async ({ context, page }) => {
    for (const value of ['Dark', 'DARK', 'system', '1', 'darker', 'null']) {
      await context.addCookies([{ name: 'rasta_theme', value, domain: 'localhost', path: '/' }]);
      expect(await serverHtmlTag(await page.goto('/login'))).toContain('data-theme="light"');
    }
  });
});

test.describe('the theme, per person on one device', () => {
  test.skip(!process.env.WEB_SESSION_SECRET, 'needs the portal’s session secret to seal sessions');

  test('two people on one browser each see their own choice', async ({ browser }) => {
    const secret = process.env.WEB_SESSION_SECRET!;
    const nameA = userThemeCookieName('USR-E2E-A', secret);
    const nameB = userThemeCookieName('USR-E2E-B', secret);
    expect(nameA).toMatch(THEME_COOKIE_NAME);
    expect(nameA).not.toBe(nameB);
    expect(nameA + nameB).not.toContain('USR-E2E');

    const context = await browser.newContext({ colorScheme: 'dark', locale: 'fa-IR' });
    const page = await context.newPage();
    const toggle = page.getByRole('button', SWITCH);

    // Someone chooses dark on the login page: the device cookie.
    await page.goto('/login');
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // A signs in. The device's choice is not A's: light, and the switch says so.
    await context.addCookies([sessionCookie('USR-E2E-A')]);
    expect(await serverHtmlTag(await page.goto('/account/recovery'))).toContain(
      'data-theme="light"',
    );
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // A chooses dark: A's own cookie, not the device's.
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect((await themeCookies(context)).map((cookie) => cookie.name).sort()).toEqual(
      ['rasta_theme', nameA].sort(),
    );
    expect(await serverHtmlTag(await page.reload())).toContain('data-theme="dark"');

    // B signs in on the same browser: A's dark is not B's. Light.
    await context.addCookies([sessionCookie('USR-E2E-B')]);
    expect(await serverHtmlTag(await page.goto('/account/recovery'))).toContain(
      'data-theme="light"',
    );
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // B chooses dark and then light again; A is untouched by it.
    await toggle.click();
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const cookies = await themeCookies(context);
    expect(cookies.find((cookie) => cookie.name === nameB)?.value).toBe('light');
    expect(cookies.find((cookie) => cookie.name === nameA)?.value).toBe('dark');

    // A again: still dark. Logging out (the session cookie goes) keeps every
    // theme cookie, and the login page shows the device's own choice.
    await context.addCookies([sessionCookie('USR-E2E-A')]);
    expect(await serverHtmlTag(await page.goto('/account/recovery'))).toContain(
      'data-theme="dark"',
    );
    await context.clearCookies({ name: SESSION_COOKIE });
    expect(await serverHtmlTag(await page.goto('/login'))).toContain('data-theme="dark"');
    expect((await themeCookies(context)).map((cookie) => cookie.name).sort()).toEqual(
      ['rasta_theme', nameA, nameB].sort(),
    );

    await context.close();
  });
});

test.describe('the theme on a portal page (live stack)', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E !== 'true',
    'needs the live stack the Portal in a browser job starts',
  );

  test('switching keeps a half-filled form exactly as it was', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'fa-IR', timezoneId: 'Asia/Tehran' });
    await installLiveSession(context);
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await page.goto('/usage');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ثبت کارکرد');
    await page.locator('input[name="assetId"]').fill('AST-SEED-0001');
    await page.locator('textarea[name="notes"]').fill('یادداشت نیمه‌کاره');
    const key = page.locator(`input[name="${SUBMISSION_FIELD}"]`);
    const keyBefore = await key.inputValue();
    const marker = await page.evaluate(() => {
      const mark = `m-${Math.random()}`;
      (window as unknown as { __mark: string }).__mark = mark;
      return mark;
    });

    const toggle = page.getByRole('banner').getByRole('button', SWITCH);
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // Same document (no reload), same fields, same submission key.
    await expect(page).toHaveURL(/\/usage$/);
    expect(await page.evaluate(() => (window as unknown as { __mark?: string }).__mark)).toBe(
      marker,
    );
    await expect(page.locator('input[name="assetId"]')).toHaveValue('AST-SEED-0001');
    await expect(page.locator('textarea[name="notes"]')).toHaveValue('یادداشت نیمه‌کاره');
    expect(await key.inputValue()).toBe(keyBefore);

    // The portal page's own cookie is this person's, not the device's.
    const names = (await themeCookies(context)).map((cookie) => cookie.name);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^rasta_theme_[0-9a-f]{24}$/);

    await context.close();
  });
});
