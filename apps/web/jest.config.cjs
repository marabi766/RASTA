const swcOptions = {
  jsc: {
    target: 'es2022',
    parser: { syntax: 'typescript', tsx: true, dynamicImport: true },
    transform: { react: { runtime: 'automatic' } },
  },
  module: { type: 'commonjs' },
};

/**
 * Jest for the browser workspace.
 *
 * `@swc/jest` options are passed explicitly for the same reason the root
 * `jest.swc.cjs` does it: SWC's own upward config search resolved differently
 * on a Linux runner than on the machines this was written on, and the failure
 * looked like a syntax error rather than a missing configuration (D-005).
 *
 * @type {import('jest').Config}
 */
module.exports = {
  displayName: 'web',
  rootDir: __dirname,
  testEnvironment: '<rootDir>/jest/web-api-environment.cjs',
  testEnvironmentOptions: { url: 'http://localhost:3200' },
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/src/**/*.spec.tsx'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '\\.css$': '<rootDir>/jest/style-stub.cjs',
  },
  transform: { '^.+\\.(t|j)sx?$': ['@swc/jest', swcOptions] },
  transformIgnorePatterns: ['/node_modules/(?!(oidc-client-ts)/)'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.spec.{ts,tsx}', '!src/test/**'],
  clearMocks: true,
  restoreMocks: true,
};
