const swcOptions = require('../../jest.swc.cjs');
const swcTransform = { '^.+\\.(t|j)s$': ['@swc/jest', swcOptions] };

// The aggregation spec's two 500-write proofs serialize on one hot row, so
// their pace is the database's commit latency. Beside every other service's
// integration suite on the same PostgreSQL they measured that load instead —
// a `57014` statement timeout, a burst crossing its 60 s window. So the spec
// has a project of its own, which only `test:aggregation-stress` selects, and
// the root orchestrator runs that once, after the parallel workspace phase
// (`scripts/test-phases-lib.mjs`, `docs/14` § 14.3).
const AGGREGATION_STRESS_SPEC = 'security-event-aggregation\\.int-spec\\.ts$';

/** @type {import('jest').Config} */
module.exports = {
  // `test:unit` stays fast and runnable without Docker while integration tests
  // — which need a real PostgreSQL — are opt-in. Every package script names the
  // projects it selects; a bare `jest` runs all three.
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
      testPathIgnorePatterns: ['/node_modules/', AGGREGATION_STRESS_SPEC],
      transform: swcTransform,
      clearMocks: true,
    },
    {
      displayName: 'aggregation-stress',
      rootDir: 'test',
      testEnvironment: 'node',
      testRegex: AGGREGATION_STRESS_SPEC,
      transform: swcTransform,
      clearMocks: true,
    },
  ],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/generated/**', '!src/main.ts'],
  coverageDirectory: 'coverage',
  // Integration tests talk to a real database; the 5s default is far too short.
  testTimeout: 60000,
  coverageThreshold: {
    // identity is one of the two services held to a high bar (docs/14 § 14.2):
    // a coverage gap here is an authorization gap.
    global: { branches: 70, functions: 70, lines: 70, statements: 70 },
  },
};
