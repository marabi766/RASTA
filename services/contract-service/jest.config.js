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
  // The OpenAPI generator is a CLI entry point, like main.ts; what it writes is
  // proven byte for byte by openapi/document.spec.ts and test/openapi.int-spec.ts.
  '!src/openapi/generate.ts',
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
      // Every suite under `test/` needs a real PostgreSQL with this service's
      // migrations applied.
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
  // `docs/14` § 14.2 puts construction-service in the 85% band — a critical
  // domain (AGENTS.md § 7). Set at the documented figure rather than at
  // whatever the suite currently reaches, so it measures the requirement.
  coverageThreshold: {
    global: { branches: 85, functions: 85, lines: 85, statements: 85 },
  },
};
