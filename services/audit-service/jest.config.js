const swcOptions = require('../../jest.swc.cjs');
const swcTransform = { '^.+\.(t|j)s$': ['@swc/jest', swcOptions] };

const setupFiles = [require.resolve('./jest.setup.cjs')];

// Expressed relative to the **package** root, with `roots` naming the folder the
// project owns. economic-service learned this the hard way: a project whose
// `rootDir` is its own folder resolves `src/**` to `src/src/**`, nothing
// matches, and the coverage gate silently measures nothing.
const collectCoverageFrom = [
  'src/**/*.ts',
  '!src/**/*.spec.ts',
  // Composition roots. `main.ts` is the process entry point — it listens on a
  // socket and installs signal handlers, so covering it would mean booting a
  // server to assert nothing. `app.module.ts` is a Nest metadata declaration
  // whose factories are exercised through the framework in an integration test
  // this service does not have yet.
  '!src/main.ts',
  '!src/app.module.ts',
];

/** @type {import('jest').Config} */
module.exports = {
  // One project, not two. Every other service declares an `integration` project
  // alongside `unit`; this service has no `test/` directory because it owns no
  // database, no consumer and no HTTP surface beyond the health probes — so
  // there is nothing an integration suite could exercise that the unit suite
  // does not. Declaring an empty project would need `--passWithNoTests`, which
  // is how a gate starts reporting green for running nothing.
  //
  // AUD-001 adds the schema and the consumer, and the `integration` project
  // arrives with them.
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
  ],
  collectCoverageFrom,
  coverageDirectory: 'coverage',
  testTimeout: 30000,
  // `docs/14` § 14.2 puts this service in the 75% band. Set at the documented
  // figure rather than at whatever this scaffold happens to reach, so it
  // measures the requirement and not the status quo.
  coverageThreshold: {
    global: { branches: 75, functions: 75, lines: 75, statements: 75 },
  },
};
