const swcOptions = require('../../jest.swc.cjs');
const swcTransform = { '^.+\\.(t|j)s$': ['@swc/jest', swcOptions] };

/** @type {import('jest').Config} */
module.exports = {
  // Two projects, so `test:unit` stays fast and runnable without Docker while
  // integration tests — which need a real PostgreSQL, and a real broker for the
  // event path — are opt-in.
  //
  // Two deliberate differences from the services written before this one:
  //
  //   `test:integration` does *not* pass `--passWithNoTests`. This service is
  //   the first with real integration tests, and the flag is precisely what let
  //   the stage be green while empty (PROJECT_MEMORY § 19). Deleting the last
  //   file in `test/` now fails the build, which is the intent.
  //
  //   `test` selects the unit project only, so `pnpm verify` stays runnable on
  //   a machine with no Docker. The integration suite is a separate gate that
  //   CI runs explicitly against provisioned services — hiding it inside
  //   `test` would either break every local verify or push someone to
  //   reintroduce `--passWithNoTests`.
  projects: [
    {
      displayName: 'unit',
      rootDir: 'src',
      testEnvironment: 'node',
      testRegex: '.*\\.spec\\.ts$',
      transform: swcTransform,
      clearMocks: true,
    },
    {
      displayName: 'integration',
      rootDir: 'test',
      testEnvironment: 'node',
      testRegex: '.*\\.int-spec\\.ts$',
      transform: swcTransform,
      clearMocks: true,
    },
  ],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/generated/**', '!src/main.ts'],
  coverageDirectory: 'coverage',
  // Integration tests talk to a real database and a real broker; the 5s
  // default is far too short.
  testTimeout: 60000,
  coverageThreshold: {
    global: { branches: 70, functions: 70, lines: 70, statements: 70 },
  },
};
