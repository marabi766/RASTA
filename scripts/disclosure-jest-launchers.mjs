// Closed reviewed registry: source/helper drift requires review of the declared launch boundaries.
export const JEST_LAUNCHERS = {
  'scripts/ci-tool-download.test.mjs': {
    kind: 'non-jest',
    workflowSteps: {
      file: '.github/workflows/ci.yml',
      job: 'security',
      names: ['Test pinned Gitleaks scan topologies', 'Secret scan'],
      sha256: 'cbe89eeb29efa1fd90d6f6cde75a21d01227140567c1018f1f6766496d0cdb40',
    },
    reaches:
      'Node tests spawn curl/Git and the pinned Gitleaks binary, plus the exact pinned Secret scan shell in isolated Git fixtures; downloads are mocked except a loopback curl probe. No Jest, pnpm or Turbo child.',
    sha256: {
      'scripts/ci-tool-download.test.mjs':
        '430d053397e935ccb36d79cafd2a1d1df305cfe8fa023d1f0e163365796e9109',
      'scripts/ci-tool-download.mjs':
        '0e9a7d8bcbf35ae61d822c0e4af8f4d8d94960195131145e540190ed4e23607b',
      'scripts/fixture-git-env.mjs':
        '0b60132dc4c925129b0f29fe1ef86e5717ae8616e78171d65b58a71404d77391',
      'scripts/authored-source-inventory.cjs':
        '0b5d93cff1bf3868a9de93166d3d669d97099409e6affac231993066f749e65a',
    },
  },
  'scripts/verify-migration-reversible-lib.test.mjs': {
    kind: 'non-jest',
    reaches:
      'node:test only: spawnSync is intercepted (recorded, not run) for the psql URL refusal checks; real children are psql, Node helper scripts (psql-prisma-url, verify-seed-guard) and bash workflow steps with a recording fake node on PATH. No Jest, pnpm or turbo launch.',
    sha256: {
      'scripts/verify-migration-reversible-lib.test.mjs':
        'dc9985598eb7b2ecdfb748d798989ff11572dacda52121439ef846f5693eb00b',
      'scripts/verify-migration-reversible-lib.mjs':
        '0067015a5bcb27a12c0b53dda76517bc02fea5d402e82bfd5ffab924ca88751c',
      'scripts/psql-prisma-url.mjs':
        '3e1f5eebfe297d80dbd539629a114610d6a2e6401ea4b697c2d0e8b1ecacbb58',
    },
  },
  'scripts/prepush-scope.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Git fixture commands and Node environment probe; Turbo selection is mocked or --dry=json and missing-binary refusal never enters its JS launcher. No Jest or task execution.',
    sha256: {
      'scripts/prepush-scope.test.mjs':
        '0b4a445f1f742b33b051723952b7d8ee74bd76648ef1e3c80e5a2a63aaf7028a',
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
        '4c9fde73cd620b61e184ac77da19e331cdb55d13f2f8ed5bbab2ed5d9c1a5fbe',
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
        '2b51ab3aed7f785f404179fd467422cc6dd16b7858e6c2af4447200e5fbc046b',
      'scripts/run-test-phases.mjs':
        'c4d7ce726aecbb3bd33416c7aad724bb2687354124a957bd13d98a17112da09f',
      'scripts/test-phases-lib.mjs':
        '4c9fde73cd620b61e184ac77da19e331cdb55d13f2f8ed5bbab2ed5d9c1a5fbe',
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
      'Spawns copied Node concurrency-checker CLI against temporary YAML/package fixtures; shell-semantics probes run bash -c with echo-only node/pnpm shims, real node on /dev/null (env-file probes) and the repo pnpm on a temporary manifest whose only script is echo. Jest/pnpm test/Node preload examples remain inert fixtures, never executed. Workspace manifests are listed through authoredFiles() (read-only git ls-files).',
    sha256: {
      'scripts/ci-shell-text-lib.mjs':
        'dba3e1b238617ba8e082efa309209e2330acc22215d25ab4831223a6c16f29ce',
      'scripts/ci-node-test-timeouts-lib.mjs':
        '95c6254728b8b24be9f420aa88cce517285e997543bcd46c1f409124c6445d06',
      'scripts/check-unit-step-concurrency.test.mjs':
        'e395fd8ef12cdc6910fa34b30dc18326fa5a6368d5d97a075704c0a95491c4a2',
      'scripts/check-unit-step-concurrency.mjs':
        'b1dc69abcb7db76eccba8f43066731549b9a07e3a1d252cdf032c7489eff62e1',
      'scripts/check-unit-step-concurrency-lib.mjs':
        '34b0d346f234bf0a529d5541ae09f3801c5c756d41cc51ae97deffc9e5910a78',
    },
  },
  'scripts/exchange-deadline-rule.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns ESLint with stdin fixtures; Jest references are rule fixtures, never a Jest launch.',
    sha256: {
      'scripts/exchange-deadline-rule.test.mjs':
        'c744d65515dff65bc511c293445a6deb56b696aac675e9151c5fe1594e9e8dc0',
    },
  },
  'scripts/ci-integration-split.test.mjs': {
    kind: 'empty-unit-probe',
    reaches:
      'Spawns git/pnpm workspace fixtures and asset Jest with runInBand. The pinned zero-match probe derives the real asset config, preserving setupFilesAfterEnv; only roots and unit testRegex change. No CLI argument reaches the child.',
    sha256: {
      'scripts/ci-integration-split.test.mjs':
        '0bb9440a4ec8bdd191707c8853a32315d0ba2c8cf4d5bf468830c4388d49d14a',
      'scripts/ci-integration-split-lib.mjs':
        '04916b838e43eaff29e95e14960b0e95f058b7401c9e68f3c1d3211c844f495c',
      'scripts/workspace-roots-lib.mjs':
        'a66c5944fb6137f9952b0aa46752d28587c700f5f98baaa9b9ecf8f108313e07',
    },
  },
  'scripts/raw-http-boundary-rule.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns Node ESLint config/fixture probes and scrubbed Git commands; subprocess API names in the AST guard are inspection fixtures, never Jest launches.',
    sha256: {
      'scripts/raw-http-boundary-rule.test.mjs':
        '0fc73411df345bb59bdd68b645f51a2948e7f3d7199bac6d382d058be04dae9d',
      'scripts/source-inventory.mjs':
        'd130e1e0d7cfda45d547f088d6b1a8eb346a927d6c0c25fca5bdb675be3ba39c',
      'scripts/fixture-git-env.mjs':
        '0b60132dc4c925129b0f29fe1ef86e5717ae8616e78171d65b58a71404d77391',
    },
  },
  'scripts/testing-dev-only.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns offline pnpm install, production dependency graph queries and Node checker probes; no Jest launch.',
    sha256: {
      'scripts/fixture-git-env.mjs':
        '0b60132dc4c925129b0f29fe1ef86e5717ae8616e78171d65b58a71404d77391',
      'scripts/testing-dev-only.test.mjs':
        '70322e435d9e0f736c7189e0c5808388ab6d5f54673b474671172bfa7933f6b9',
      'scripts/testing-dev-only.mjs':
        '208d2c5102acfc44d932880f86a5c0809de9e10c1d6633cb89bc662373f5b155',
      'scripts/testing-dev-only-source.mjs':
        '3466c4f1a151720eedbe2bdc4550503bf100695027f871aeae95bb0225c6bd08',
    },
  },
  'scripts/lint-scripts-registration.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns git fixture commands and Turbo lint --dry=json snapshots; test runner names are registration fixtures, never executed.',
    sha256: {
      'scripts/fixture-git-env.mjs':
        '0b60132dc4c925129b0f29fe1ef86e5717ae8616e78171d65b58a71404d77391',
      'scripts/lint-scripts-registration.test.mjs':
        'a80cfef328904aeabc6b8d4fff0b208ef93d7c9bac7ed50aa9714062226b38c6',
    },
  },
  'scripts/testing-dev-only.mjs': {
    kind: 'non-jest',
    inertArguments: true, // `image "$IMAGE"` / `tree <dir> <file>`: arguments name an image or a path
    reaches:
      'Spawns pnpm list --prod, docker image save/inspect and tar helpers through one run(command, args) wrapper whose callers pass literal commands; never Jest or a test script.',
    sha256: {
      'scripts/testing-dev-only.mjs':
        '208d2c5102acfc44d932880f86a5c0809de9e10c1d6633cb89bc662373f5b155',
    },
  },
  'scripts/supplier-privilege-split.pg.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns psql, the Prisma CLI (migrate deploy) and bash on the supplier split script against a scratch PostgreSQL; the commands are literal at every call. No Jest.',
    sha256: {
      'scripts/supplier-privilege-split.pg.test.mjs':
        'c12ce177b3d1263e274d14dc58d64c75878bdce15dd941d7a7d7aceb30a77f69',
    },
  },
  'scripts/service-privilege-split-end-state.pg.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns psql and bash against a scratch PostgreSQL (one injected spawn wrapper only rewrites a psql connection string); no Jest or test-script launch.',
    sha256: {
      'scripts/service-privilege-split-end-state.pg.test.mjs':
        'e9cd41fc43710c141b72cdf1e7a54d693a5626937c30656860f4c67cda43f115',
    },
  },
  'scripts/check-db-runtime-privileges.pg.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns psql, bash scripts and the Prisma CLI (migrate deploy) against a scratch PostgreSQL; the commands are literal at every call. No Jest.',
    sha256: {
      'scripts/check-db-runtime-privileges.pg.test.mjs':
        '10a179c9d24669bca20775371ea987f94567f4ecbafb3ff3d87607bd391ce956',
    },
  },
  'scripts/backup-restore-drill.pg.test.mjs': {
    kind: 'non-jest',
    reaches:
      'Spawns psql, pg_dump and pg_restore through command(name, args); every caller passes one of those literals. No Jest or test-script launch.',
    sha256: {
      'scripts/backup-restore-drill.pg.test.mjs':
        '83c8c84247384bd7f0c255a2d9e95c6bff2ff59c4095afece86490bd676b4b59',
    },
  },
};
