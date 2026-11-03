import { test, expect, type Page } from './expect';
import { installLayoutSession } from './layout/harness';

/**
 * The portal on a phone, with its pages **populated** (demo run 2026-10-24,
 * defect 5: a 16-item menu filling the first screen, wallet and product pages
 * 559 px and 481 px wide at a 390 px screen, the offers table's last column cut
 * off).
 *
 * It runs against a second copy of the portal wired to a fixture gateway
 * (`layout/mock-gateway.mjs`, started by `playwright.config.ts`) so that each
 * page has rows as long as real ones, and needs no live stack. A layout check
 * against an empty page proves nothing, so every page first asserts it is
 * populated, and the viewport is checked to be the width asked for (a page
 * with no viewport tag would be laid out at 980 px and pass any width check).
 *
 * Explicit widths, not a device: 360 px is the narrowest phone in use, 390 px
 * the one of the demo, and the config's `mobile` project (Pixel 5, 393 px) is a
 * different thing. 1280 px proves the desktop menu is untouched.
 */

const PRODUCT = 'PRD_01J9ZK4W8Q2M6R1T5V7X3C0001';
const ORDER = 'ORD_01J9ZK4W8Q2M6R1T5V7X3C0001';

interface PageCase {
  readonly name: string;
  readonly path: string;
  /** Rows that must be on the page, in `main` tables. */
  readonly rows: number;
  /** A table on this page is wider than a 360 px screen, so it must scroll in its box. */
  readonly wide: boolean;
}

const PAGES: readonly PageCase[] = [
  { name: 'wallet', path: '/wallet', rows: 9, wide: true },
  { name: 'product offers', path: `/marketplace/${PRODUCT}`, rows: 3, wide: true },
  { name: 'catalogue', path: '/marketplace', rows: 6, wide: true },
  { name: 'maintenance list', path: '/maintenance', rows: 8, wide: true },
  { name: 'drivers', path: '/drivers', rows: 5, wide: true },
  { name: 'order', path: `/orders/${ORDER}`, rows: 3, wide: false },
];

const PHONES = [360, 390] as const;

const browserErrors = new WeakMap<Page, string[]>();

function trackBrowserErrors(page: Page): void {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
}

async function pageOverflow(page: Page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
}

