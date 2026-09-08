const swcOptions = require('../../jest.swc.cjs');
const swcTransform = { '^.+\.(t|j)s$': ['@swc/jest', swcOptions] };

const setupFiles = [require.resolve('./jest.setup.cjs')];

// Expressed relative to the **package** root, with `roots` naming the folder
// each project owns. economic-service learned this the hard way: a project
// whose `rootDir` is its own folder resolves `src/**` to `src/src/**`, nothing
// matches, and the coverage gate silently measures nothing.
//
// Nothing is excluded but the generated Prisma client and the process entry
// point. In particular the mapper, the repository and the consumer are all
// measured: excluding "adaptors" is how a service reports high coverage over
// the code that does the least.
const collectCoverageFrom = [
  'src/**/*.ts',
  '!src/**/*.spec.ts',
  '!src/generated/**',
  // The composition root. It listens on a socket and installs signal handlers,
  // so covering it would mean booting a server to assert nothing.
  '!src/main.ts',
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
      // Every suite under `test/` needs a real PostgreSQL, and the Kafka
      // suites additionally need a real broker. Neither is mocked: the
      // append-only guarantee lives in PostgreSQL privileges and triggers, and
      // a mock cannot refuse an UPDATE.
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
  // Kafka suites wait on real consumer-group joins and on replay from offset
  // zero, both of which are slow the first time a group is created.
  testTimeout: 120000,
  // `docs/14` § 14.2 puts this service in the 75% band, unchanged by AUD-001.
  // Set at the documented figure rather than at whatever the suite happens to
  // reach, so it measures the requirement and not the status quo.
  coverageThreshold: {
    global: { branches: 75, functions: 75, lines: 75, statements: 75 },
  },
};
