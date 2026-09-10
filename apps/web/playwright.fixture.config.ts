import { defineConfig, devices } from '@playwright/test';

/**
 * The presentation surface, built in fixture mode.
 *
 * ## Why this is a second config rather than a second project
 *
 * `NEXT_PUBLIC_DEMO_DATA_MODE` is inlined by Next at build time, so the data
 * mode is a property of the bundle rather than of the run. A project inside
 * `playwright.config.ts` would share that config's server and therefore its
 * build, and would be testing live mode while claiming to test fixtures. Two
 * builds means two servers, and two servers means two configs.
 *
 * The port is its own (3212) so this can run beside the live-mode project and
 * beside a dev server without either noticing.
 *
 * Nothing here starts, stops or mutates shared infrastructure. There is no
 * backend to reach: the gateway placeholders point at `.invalid` hosts, which
 * RFC 2606 guarantees can never resolve — so «no request left the browser» is
 * enforced by the network stack, not only asserted by a test.
 */

const PORT = 3212;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e-fixture',
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
      NEXT_PUBLIC_DEMO_DATA_MODE: 'fixture',
      // Well-formed so the configuration check passes, unresolvable so nothing
      // can reach them. Fixture mode reads none of these.
      NEXT_PUBLIC_API_BASE_URL: 'http://gateway.invalid',
      NEXT_PUBLIC_KEYCLOAK_URL: 'http://identity.invalid',
      NEXT_PUBLIC_KEYCLOAK_REALM: 'rasta',
      NEXT_PUBLIC_KEYCLOAK_CLIENT_ID: 'rasta-web',
    },
  },
});
