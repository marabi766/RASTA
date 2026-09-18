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
  // Composition roots. `main.ts` is the process entry point — it listens on a
  // socket and installs signal handlers, so covering it would mean booting a
  // server to assert nothing. `app.module.ts` is a Nest metadata declaration
  // whose factories are exercised through the framework.
  '!src/main.ts',
  '!src/app.module.ts',
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
      // Every suite under `test/` needs a real PostgreSQL; the Kafka suites
      // additionally need a broker and skip visibly without one. Arrived with
      // NTF-001, exactly as the scaffold's comment said it would: there is now
      // a schema, a consumer and a worker for an integration suite to exercise,
      // and `--passWithNoTests` is deliberately absent so that deleting the
      // last test breaks the build rather than passing it.
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
