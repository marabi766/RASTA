const swcOptions = require('../../jest.swc.cjs');
const swcTransform = { '^.+\\.(t|j)s$': ['@swc/jest', swcOptions] };

// Expressed relative to the **package** root, with `roots` naming the folder
// each project owns. economic-service learned this the hard way: a project
// whose `rootDir` is its own folder resolves `src/**` to `src/src/**`, nothing
// matches, and the coverage gate silently measures nothing. Here it measured
// 0% over 95 passing tests and the 70% threshold below never had a chance to
// fail.
const collectCoverageFrom = [
  'src/**/*.ts',
  '!src/**/*.spec.ts',
  '!src/generated/**',
  '!src/main.ts',
];

/** @type {import('jest').Config} */
module.exports = {
  // Two projects, so `test:unit` stays fast and runnable without Docker while
  // integration tests — which need a real PostgreSQL — are opt-in.
  projects: [
    {
      displayName: 'unit',
      rootDir: __dirname,
      roots: ['<rootDir>/src'],
      testEnvironment: 'node',
      testRegex: '.*\\.spec\\.ts$',
      transform: swcTransform,
      clearMocks: true,
      collectCoverageFrom,
    },
    {
      displayName: 'integration',
      rootDir: __dirname,
      roots: ['<rootDir>/test'],
      testEnvironment: 'node',
      testRegex: '.*\\.int-spec\\.ts$',
      transform: swcTransform,
      clearMocks: true,
      collectCoverageFrom,
    },
  ],
  collectCoverageFrom,
  coverageDirectory: 'coverage',
  // Integration tests talk to a real database; the 5s default is far too short.
  testTimeout: 60000,
  coverageThreshold: {
    global: { branches: 70, functions: 70, lines: 70, statements: 70 },
  },
};
