const swcTransform = { '^.+\\.(t|j)s$': ['@swc/jest'] };

/** @type {import('jest').Config} */
module.exports = {
  // Two projects, so `test:unit` stays fast and runnable without Docker while
  // integration tests — which need a real PostgreSQL — are opt-in.
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
      transform: swcTransform,
      clearMocks: true,
    },
  ],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/main.ts'],
  coverageDirectory: 'coverage',
  // Integration tests talk to a real database; the 5s default is far too short.
  testTimeout: 60000,
  coverageThreshold: {
    // identity is one of the two services held to a high bar (docs/14 § 14.2):
    // a coverage gap here is an authorization gap.
    global: { branches: 70, functions: 70, lines: 70, statements: 70 },
  },
};
