const swcOptions = require('../../jest.swc.cjs');
const swcTransform = { '^.+\.(t|j)s$': ['@swc/jest', swcOptions] };

// Every amount in this service is a bigint, and jest-worker serialises results
// with JSON.stringify — so without this, a failing money assertion is reported
// as a serialisation error instead of as the failure it is. See jest.setup.cjs.
const setupFiles = [require.resolve('./jest.setup.cjs')];

// One list, shared by both projects, and expressed relative to the **package**
// root rather than to a project's own directory.
//
// That distinction is what was wrong here until 2026-08-29. Each project set
// `rootDir` to its own folder (`src`, `test`), and jest resolves coverage globs
// against the project's rootDir — so `src/**/*.ts` became `src/src/**/*.ts` for
// the unit project and `test/src/**/*.ts` for the integration one. Nothing
// matched, `--coverage` reported `All files | 0 | 0 | 0 | 0`, and because there
// were no files to measure the 90% threshold below never failed. The gate
// docs/14 § 14.2 makes mandatory for this service existed only on paper.
//
// The fix is to give both projects the package root as `rootDir` and point
// `roots` at the folder each one owns, so a glob means the same thing
// everywhere and the integration suites — which are where the ledger, the row
// locks and the settlement transaction are actually exercised — count towards
// the number.
const collectCoverageFrom = [
  'src/**/*.ts',
  '!src/**/*.spec.ts',
  '!src/generated/**',
  '!src/main.ts',
];

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
      rootDir: __dirname,
      roots: ['<rootDir>/src'],
      testEnvironment: 'node',
      testRegex: '.*\.spec\.ts$',
      transform: swcTransform,
      setupFiles,
      clearMocks: true,
      collectCoverageFrom,
    },
    {
      displayName: 'integration',
      rootDir: __dirname,
      roots: ['<rootDir>/test'],
      testEnvironment: 'node',
      testRegex: '.*\.int-spec\.ts$',
      transform: swcTransform,
      setupFiles,
      clearMocks: true,
      collectCoverageFrom,
    },
  ],
  collectCoverageFrom,
  coverageDirectory: 'coverage',
  // Integration tests talk to a real database and a real broker, and the
  // concurrency suites deliberately run a hundred parallel writers.
  testTimeout: 120000,
  // docs/14 § 14.2 sets 90% for the financial logic of this service, against
  // 75% elsewhere. The number is higher here because an untested branch in a
  // ledger is not a missing feature — it is an unbalanced journal nobody saw.
  //
  // Measured across **both** projects: a wallet lock or a settlement rollback
  // has no unit-testable form, so a unit-only number would push the suite
  // towards mocking the database — which is precisely what docs/10 § 10.12
  // forbids. Run it with `pnpm --filter @rasta/economic-service coverage`.
  coverageThreshold: {
    global: { branches: 90, functions: 90, lines: 90, statements: 90 },
  },
};
