import { defineConfig, devices } from '@playwright/test';

import { LAYOUT_ORIGIN } from './e2e/layout/constants';
import { webServers } from './e2e/web-servers';

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
const MOBILE_SPECS =
  /(accessibility|tenant-isolation|asset-lifecycle|asset-records|asset-documents-availability|inventory-commands|project-needs)\.spec\.ts$/;

/**
 * The phone-layout suite (`e2e/mobile-layout.spec.ts`) runs against its own copy
 * of the portal and a fixture gateway, not the live stack: its project below,
 * its two `webServer` entries at the end. Every other project ignores it.
 */
const LAYOUT_SPEC = /mobile-layout\.spec\.ts$/;

/**
 * No server is ever reused, and nothing is inspected while this file loads
 * (`e2e/server-reuse.ts`, TASK 323 and 325): workers and UI mode's loader load it
 * again, and a port that is free now can be taken before the server binds. Locally
 * each entry starts through `e2e/own-server.mjs`, which reports it ready only
 * while the server it launched is the sole holder of the port; CI, on a fresh
 * machine, polls the URL as before. The entries are in `e2e/web-servers.ts`, so
 * the rule can be tested without loading Playwright.
 */
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // In CI, `list` as well as `github`: the job log then names every test with
  // its outcome (passed, failed, skipped) per project, which is the evidence
  // that the live scenarios ran rather than skipped (PR #305 review round 2).
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:3200',
    trace: 'on-first-retry',
    // The portal is Persian and right-to-left everywhere; a browser told
    // otherwise would exercise a locale no user has.
    locale: 'fa-IR',
    timezoneId: 'Asia/Tehran',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: LAYOUT_SPEC },
    {
      // Populated pages at explicit 360, 390 and 1280 px widths, with no live
      // stack (see LAYOUT_SPEC). The viewport is set by the spec itself.
      name: 'layout',
      use: { ...devices['Desktop Chrome'], baseURL: LAYOUT_ORIGIN },
      testMatch: LAYOUT_SPEC,
    },
    {
      // The same Chromium at a phone's size and with touch: Pixel 5, 393×851.
      // docs/16 § 16.3 makes this portal mobile-first (a dehyari operator at a
      // machine is on a phone), and EXP-002's second acceptance criterion names
      // "supported mobile viewports". Nothing in the docs fixes a device list,
      // so the one profile is a stated choice, not a discovered requirement.
      //
      // **Read-only scenarios, and the ones that write only to machines they
      // register themselves** (`MOBILE_SPECS`). The suite shares one live stack,
      // and a write scenario that shared a record would run against it twice,
      // at once; what a second viewport adds to such a write is nothing the
      // first did not prove. `asset-lifecycle.spec.ts`, `asset-records.spec.ts`
      // and `asset-documents-availability.spec.ts` share nothing: every test
      // registers its own machine, so a phone is a second viewport and not a
      // second writer.
      // `inventory-commands.spec.ts` is of the same kind: every run creates its own
      // warehouse, so a phone is a second viewport and not a second writer.
      // `project-needs.spec.ts` is the same: every test makes its own project (and its
      // needs) through the gateway.
      // Accessibility and tenant isolation are exactly what a second viewport
      // can change — layout, reflow, what is reachable — so those run on both.
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
      testMatch: MOBILE_SPECS,
    },
  ],
  webServer: webServers(ci),
});
