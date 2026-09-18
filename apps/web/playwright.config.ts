import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the portal.
 *
 * Kept separate from `tests/e2e`, which drives the whole platform against a
 * running stack. This project asks a narrower question — does the portal
 * behave in a real browser — and starts only the portal to answer it.
 *
 * It is not wired into CI by this change. A browser job that runs against no
 * screens would assert nothing; it joins the pipeline with the first real
 * surface, in `EXP-002`.
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
    command: 'pnpm run dev',
    url: 'http://localhost:3200',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
