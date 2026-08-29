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
  // Integration suites talk to a real database, a real broker and — for the
  // saga — a real Temporal test environment, which takes seconds to start.
  testTimeout: 120000,
};
