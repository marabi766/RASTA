import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the portal.
 *
 * Kept separate from `tests/e2e`, which drives the economic critical path.
 * Playwright owns only the portal process here; CI may provision the narrow
 * live stack an individual browser scenario needs before this suite starts.
 * `WEB_LIVE_STACK_E2E` is the explicit opt-in, so ordinary local runs keep the
 * visitor checks fast and do not pretend unavailable services are present.
 *
 * It joined CI with `EXP-002`, exactly as this comment used to say it would:
 * a browser job that ran against no screens would have asserted nothing, and
 * `/login` is the first real surface.
 */
/** The specs that also run at a phone's viewport: read-only, see the project. */
const MOBILE_SPECS = /(accessibility|tenant-isolation|asset-lifecycle)\.spec\.ts$/;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3200',
    trace: 'on-first-retry',
    // The portal is Persian and right-to-left everywhere; a browser told
    // otherwise would exercise a locale no user has.
    locale: 'fa-IR',
    timezoneId: 'Asia/Tehran',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      // The same Chromium at a phone's size and with touch: Pixel 5, 393×851.
      // docs/16 § 16.3 makes this portal mobile-first (a dehyari operator at a
      // machine is on a phone), and EXP-002's second acceptance criterion names
      // "supported mobile viewports". Nothing in the docs fixes a device list,
      // so the one profile is a stated choice, not a discovered requirement.
      //
      // **Read-only scenarios, and the one that writes only to machines it
      // registers itself** (`MOBILE_SPECS`). The suite shares one live stack,
      // and a write scenario that shared a record would run against it twice,
      // at once; what a second viewport adds to such a write is nothing the
      // first did not prove. `asset-lifecycle.spec.ts` shares nothing: every
      // test registers its own machine, so a phone is a second viewport and not
      // a second writer. Accessibility and tenant isolation are exactly what a
      // second viewport can change — layout, reflow, what is reachable — so
      // those run on both.
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
      testMatch: MOBILE_SPECS,
    },
  ],
  webServer: {
    // A production build in CI, the dev server locally. They are different
    // programs: the dev server compiles on demand and tolerates things the
    // build refuses, so a browser job running against it would pass on code
    // that could not ship. Locally the compile-on-demand is what makes the
    // suite usable while writing a screen.
    command: process.env.CI ? 'pnpm run start' : 'pnpm run dev',
    url: 'http://localhost:3200',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
