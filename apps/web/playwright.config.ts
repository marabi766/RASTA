import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the portal.
 *
 * Kept separate from `tests/e2e`, which drives the whole platform against a
 * running stack. This project asks a narrower question — does the portal
 * behave in a real browser — and starts only the portal to answer it.
 *
 * It joined CI with `EXP-002`, exactly as this comment used to say it would:
 * a browser job that ran against no screens would have asserted nothing, and
 * `/login` is the first real surface.
 */
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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
