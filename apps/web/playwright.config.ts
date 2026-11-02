import { defineConfig, devices } from '@playwright/test';

import {
  LAYOUT_GATEWAY_PORT,
  LAYOUT_ORIGIN,
  LAYOUT_PORT,
  layoutSessionSecret,
} from './e2e/layout/constants';

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
  /(accessibility|tenant-isolation|asset-lifecycle|asset-records|asset-documents-availability|inventory-commands)\.spec\.ts$/;

/**
 * The phone-layout suite (`e2e/mobile-layout.spec.ts`) runs against its own copy
 * of the portal and a fixture gateway, not the live stack: its project below,
 * its two `webServer` entries at the end. Every other project ignores it.
 */
const LAYOUT_SPEC = /mobile-layout\.spec\.ts$/;

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
      // Accessibility and tenant isolation are exactly what a second viewport
      // can change — layout, reflow, what is reachable — so those run on both.
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
      testMatch: MOBILE_SPECS,
    },
  ],
  webServer: [
    {
      // Production mode everywhere, from ONE `next build`. The layout suite's
      // portal below is always `next start`, and `next dev` empties `.next`
      // (BUILD_ID included) when it starts: a dev server here made the second
      // portal unable to start on any local run (PR #574 review, F1). So
      // locally this entry builds first and then starts, and CI, which has
      // already built, only starts. Both portals thus read the same finished
      // build. A hand-run `pnpm dev` beside this suite has the same effect:
      // stop it first, or the layout portal reports a missing production build.
      // The price is a build per local run instead of compile-on-demand; the
      // gain is that the suite checks the code that ships.
      command: process.env.CI ? 'pnpm run start' : 'pnpm run build && pnpm run start',
      url: 'http://localhost:3200',
      reuseExistingServer: !process.env.CI,
      // A cold build is part of a local start.
      timeout: process.env.CI ? 120_000 : 360_000,
    },
    {
      // The fixture gateway for the layout suite: populated pages, no live stack.
      command: 'node e2e/layout/mock-gateway.mjs',
      url: `http://127.0.0.1:${LAYOUT_GATEWAY_PORT}/health`,
      env: { LAYOUT_GATEWAY_PORT: String(LAYOUT_GATEWAY_PORT) },
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // A second copy of the portal, pointed at the fixture gateway. Always a
      // production start on the build the entry above provides (CI has already
      // run it; locally that entry builds): it shares `.next` with the first
      // portal, so neither may be a dev server.
      command: `pnpm exec next start --port ${LAYOUT_PORT}`,
      url: `${LAYOUT_ORIGIN}/login`,
      env: {
        API_GATEWAY_URL: `http://127.0.0.1:${LAYOUT_GATEWAY_PORT}`,
        OIDC_ISSUER_URL: `http://127.0.0.1:${LAYOUT_GATEWAY_PORT}/realms/layout`,
        OIDC_CLIENT_ID: 'rasta-web',
        WEB_PUBLIC_ORIGIN: LAYOUT_ORIGIN,
        WEB_COOKIE_SECURE: 'false',
        WEB_SESSION_SECRET: layoutSessionSecret(),
        WEB_REDIS_URL: process.env.WEB_REDIS_URL ?? 'redis://localhost:6379',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
