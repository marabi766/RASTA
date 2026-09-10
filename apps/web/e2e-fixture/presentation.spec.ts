import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_DISCLOSURE } from '../src/lib/demo/mode';
import { capabilityByKey } from '../src/lib/capabilities';
import { resolveTourStops } from '../src/lib/demo/tour';

/**
 * The demo as an audience sees it: a real browser, a real production build, no
 * backend within reach.
 *
 * The jsdom specs prove the rules hold in the components. These prove they
 * survive the build — that the disclosure really is on the page after Next has
 * split, streamed and hydrated it, that the tour's focus management works
 * against a real focus ring rather than a simulated one, and that a session in
 * this mode genuinely opens no connection.
 *
 * The gateway host is `.invalid`, so the last of those is enforced by DNS as
 * well as asserted here.
 */

const STOPS = resolveTourStops(true);

/** Read from the registry, so a renamed capability renames the test too. */
const ASSETS_LINK = capabilityByKey('assets')!.title;

/** Anything leaving the browser that is not this server. */
function recordExternalRequests(page: Page): string[] {
  const seen: string[] = [];

  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('http') && !url.includes('localhost:3212')) seen.push(url);
  });

  return seen;
}

test.describe('the presentation entry point', () => {
  test('opens without a session and without a sign-in prompt', async ({ page }) => {
    await page.goto('/demo');

    // The one route that must render on a laptop with no backend in reach. A
    // presenter who lands on a login screen has already lost the room.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ورود' })).toHaveCount(0);
  });

  test('shows the presenter toolbar and names the data mode', async ({ page }) => {
    await page.goto('/demo');

    await expect(page.getByText('ابزار ارائه')).toBeVisible();
    await expect(page.getByText('FIXTURE').first()).toBeVisible();
    await expect(page.getByText('دادهٔ نمایشی').first()).toBeVisible();
  });

  test('keeps the toolbar off the product screens', async ({ page }) => {
    // A full-screen button next to a real asset register is an invitation to
    // press it by accident mid-sentence.
    await page.goto('/assets');
    await expect(page.getByText('ابزار ارائه')).toHaveCount(0);
  });
});

test.describe('the fixture disclosure', () => {
  test('is visible on the entry point, verbatim', async ({ page }) => {
    await page.goto('/demo');

    const banner = page.getByTestId('fixture-disclosure');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(FIXTURE_DISCLOSURE);
  });

  // A screen at a time, so a failure names the route rather than the loop.
  for (const href of ['/', '/assets', '/fleet', '/wallet', '/procurement']) {
    test(`follows the viewer onto ${href}`, async ({ page }) => {
      await page.goto(href);
      await expect(page.getByTestId('fixture-disclosure')).toBeVisible();
    });
  }

  test('cannot be dismissed', async ({ page }) => {
    await page.goto('/demo');

    const banner = page.getByTestId('fixture-disclosure');
    // No close control of any kind inside it, so there is no state in which the
    // page shows invented data without saying so.
    await expect(banner.getByRole('button')).toHaveCount(0);
    await expect(banner.getByRole('link')).toHaveCount(0);
  });

  test('stays on screen after client-side navigation', async ({ page }) => {
    await page.goto('/demo');
    await page.getByRole('link', { name: ASSETS_LINK }).first().click();

    await expect(page).toHaveURL(/\/assets/);
    await expect(page.getByTestId('fixture-disclosure')).toBeVisible();
  });
});

test.describe('fixture mode reaches nothing', () => {
  test('opens no connection to any host but this server', async ({ page }) => {
    const external = recordExternalRequests(page);

    await page.goto('/demo');
    await page.getByRole('link', { name: ASSETS_LINK }).first().click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForTimeout(500);

    // Not the gateway, and not the identity provider either: a fixture session
    // never touches `oidc-client-ts`, so there is no silent-renew iframe and no
    // SSO probe.
    expect(external).toEqual([]);
  });

  test('renders records from the dataset rather than an empty state', async ({ page }) => {
    await page.goto('/assets');

    await expect(page.getByText('گریدر نمونه ۱').first()).toBeVisible();
  });

  test('tells the same story about one machine on two screens', async ({ page }) => {
    // The dossier and the fleet board read the same dataset, so the grader is
    // in maintenance on one and undispatchable on the other. Incoherence here
    // is what an investor notices and a presenter cannot explain.
    await page.goto('/assets/ast_demo_grader');
    await expect(page.getByText('SN-DEMO-0001')).toBeVisible();
    await expect(page.getByText('غیرقابل اعزام').first()).toBeVisible();

    await page.goto('/fleet');
    await expect(page.getByText('گریدر نمونه ۱').first()).toBeVisible();
  });
});

