const swc = ['@swc/jest'];

/** @type {import('jest').Config} */
module.exports = {
  // Two projects so `test:unit` stays fast and runnable without Docker, while
  // integration tests (which need a real PostgreSQL) are opt-in.
  projects: [
    {
      displayName: 'unit',
      rootDir: 'src',
      testEnvironment: 'node',
      testRegex: '.*\.spec\.ts$',
      transform: { '^.+\.(t|j)s$': swc },
      clearMocks: true,
    },
    {
      displayName: 'integration',
      rootDir: 'test',
      testEnvironment: 'node',
      testRegex: '.*\.int-spec\.ts$',
      transform: { '^.+\.(t|j)s$': swc },
      testTimeout: 60000,
      clearMocks: true,
    },
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/generated/**',
    '!src/main.ts',
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    // identity is one of the two services held to 90% (docs/14 § 14.2):
    // a gap here is an authorization gap.
    global: { branches: 80, functions: 85, lines: 90, statements: 90 },
  },
};
