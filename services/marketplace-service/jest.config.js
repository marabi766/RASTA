const swcOptions = require('../../jest.swc.cjs');
const disclosureGuard = require('../../jest.disclosure-guard.cjs');
const swcTransform = { '^.+\.(t|j)s$': ['@swc/jest', swcOptions] };

// Money in this service is a bigint on the way to and from economic-service,
// and jest-worker serialises results with JSON.stringify — so without this a
// failing money assertion is reported as a serialisation error rather than as
// the failure it is. Same file, same reason, as economic-service.
const setupFiles = [require.resolve('./jest.setup.cjs')];

// Expressed relative to the **package** root, with `roots` naming the folder
// each project owns. economic-service learned this the hard way: a project
// whose `rootDir` is its own folder resolves `src/**` to `src/src/**`, nothing
// matches, and the coverage gate silently measures nothing.
const collectCoverageFrom = [
  'src/**/*.ts',
  '!src/**/*.spec.ts',
  '!src/generated/**',
  '!src/main.ts',
];

// Measures workflow code inside Temporal's bundle (see the threshold below), for the
// gate's own command only: instrumenting has a cost a plain test run should not pay,
// and a bare `jest --coverage` without it can only report a lower number.
const measuresCoverage = process.env.npm_lifecycle_event === 'test:coverage';
const setupFilesAfterEnv = [
  disclosureGuard,
  ...(measuresCoverage ? [require.resolve('./test/temporal-workflow-coverage.setup.ts')] : []),
];

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: 'unit',
      setupFilesAfterEnv,
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
      setupFilesAfterEnv,
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
  // `docs/14` § 14.2 puts this service in the 75% band. Until now that number
  // lived only in the document, so nothing failed when coverage fell below it
  // — and it had, to 40% branches. The gate is set at the documented figure
  // rather than at whatever the suite currently reaches, so it measures the
  // requirement and not the status quo.
  //
  // `src/temporal/workflows.ts` is counted here and is measured: Temporal executes
  // workflow code from a webpack bundle inside an isolated V8 context, where Jest's
  // instrumentation does not reach, so `test/temporal-workflow-coverage.ts` instruments
  // the bundle with `@temporalio/nyc-test-coverage` and merges the result into this run.
  // The workflow specs therefore count: deleting one lowers the number. The file is
  // deliberately **not** excluded, and the threshold is met with it left in.
  coverageThreshold: {
    global: { branches: 75, functions: 75, lines: 75, statements: 75 },
  },
  // Integration suites talk to a real database, a real broker and — for the
  // saga — a real Temporal test environment, which takes seconds to start.
  testTimeout: 120000,
};
