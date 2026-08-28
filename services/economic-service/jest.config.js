const swcOptions = require('../../jest.swc.cjs');
const swcTransform = { '^.+\.(t|j)s$': ['@swc/jest', swcOptions] };

// Every amount in this service is a bigint, and jest-worker serialises results
// with JSON.stringify — so without this, a failing money assertion is reported
// as a serialisation error instead of as the failure it is. See jest.setup.cjs.
const setupFiles = [require.resolve('./jest.setup.cjs')];

/** @type {import('jest').Config} */
module.exports = {
  // Two projects, for the reasons fleet-service and maintenance-service split
  // them — and one that is specific to this service:
  //
  //   `test:integration` does *not* pass `--passWithNoTests`. That flag is what
  //   let the integration stage report green while running nothing
  //   (PROJECT_MEMORY § 19). For a financial domain it would be worse than
  //   useless: the ledger immutability trigger, the row locks and the
  //   transaction atomicity exist only in the database, so a suite that does
  //   not reach a real PostgreSQL proves none of them.
  //
  //   `test` selects the unit project only, so `pnpm verify` stays runnable on
  //   a machine with no Docker.
  projects: [
    {
      displayName: 'unit',
      rootDir: 'src',
      testEnvironment: 'node',
      testRegex: '.*\.spec\.ts$',
      transform: swcTransform,
      setupFiles,
      clearMocks: true,
    },
    {
      displayName: 'integration',
      rootDir: 'test',
      testEnvironment: 'node',
      testRegex: '.*\.int-spec\.ts$',
      transform: swcTransform,
      setupFiles,
      clearMocks: true,
    },
  ],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/generated/**', '!src/main.ts'],
  coverageDirectory: 'coverage',
  // Integration tests talk to a real database and a real broker, and the
  // concurrency suites deliberately run a hundred parallel writers.
  testTimeout: 120000,
  // docs/14 § 14.2 sets 90% for the financial logic of this service, against
  // 75% elsewhere. The number is higher here because an untested branch in a
  // ledger is not a missing feature — it is an unbalanced journal nobody saw.
  coverageThreshold: {
    global: { branches: 90, functions: 90, lines: 90, statements: 90 },
  },
};
