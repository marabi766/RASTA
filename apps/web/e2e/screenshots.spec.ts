import { test } from '@playwright/test';
import path from 'node:path';

/**
 * Evidence capture, not a test.
 *
 * Run explicitly (`--grep @screenshot`); excluded from the normal run because
 * a screenshot has no assertion and a green tick against one would be
 * meaningless.
 */
const OUT = process.env.SHOT_DIR ?? path.join(process.cwd(), 'playwright-report', 'screens');

const SURFACES: Array<[string, string]> = [
  ['dashboard', '/'],
  ['walkthrough', '/present'],
  ['under-construction', '/procurement'],
  ['backend-ready', '/rewards'],
  ['sign-in-required', '/marketplace'],
];

for (const [name, route] of SURFACES) {
  test(`@screenshot ${name}`, async ({ page }, testInfo) => {
    await page.goto(route);
    // The signed-out screens settle once the silent-renew attempt times out.
    await page.waitForTimeout(route === '/marketplace' ? 9000 : 1500);
    await page.screenshot({
      path: path.join(OUT, `${name}-${testInfo.project.name}.png`),
      fullPage: true,
    });
  });
}
