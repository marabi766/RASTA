/** @type {import('jest').Config} */
module.exports = {
  displayName: require('./package.json').name,
  rootDir: 'src',
  testEnvironment: 'node',
  testRegex: '.*\.spec\.ts$',
  transform: { '^.+\.(t|j)s$': ['@swc/jest'] },
  collectCoverageFrom: ['**/*.ts', '!**/*.spec.ts', '!**/index.ts'],
  coverageDirectory: '../coverage',
  clearMocks: true,
};
