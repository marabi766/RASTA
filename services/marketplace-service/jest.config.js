const swcOptions = require('../../jest.swc.cjs');
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

/** @type {import('jest').Config} */
module.exports = {
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
  // `docs/14` § 14.2 puts this service in the 75% band. Until now that number
  // lived only in the document, so nothing failed when coverage fell below it
  // — and it had, to 40% branches. The gate is set at the documented figure
  // rather than at whatever the suite currently reaches, so it measures the
  // requirement and not the status quo.
  //
  // `src/temporal/workflows.ts` is counted here and is largely unmeasurable:
  // Temporal executes workflow code from a webpack bundle inside an isolated
  // V8 context, where Istanbul's instrumentation does not reach. Its 31
  // branches are therefore reported as uncovered even though
  // `workflows.spec.ts` executes them against a real time-skipping Temporal
  // server. It is deliberately **not** excluded: an exclusion would raise the
  // number by hiding a tooling limit, and would also hide the workflow itself
  // if its tests were ever deleted. The threshold is met with the file left in.
  coverageThreshold: {
    global: { branches: 75, functions: 75, lines: 75, statements: 75 },
  },
  // Integration suites talk to a real database, a real broker and — for the
  // saga — a real Temporal test environment, which takes seconds to start.
  testTimeout: 120000,
};
