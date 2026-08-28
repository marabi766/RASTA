const swcOptions = require('../../jest.swc.cjs');
const swcTransform = { '^.+\.(t|j)s$': ['@swc/jest', swcOptions] };

/** @type {import('jest').Config} */
module.exports = {
  // Two projects, for the same reasons fleet-service split them:
  //
  //   `test:integration` does *not* pass `--passWithNoTests`. That flag is what
  //   let the integration stage report green while running nothing
  //   (PROJECT_MEMORY § 19), so deleting the last file in `test/` fails the
  //   build here, which is the intent.
  //
  //   `test` selects the unit project only, so `pnpm verify` stays runnable on
  //   a machine with no Docker. The integration suite is a separate gate CI
  //   runs against provisioned services.
  projects: [
    {
      displayName: 'unit',
      rootDir: 'src',
      testEnvironment: 'node',
      testRegex: '.*\.spec\.ts$',
      transform: swcTransform,
      clearMocks: true,
    },
    {
      displayName: 'integration',
      rootDir: 'test',
      testEnvironment: 'node',
      testRegex: '.*\.int-spec\.ts$',
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
