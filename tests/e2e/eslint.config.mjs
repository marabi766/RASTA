import base, { internalPlugin } from '../../eslint.config.mjs';

/**
 * The shared rules, plus this package's own generated output.
 *
 * `playwright-report/` and `test-results/` appear the moment anybody runs the
 * suite. They hold a bundled browser application and trace attachments — tens
 * of thousands of lines of minified third-party code — so linting them
 * produces thousands of `no-undef` errors about `document` and `navigator` and
 * buries anything real. Both are gitignored; this keeps `pnpm lint` usable on
 * a machine that has actually run the tests.
 */
export default [
  { ignores: ['playwright-report/**', 'test-results/**'] },
  ...base,
  {
    // The boundary covers every scenario and helper here, specs included
    // (PR #492 r1 F2): a request goes through the guarded `send()`, or through
    // Playwright's request fixture, which src/expect.ts wraps in
    // guardRequestContext. The node:test unit tests of the harness are not
    // scenarios: they drive the transports themselves against loopback fakes.
    files: ['**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    plugins: { internal: internalPlugin },
    rules: { 'internal/raw-http': ['error', { playwright: true }] },
  },
  {
    // The E2E harness has no nest-common runtime dependency. Its hand guard in
    // send() uses the same five statuses; actor.test.ts exercises real HTTP.
    // Only this transport implementation is exempt, not actors or new senders.
    files: ['src/http.ts'],
    rules: { 'internal/transport': 'off' },
  },
];
