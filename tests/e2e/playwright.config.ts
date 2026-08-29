import { defineConfig } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * ## Why there is no browser project yet
 *
 * `apps/web` and `apps/admin` are empty directories. A browser scenario would
 * have to drive a page that does not exist, so the only honest browser test
 * today is one that tests its own fixture. The `economic-api` project below
 * drives the same stack through the same gateway with Playwright's
 * `APIRequestContext` — real tokens, real routing, real database, real broker,
 * nothing mocked.
 *
 * When `apps/web` lands, add a second project here:
 *
 * ```ts
 * {
 *   name: 'web',
 *   testDir: './specs/web',
 *   use: { ...devices['Desktop Chrome'], baseURL: process.env.E2E_WEB_URL },
 * }
 * ```
 *
 * and run `pnpm exec playwright install chromium` in CI. Nothing in `src/`
 * assumes the absence of a UI, and the token and event helpers are shared.
 *
 * ## Why no `--pass-with-no-tests`, anywhere
 *
 * Playwright fails a run that matches no tests, and that default is kept
 * deliberately. An E2E stage that reports green while executing nothing is the
 * exact failure this whole task exists to close (PROJECT_MEMORY § 22).
 */
export default defineConfig({
  testDir: './specs',
  testMatch: '**/*.e2e-spec.ts',

  globalSetup: './global-setup.ts',

  /**
   * One worker, and no parallelism inside a file.
   *
   * These scenarios assert on wallet balances for two seeded organizations.
   * Two workers holding funds on the same wallet at the same time would make
   * every balance assertion a race, and the fix — asserting only on deltas —
   * would weaken exactly the assertion that matters. The concurrency proof
   * lives where it belongs, in `wallet-concurrency.int-spec.ts`, which runs a
   * hundred parallel withdrawals on purpose.
   */
  workers: 1,
  fullyParallel: false,

  /**
   * No retries. A financial scenario that passes on the second attempt has
   * found a race, and retrying it turns that finding into noise
   * (docs/10 § 10.12).
   */
  retries: 0,

  // A settlement waits on the outbox relay poll and a Kafka round trip.
  timeout: 120_000,
  expect: { timeout: 15_000 },

  forbidOnly: !!process.env.CI,

  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['github']]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    trace: 'retain-on-failure',
    // Every assertion in this suite is about an HTTP status, a JSON body or a
    // Kafka header. Screenshots and video would be empty files.
    screenshot: 'off',
    video: 'off',
  },

  projects: [
    {
      name: 'economic-api',
      testDir: './specs/economic',
    },
    {
      name: 'marketplace-api',
      testDir: './specs/marketplace',
      // After the economic project, because a marketplace order settles
      // through economic-service: if the financial critical path is broken,
      // the failure should name itself there rather than surfacing as an order
      // that never completed.
      dependencies: ['economic-api'],
    },
  ],
});
