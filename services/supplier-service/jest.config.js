const swcOptions = require('../../jest.swc.cjs');
const swcTransform = { '^.+\.(t|j)s$': ['@swc/jest', swcOptions] };

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
  // Test scaffolding that lives in `src/` because two suites share it. It has
  // no assertions and nothing outside a spec imports it, so measuring it would
  // report the tests' own helpers as production coverage.
  '!src/supplier/service-fakes.ts',
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
      // Every suite under `test/` needs a real PostgreSQL. None of them was run
      // in the phase that wrote them — see each file's header.
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
  testTimeout: 120000,
  // `docs/14` § 14.2 puts this service in the 75% band. Set at the documented
  // figure rather than at whatever the suite currently reaches, so it measures
  // the requirement and not the status quo.
  coverageThreshold: {
    global: { branches: 75, functions: 75, lines: 75, statements: 75 },
  },
};
