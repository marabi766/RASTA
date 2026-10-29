// Closed reviewed registry: source/helper drift requires review of the declared launch boundaries.
export const JEST_LAUNCHERS = {
  'scripts/verify-test-independence.mjs': {
    kind: 'independence',
    reaches:
      'Package-local Jest binary; --selectProjects defaults to integration; whole-file and per-name runs differ only in test selection.',
    sha256: {
      'scripts/verify-test-independence.mjs':
        '0f9ca1aa3fee4606560fcbd8fe32ce9debe08a74e0010b85426bd9eb846db7ad',
    },
  },
  'scripts/aggregation-evidence.mjs': {
    kind: 'evidence',
    reaches:
      'runJestStep: identity Jest binary for named runs; pnpm run test:aggregation-stress -- --json for full-project/calibration runs. Both configurations checked.',
    sha256: {
      'scripts/aggregation-evidence.mjs':
        'ded2efeb35b4e08e45c27c7a1e747874c7833581b3bfd403ac73410f2003035c',
      'scripts/aggregation-evidence-lib.mjs':
        'cc332f3b7130d0befac22681474185be9f97eb879fff1189009244c04be2a1c7',
    },
  },
  'scripts/run-test-phases.mjs': {
    kind: 'phases',
    reaches:
      'Turbo workspace task; integration also selects identity test:aggregation-stress; arguments after -- reach both phases.',
    sha256: {
      'scripts/run-test-phases.mjs':
        'c8638166f4eda0bb04f98d94ef9bc960bdb10783dfe99637984780e637e59cb9',
      'scripts/test-phases-lib.mjs':
        'c55e4e7b1cd92787e2de1206574bde3be853b352726fed843d756b9c2ae2b54e',
    },
  },
  'scripts/aggregation-evidence-cli.test.mjs': {
    kind: 'non-jest',
    reaches:
      'CLI refusal controls and bounded subprocess lifecycle probes use Node -e; no real Jest launch.',
    sha256: {
      'scripts/aggregation-evidence-cli.test.mjs':
        'de69a5704053dac68aafe9e0943bd67a44b1586974e76a19cfd8b55c1886c1de',
      'scripts/aggregation-evidence.mjs':
        'ded2efeb35b4e08e45c27c7a1e747874c7833581b3bfd403ac73410f2003035c',
      'scripts/aggregation-evidence-lib.mjs':
        'cc332f3b7130d0befac22681474185be9f97eb879fff1189009244c04be2a1c7',
    },
  },
  'scripts/kafka-acl.broker.test.mjs': {
    kind: 'non-jest',
    reaches: 'Spawns Kafka/Docker tools; pnpm test strings are usage diagnostics, not executed.',
    sha256: {
      'scripts/kafka-acl.broker.test.mjs':
        'f4890cd53818a94d5911cb90f20d3c21abf0962a685b86ed73ec0654039bd4db',
    },
  },
  'scripts/no-zod-default-rule.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns this Node test file in --lint mode; jest.requireActual appears only in a lint fixture.',
    sha256: {
      'scripts/no-zod-default-rule.test.mjs':
        '2616ad4ce1e255a6af821c41caf36735b011eb6572b90f389484239b0a11d9b2',
    },
  },
  'scripts/test-phases.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns the orchestrator with no arguments to prove usage refusal; Jest commands are contract fixture strings.',
    sha256: {
      'scripts/test-phases.test.mjs':
        '4801b54dca9bfd6bd04ce59b6b956f183655d632f173debe9ee3dcfaeefca176',
      'scripts/run-test-phases.mjs':
        'c8638166f4eda0bb04f98d94ef9bc960bdb10783dfe99637984780e637e59cb9',
      'scripts/test-phases-lib.mjs':
        'c55e4e7b1cd92787e2de1206574bde3be853b352726fed843d756b9c2ae2b54e',
    },
  },
  'scripts/check-kafka-credential-scope.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns the credential export shell helper; pnpm test strings are YAML fixtures, not executed.',
    sha256: {
      'scripts/check-kafka-credential-scope.test.mjs':
        '47c1c5bf5f8020a845657f8f56e594c3f0195a030830fb24aca2edb08ac13863',
    },
  },
  'scripts/disposable-broker.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns Node broker-guard probes and pnpm test:kafka-limits-broker with the disposable declaration absent: exits before tests; no Jest.',
    sha256: {
      'scripts/disposable-broker.test.mjs':
        'f52656a48f260fae58277a8e26e101eb612cebe73a030b199a4cd61fa6fd3ede',
    },
  },
  'scripts/replay-dlq.broker.test.mjs': {
    kind: 'non-jest',
    reaches: 'Spawns the replay Node CLI and an inline Kafka transaction probe; no Jest.',
    sha256: {
      'scripts/replay-dlq.broker.test.mjs':
        '335fd8f0b9db69437598b51e042938522c8522682daad56558e7d01a307c0a9e',
    },
  },
  'scripts/outbox-purge-turbo-env.test.mjs': {
    kind: 'non-jest',
    reaches: 'Spawns pnpm dev with Turbo --dry=json; no test runner is executed.',
    sha256: {
      'scripts/outbox-purge-turbo-env.test.mjs':
        '218da511073b4eb7935bc4ac250ee8b76a310b1287fbc3ca6939a59c21507b19',
    },
  },
  'scripts/construction-turbo-env.test.mjs': {
    kind: 'non-jest',
    reaches: 'Spawns pnpm dev with Turbo --dry=json; no test runner is executed.',
    sha256: {
      'scripts/construction-turbo-env.test.mjs':
        '452122d232ab70da2d9816f93f8ac7f7e8af2af44dcda006e0811bdfbe60609d',
    },
  },
  'scripts/database-turbo-env.test.mjs': {
    kind: 'non-jest',
    reaches: 'Spawns pnpm dev with Turbo --dry=json; no test runner is executed.',
    sha256: {
      'scripts/database-turbo-env.test.mjs':
        '4a0ac5adf88137158ffd155892450f0f11f6e3b3bbed78710f2dc05e135ddd27',
    },
  },
  'scripts/service-env-turbo.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns pnpm/Turbo with --dry=json for service task environment inspection; no test runner is executed.',
    sha256: {
      'scripts/service-env-turbo.test.mjs':
        '576fc00222954d453db30b1159975e24889521544f1c68fe1516a674a1e02dde',
    },
  },
};
