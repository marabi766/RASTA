const swcOptions = require('../../jest.swc.cjs');

/** @type {import('jest').Config} */
module.exports = {
  displayName: require('./package.json').name,
  rootDir: 'src',
  testEnvironment: 'node',
  testRegex: '.*\.spec\.ts$',
  transform: { '^.+\.(t|j)s$': ['@swc/jest', swcOptions] },
  collectCoverageFrom: ['**/*.ts', '!**/*.spec.ts', '!**/index.ts', '!**/__tests__/**'],
  coverageDirectory: '../coverage',
  clearMocks: true,
};
