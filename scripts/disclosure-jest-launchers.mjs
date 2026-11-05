// Closed reviewed registry: source/helper drift requires review of the declared launch boundaries.
export const JEST_LAUNCHERS = {
  'scripts/prepush-scope.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Git fixture commands and Node environment probe; Turbo selection is mocked or --dry=json and missing-binary refusal never enters its JS launcher. No Jest or task execution.',
    sha256: {
      'scripts/prepush-scope.test.mjs':
        '4f9d1329d3d25f39f4c558cbee2e1162098fc9514ce04e7f11e0f8f12552f07e',
      'scripts/prepush-scope-lib.mjs':
        'a7cb60ff2283945e9eee8a7bc9b83cbe05cdb680af0ea74e54afc561f3e66e13',
    },
  },
  'scripts/verify-test-independence.mjs': {
    kind: 'independence',
    reaches:
      'Package-local Jest binary; --selectProjects defaults to integration; whole-file and per-name runs differ only in test selection.',
    sha256: {
      'scripts/verify-test-independence.mjs':
        '73cdc9c671360b4d144a1fa8c1f29986db1647fd8faa1d13be519e8704ccb28d',
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
      'Pinned phase planner expands exact positive shard ownership; only unsharded/identity integration adds stress. CLI arguments after -- reach every selected Jest descendant.',
    sha256: {
      'scripts/integration-partitions.mjs':
        'd593876d547a32a50cc030ccf345f9d153c529eeae54d1dbf11138aef5ac3f7c',
      'scripts/run-test-phases.mjs':
        'c4d7ce726aecbb3bd33416c7aad724bb2687354124a957bd13d98a17112da09f',
      'scripts/test-phases-lib.mjs':
        '4da467fa6be27f98cef54a1161ac1ef68321e3f56ffb697b2ec9565f6cd5c1c5',
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
        '084f45efeeedb4a2ec1ebba2167cfa423fdf920414c25f8334fe36462431872d',
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
      'Spawns the Node contract checker and a copied orchestrator against a fixture-owned fake Turbo that only records argv/exits; malformed shard ownership refuses before spawning. No real Jest or forwarded CLI config.',
    sha256: {
      'scripts/integration-partitions.mjs':
        'd593876d547a32a50cc030ccf345f9d153c529eeae54d1dbf11138aef5ac3f7c',
      'scripts/test-phases.test.mjs':
        'f9343feabd3e2fc1977ac04edff8b135a2011ce9dafb3c52792d23680c52bacd',
      'scripts/run-test-phases.mjs':
        'c4d7ce726aecbb3bd33416c7aad724bb2687354124a957bd13d98a17112da09f',
      'scripts/test-phases-lib.mjs':
        '4da467fa6be27f98cef54a1161ac1ef68321e3f56ffb697b2ec9565f6cd5c1c5',
    },
  },
  'scripts/check-kafka-credential-scope.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns the credential export shell helper; pnpm test strings are YAML fixtures, not executed.',
    sha256: {
      'scripts/check-kafka-credential-scope.test.mjs':
        'a7feee1c004f4091369ff9baa8618dd1a3cc5c5cfd30486e129b9a3daa56e8f5',
    },
  },
  'scripts/disposable-broker.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns Node broker-guard probes and pnpm test:kafka-limits-broker, test:replay-dlq-broker and test:kafka-acl-broker with invalid disposable declarations: exits before broker I/O; no Jest.',
    sha256: {
      'scripts/disposable-broker.test.mjs':
        'b587bfa1392097490cbb847a835809d93a7a51ce5dde6adc029ab0beb4fddaf9',
    },
  },
  'scripts/replay-dlq.broker.test.mjs': {
    kind: 'non-jest',
    reaches: 'Spawns the replay Node CLI and an inline Kafka transaction probe; no Jest.',
    sha256: {
      'scripts/replay-dlq.broker.test.mjs':
        '148568b06c5edb894d5b6359dc3b6cdbd3095c1162ec53cd68b6eb0b3e7680a1',
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
  'scripts/check-unit-step-concurrency.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns copied Node concurrency-checker CLI against temporary YAML/package fixtures; the added timeout helper only parses command strings. Jest/pnpm test/Node preload examples remain inert fixtures, never executed.',
    sha256: {
      'scripts/ci-node-test-timeouts-lib.mjs':
        '73f4adbb236d634ff18c58c513eedae4988f66e1f6854f14ccd3c076b0ace679',
      'scripts/check-unit-step-concurrency.test.mjs':
        '08458ba01284f457a712c4189210c0ea2397e9ba221cd54d2bdb2f6b4a06c96d',
      'scripts/check-unit-step-concurrency.mjs':
        'b1dc69abcb7db76eccba8f43066731549b9a07e3a1d252cdf032c7489eff62e1',
      'scripts/check-unit-step-concurrency-lib.mjs':
        '67bd3962244fdf7c909bfb93ce1f07d7ab3643203570f87d3af1d36900ee8795',
    },
  },
  'scripts/exchange-deadline-rule.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns ESLint with stdin fixtures; Jest references are rule fixtures, never a Jest launch.',
    sha256: {
      'scripts/exchange-deadline-rule.test.mjs':
        '98a8954bc4da52dee4cbcf512b51a868dd1371f859121f1aadcb9e9f2a2f84e6',
    },
  },
  'scripts/ci-integration-split.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns git status --porcelain and pnpm ls -r --json against temporary workspace fixtures; jest appears only as fixture script text, never executed.',
    sha256: {
      'scripts/ci-integration-split.test.mjs':
        '0273cb3f7e2e7379c84e22fb3a288c07a4a43bc483108452c192314f73b0f4ab',
      'scripts/ci-integration-split-lib.mjs':
        'fdce9bdfac074267f1fc26702ed9af73d9911f94f00a599ddc5d5def2a6912fe',
      'scripts/workspace-roots-lib.mjs':
        '4da347ee566298cb7b2f3aea50d1c69d338983b74f610b85ac7cee4a7282e634',
    },
  },
  'scripts/testing-dev-only.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns offline pnpm install, production dependency graph queries and Node checker probes; no Jest launch.',
    sha256: {
      'scripts/testing-dev-only.test.mjs':
        '7e5223788548f0e6b7fc16366fbd39e735bc8b53c33a215116f4676f7d3b27c6',
      'scripts/testing-dev-only.mjs':
        '208d2c5102acfc44d932880f86a5c0809de9e10c1d6633cb89bc662373f5b155',
      'scripts/testing-dev-only-source.mjs':
        'b979685cd3f2c003c53fbe9de8f4c739e72244b36087fd96b24ec1954ce14675',
    },
  },
  'scripts/lint-scripts-registration.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns git fixture commands and Turbo lint --dry=json snapshots; test runner names are registration fixtures, never executed.',
    sha256: {
      'scripts/lint-scripts-registration.test.mjs':
        '90f8b760685f446aa47d26ea57690220b35c87e73c38b02825098d6e1ff3e7a6',
    },
  },
};
