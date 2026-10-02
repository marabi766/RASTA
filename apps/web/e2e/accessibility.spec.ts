import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { installLiveSession } from './live-session';

/**
 * Accessibility and reflow in a real browser, at desktop and at phone size.
 *
 * ## What this adds to `jest-axe`
 *
 * Every screen already passes `jest-axe` in a component test. That runs in
 * jsdom, which has no layout and no resolved styles, so it **cannot** see the
 * two things a real browser can: colour contrast as painted, and whether the
 * page still fits a phone. Those are what this spec is for. The rule set is the
 * one docs/16 § 16.9 names, WCAG 2.1 A and AA.
 *
 * ## Two layers
 *
 * The visitor page needs only the portal and always runs. The signed-in pages
 * need the live stack (`WEB_LIVE_STACK_E2E`, set by the `Portal in a browser`
 * job), exactly as `usage.spec.ts` does, and are skipped otherwise rather than
 * pretending services are present.
 *
 * Runs in both Playwright projects (`playwright.config.ts`): the same pages,
 * the same rules, two viewports.
 */

const WCAG_2_1_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** What a failure should say: the rule, how bad, and the elements, not the whole report. */
async function violationsOf(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_2_1_AA).analyze();
  return violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map((node) => node.target.join(' ')),
  }));
}

/**
 * The page must not scroll sideways. On a phone a horizontally scrolling page
 * means something is wider than the screen — a table, a row of filters, a
 * long identifier — and everything after it is reached by dragging.
 */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('a visitor page', () => {
  test('the login page has no WCAG 2.1 AA violations and fits the screen', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ورود به رستا');

    expect(await violationsOf(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('is live: the same check reports a violation when one is put on the page', async ({
    page,
  }) => {
    // A check that can only pass proves nothing. An image with no text
    // alternative is WCAG 1.1.1 at level A, and axe must see it.
    await page.goto('/login');
    await page.evaluate(() => {
      const img = document.createElement('img');
      img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
      document.body.append(img);
    });

    const rules = (await violationsOf(page)).map((violation) => violation.rule);
    expect(rules).toContain('image-alt');
  });

  test('is served right to left with a language, which is what axe relies on', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fa');
  });
});

/**
 * The signed-in pages, as the organization administrator of ORG-DEH-0001, who
 * can see every screen in this epic. Ids are the demo seeds', which the job
 * loads (`Seed the live …` step) and which `docs/16` § 16.6 routes to.
 *
 * Each page is waited for by its own `h1` rather than a sleep: a page that
 * has not rendered has nothing to assert about.
 */
const SIGNED_IN_PAGES: readonly { readonly path: string; readonly title: string | RegExp }[] = [
  { path: '/', title: /.+/ },
  { path: '/assets', title: 'ماشین‌آلات' },
  { path: '/assets/AST-SEED-0001', title: /.+/ },
  { path: '/assets/AST-SEED-0001/timeline', title: /.+/ },
  { path: '/drivers', title: 'راننده و تخصیص' },
  { path: '/drivers/DRV-SEED-0001', title: /.+/ },
  { path: '/maintenance', title: 'نگهداری و تعمیرات' },
  { path: '/maintenance/MNT-SEED-0001', title: /.+/ },
  { path: '/usage', title: 'ثبت کارکرد' },
  { path: '/organizations', title: /.+/ },
];

test.describe('the signed-in pages (live stack)', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E !== 'true',
    'needs the live stack the Portal in a browser job starts',
  );

  for (const { path, title } of SIGNED_IN_PAGES) {
    test(`${path} has no WCAG 2.1 AA violations and fits the screen`, async ({ context, page }) => {
      await installLiveSession(context, 'orgAdmin');
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path.replace(/[/-]/g, '\\$&')}$`));
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);

      expect(await violationsOf(page)).toEqual([]);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  }
});