for (const width of PHONES) {
  test.describe(`a ${width} px phone`, () => {
    test.use({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });

    test.beforeEach(async ({ context, page }) => {
      await installLayoutSession(context);
      trackBrowserErrors(page);
    });

    test.afterEach(({ page }) => {
      // A page that throws in the browser is not a page that was laid out.
      expect(browserErrors.get(page)).toEqual([]);
    });

    for (const { name, path, rows, wide } of PAGES) {
      test(`${name}: nothing makes the page scroll sideways`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

        // Not vacuous: the page is populated and the screen is the width asked for.
        expect(await page.locator('main table tbody tr').count()).toBeGreaterThanOrEqual(rows);
        const sizes = await pageOverflow(page);
        expect(sizes.innerWidth).toBe(width);

        expect(sizes.html).toBeLessThanOrEqual(sizes.innerWidth);
        expect(sizes.body).toBeLessThanOrEqual(sizes.innerWidth);

        // Every table scrolls inside a named, focusable box.
        const unboxed = await page.evaluate(() =>
          Array.from(document.querySelectorAll('main table'))
            .filter((table) => {
              const box = table.closest('[role="group"]');
              return (
                !box ||
                box.getAttribute('tabindex') !== '0' ||
                !(box.getAttribute('aria-label') ?? '').trim() ||
                getComputedStyle(box).overflowX !== 'auto'
              );
            })
            .map(
              (table) =>
                table.getAttribute('aria-label') ?? table.querySelector('caption')?.textContent,
            ),
        );
        expect(unboxed).toEqual([]);

        if (wide) {
          // The box is doing the work: some table really is wider than its box.
          const scrolling = await page.evaluate(
            () =>
              Array.from(document.querySelectorAll('main [role="group"][tabindex="0"]')).filter(
                (box) => box.scrollWidth > box.clientWidth + 1,
              ).length,
          );
          expect(scrolling).toBeGreaterThan(0);
        }
      });
    }

    test('the offers table is reachable and scrollable from the keyboard', async ({ page }) => {
      await page.goto(`/marketplace/${PRODUCT}`);
      const box = page.getByRole('group', { name: 'فهرست پیشنهادهای تأمین‌کنندگان' });
      await box.focus();
      await expect(box).toBeFocused();
      const before = await box.evaluate((element) => element.scrollLeft);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      // Scrolling by keys is animated by the browser: wait for it, do not sample once.
      await expect.poll(() => box.evaluate((element) => element.scrollLeft)).not.toBe(before);
      // The last column, the one that used to be cut off, can be brought into view
      // by the arrow keys alone (a key scrolls a few dozen pixels at a time).
      const last = box.getByRole('columnheader', { name: 'احراز صلاحیت' });
      const screen = page.viewportSize()!;
      const inView = async () => {
        const rect = await last.boundingBox();
        return rect !== null && rect.x >= 0 && rect.x + rect.width <= screen.width;
      };
      for (let presses = 0; presses < 60 && !(await inView()); presses += 1) {
        await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(60);
      }
      expect(await inView()).toBe(true);
    });

    test('the menu is collapsed behind a button, and the page starts on screen', async ({
      page,
    }) => {
      await page.goto('/wallet');
      const nav = page.getByRole('navigation', { name: 'ناوبری اصلی' });
      const toggle = nav.getByRole('button', { name: 'منوی ناوبری' });
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(nav.getByRole('link')).toHaveCount(0);

      // The page's own heading is on the first screen, not pushed below sixteen links.
      const heading = await page.getByRole('heading', { level: 1 }).boundingBox();
      expect(heading).not.toBeNull();
      expect(heading!.y + heading!.height).toBeLessThan(300);

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      // Every entry the person is offered, in the order they are drawn.
      expect(await nav.getByRole('link').count()).toBeGreaterThanOrEqual(14);
      await expect(nav.getByRole('link', { name: 'کیف پول' })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });

    test('Escape closes the menu and returns focus to its button', async ({ page }) => {
      await page.goto('/wallet');
      const nav = page.getByRole('navigation', { name: 'ناوبری اصلی' });
      const toggle = nav.getByRole('button', { name: 'منوی ناوبری' });
      await toggle.click();
      await nav.getByRole('link').nth(3).focus();
      await page.keyboard.press('Escape');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(nav.getByRole('link')).toHaveCount(0);
      await expect(toggle).toBeFocused();
    });
  });
}

test.describe('the menu without JavaScript', () => {
  test.use({
    viewport: { width: 390, height: 800 },
    isMobile: true,
    hasTouch: true,
    javaScriptEnabled: false,
  });

  test('is a plain visible list of links, with no button that cannot work', async ({
    context,
    page,
  }) => {
    await installLayoutSession(context);
    await page.goto('/wallet');
    const nav = page.getByRole('navigation', { name: 'ناوبری اصلی' });
    expect(await nav.getByRole('link').count()).toBeGreaterThanOrEqual(14);
    await expect(nav.getByRole('link', { name: 'کیف پول' })).toBeVisible();
    await expect(nav.getByRole('button')).toHaveCount(0);
  });
});

test.describe('a desktop screen', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('shows the whole menu and no button', async ({ context, page }) => {
    await installLayoutSession(context);
    await page.goto('/wallet');
    const nav = page.getByRole('navigation', { name: 'ناوبری اصلی' });
    await expect(nav.getByRole('button', { name: 'منوی ناوبری' })).toBeHidden();
    expect(await nav.getByRole('link').count()).toBeGreaterThanOrEqual(14);
    await expect(nav.getByRole('link', { name: 'کیف پول' })).toBeVisible();
    const sizes = await pageOverflow(page);
    expect(sizes.html).toBeLessThanOrEqual(sizes.innerWidth);
  });
});
