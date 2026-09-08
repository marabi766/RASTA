import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the portal.
 *
 * ## What this project deliberately does and does not cover
 *
 * It exercises the surfaces that need **no backend and no identity provider**:
 * the dashboard, the «در حال ساخت» routes, the RTL declaration, keyboard
 * access and the responsive breakpoints. Those are real end-to-end assertions
 * — a real browser, a real production build, real layout — and they are
 * deterministic because nothing they touch has a network dependency.
 *
 * It does **not** cover the authenticated marketplace flow. Doing that here
 * would mean standing up a fake Keycloak and minting a fake token, and a test
 * that manufactures its own credentials proves less than the jsdom contract
 * tests already do while looking like it proves more. The authenticated flow is
 * covered by the component specs under `src/components` as contract/UI tests,
 * and real evidence for it requires the live stack.
 *
 * Nothing here starts, stops or mutates shared infrastructure. The server is
 * this application's own production build on a port of its own.
 */

const PORT = 3211;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Screenshot capture has no assertions; a green tick against it would mean
  // nothing. Run it deliberately with `pnpm screens`.
  testIgnore: ['**/screenshots.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    locale: 'fa-IR',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: `next build && next start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: {
      // The gateway is never reached by this project, but the application
      // refuses to start without a validated configuration — by design, so a
      // misconfigured deployment fails loudly rather than talking to the wrong
      // environment.
      NEXT_PUBLIC_API_BASE_URL: 'http://localhost:3000',
      NEXT_PUBLIC_KEYCLOAK_URL: 'http://localhost:8080',
      NEXT_PUBLIC_KEYCLOAK_REALM: 'rasta',
      NEXT_PUBLIC_KEYCLOAK_CLIENT_ID: 'rasta-web',
    },
  },
});