test.describe('the guided tour', () => {
  test('starts at the first stop and says where it is', async ({ page }) => {
    await page.goto('/demo');
    await page.getByRole('button', { name: 'شروع روایت', exact: true }).click();

    await expect(page.getByTestId('tour-overlay')).toBeVisible();
    await expect(page.getByText(`گام ۱ از ${toPersian(STOPS.length)}`)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(escapeForUrl(STOPS[0]!.href)));
  });

  test('puts focus on the step heading', async ({ page }) => {
    await page.goto('/demo');
    await page.getByRole('button', { name: 'شروع روایت', exact: true }).click();

    // Without this, a route change leaves focus wherever it was and a
    // screen-reader user is never told the step changed.
    const heading = page.getByTestId('tour-overlay').getByRole('heading', { level: 2 });
    await expect(heading).toBeFocused();
  });

  test('advances to the next real screen', async ({ page }) => {
    await page.goto('/demo');
    await page.getByRole('button', { name: 'شروع روایت', exact: true }).click();
    await expect(page.getByTestId('tour-overlay')).toBeVisible();

    await page.getByRole('button', { name: 'گام بعدی' }).click();

    await expect(page).toHaveURL(new RegExp(escapeForUrl(STOPS[1]!.href)));
    await expect(page.getByText(`گام ۲ از ${toPersian(STOPS.length)}`)).toBeVisible();
    await expect(page.getByTestId('tour-overlay').getByRole('heading', { level: 2 })).toBeFocused();
  });

  test('exits on Escape and leaves the screen behind it intact', async ({ page }) => {
    await page.goto('/demo');
    await page.getByRole('button', { name: 'شروع روایت', exact: true }).click();
    await expect(page.getByTestId('tour-overlay')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByTestId('tour-overlay')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('survives a reload mid-demo', async ({ page }) => {
    await page.goto('/demo');
    await page.getByRole('button', { name: 'شروع روایت', exact: true }).click();
    await page.getByRole('button', { name: 'گام بعدی' }).click();
    await expect(page.getByText(`گام ۲ از ${toPersian(STOPS.length)}`)).toBeVisible();

    await page.reload();

    // A presenter who refreshes should not be dropped back to step one in front
    // of an audience.
    await expect(page.getByText(`گام ۲ از ${toPersian(STOPS.length)}`)).toBeVisible();
  });

  test('ends on a capability the platform has not built', async ({ page }) => {
    const last = STOPS.at(-1)!;
    expect(last.capability.state).toBe('PLANNED');

    await page.goto(last.href);

    // A tour of only the finished parts is the dishonest edit.
    await expect(
      page.getByText('PREVIEW — داده نمایشی است و عملیات واقعی انجام نمی‌شود'),
    ).toBeVisible();
  });
});

test.describe('a not-built screen is not a dead end', () => {
  test('offers the way back to the presentation', async ({ page }) => {
    await page.goto('/procurement');

    await expect(page.getByRole('link', { name: 'بازگشت به صفحهٔ ارائه' })).toBeVisible();
  });

  test('offers to continue the tour while one is running', async ({ page }) => {
    await page.goto('/demo');
    await page.getByRole('button', { name: 'شروع روایت', exact: true }).click();
    await expect(page.getByTestId('tour-overlay')).toBeVisible();

    await page.goto('/procurement');

    // Mid-tour "continue" beats the browser's back button, which is a small but
    // visible stumble in front of an audience.
    await expect(page.getByRole('button', { name: 'ادامهٔ روایت' })).toBeVisible();
  });

  test('shows no control that looks like it does something', async ({ page }) => {
    await page.goto('/inventory');

    await expect(page.locator('form')).toHaveCount(0);
    await expect(page.locator('input')).toHaveCount(0);
    await expect(page.locator('canvas')).toHaveCount(0);
  });
});

test.describe('the presentation surface at every size', () => {
  test('never scrolls the body sideways on any tour stop', async ({ page }) => {
    // The classic RTL regression: one physical property escapes and the whole
    // page shifts. Checked on the presentation route and on every screen the
    // tour actually lands on.
    for (const href of ['/demo', ...STOPS.map((stop) => stop.href)]) {
      await page.goto(href);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflows, `${href} scrolls sideways`).toBe(false);
    }
  });

  test('keeps the tour usable with the overlay open', async ({ page }) => {
    await page.goto('/demo');
    await page.getByRole('button', { name: 'شروع روایت', exact: true }).click();

    const overlay = page.getByTestId('tour-overlay');
    await expect(overlay).toBeVisible();

    // The overlay docks to the bottom edge; the page behind it must still be
    // reachable, or the tour has covered the thing it is talking about.
    const box = (await overlay.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.height).toBeLessThan(viewport.height * 0.6);
    expect(box.width).toBeLessThanOrEqual(viewport.width + 1);
  });

  test('gives every tour control a reachable tap target', async ({ page }) => {
    await page.goto('/demo');
    await page.getByRole('button', { name: 'شروع روایت', exact: true }).click();
    await expect(page.getByTestId('tour-overlay')).toBeVisible();

    const overlay = page.getByTestId('tour-overlay');

    for (const name of ['گام بعدی', 'از ابتدا', 'پایان روایت (Esc)']) {
      const box = (await overlay.getByRole('button', { name }).boundingBox())!;
      expect(box.height, `«${name}» is under the 44px tap target`).toBeGreaterThanOrEqual(44);
    }
  });
});

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

function toPersian(value: number): string {
  return String(value).replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)]!);
}

function escapeForUrl(href: string): string {
  return href.replaceAll('/', '\\/');
}
