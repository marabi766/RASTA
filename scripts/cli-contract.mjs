// -----------------------------------------------------------------------------
// The command-line contract (#385 r6, Codex PR-385 r5 F2).
//
// Configuration that carries a secret or says where to connect arrives through
// the environment, never on the command line: that is what lets a script
// repeat its arguments, and keeps them out of `ps`. This file says it
// explicitly, per file, rather than guessing from option names:
//
//   accepts      the options the file reads from its own command line, each
//                with the kind of value it takes (VALUE_KINDS — a closed set
//                with no URL and no credential in it);
//   positionals  what its positional arguments are, by kind;
//   other        every other string it spells like an option: options it
//                passes to another program (psql, docker, git, jest), and
//                strings that only look like one (a `-service` suffix, a CSS
//                variable). Reading one of them from its own command line
//                would be a new accepted option, and belongs in `accepts`.
//
// url-parsing-guard.test.mjs holds every scanned file to it: a file that reads
// its command line or spells an option must be listed here, with exactly the
// options it spells; an accepted option may not be named like a credential
// (`namesCredential`); a listed file that no longer matches is stale.
//
// Echoing: a refusal repeats a value only after it matched its closed list
// (a service of EXPECTED, a topic of topics.txt, an option of the switch);
// anything else is refused by the option's name or the argument's position.
// config-disclosure.test.mjs runs the CLIs that echoed one with sentinels.
// -----------------------------------------------------------------------------

/** What an accepted option or positional takes. None is a URL or a credential. */
export const VALUE_KINDS = Object.freeze({
  switch: 'takes no value',
  integer: 'digits, range-checked; refused by name otherwise',
  enum: 'one of a closed list the script holds; refused by name otherwise',
  identifier: 'checked against a pattern or a closed list; refused by name otherwise',
  sha: 'a full commit id (40 hex digits), checked',
  topic: 'a Kafka topic, matched against topics.txt; refused by name otherwise',
  path: 'a file or directory the operator chose; read, never repeated',
  forwarded: 'passed, unread and unprinted, to another program (prisma, jest)',
  script: "process.argv[1], the script's own path: only compared, never printed",
});

/** Options passed to another program whose name looks like a credential's, and why each is not one. */
export const OTHER_NAMED_LIKE_CREDENTIALS = Object.freeze({
  '--restrict-key':
    "pg_dump/psql's \\restrict key: a random value the drill generates per dump, not configuration",
  '--passWithNoTests': "jest's option: `pass` as in a passing run",
  '--add-host': 'docker run options the Dockerfile-pins check recognises in files, never passed',
  '--host': 'docker CLI options the Dockerfile-pins check recognises in files, never passed',
});

const PRETTIER = ['--parser', '--stdin-filepath'];

/** @type {Readonly<Record<string, { accepts?: Record<string, string>, positionals?: string[], other?: string[] }>>} */
export const CLI_CONTRACT = Object.freeze({
  // --- apps -----------------------------------------------------------------
  'apps/web/e2e/contract-fixture.ts': { other: ['-X', '-f', '-q', '-v'] },
  // The build's preload puts itself into every child's NODE_OPTIONS / execArgv (`--require`);
  // it reads no command line.
  'apps/web/scripts/capture-next-config.cjs': { other: ['--require'] },
  'apps/web/src/app/fonts.ts': { other: ['--font-vazirmatn'] },
  // Test helper of the build-binding specs: runs the build scripts in a child Node.
  'apps/web/src/test/build-scripts.ts': { other: ['--input-type', '-e'] },

  // --- packages: test fixtures run by their specs ----------------------------
  // The stock-zod oracle's build child (PR #444 r4): its input arrives on stdin.
  'packages/contracts/src/common/__tests__/zod-stock-oracle.ts': { other: ['--no-warnings', '-e'] },
  'packages/nest-common/src/__tests__/correlated-logs.fixture.ts': {
    positionals: ['path', 'enum'],
  },
  'packages/nest-common/src/__tests__/otel-log-stream.fixture.ts': { positionals: ['path'] },
  'packages/nest-common/src/consumer/event-consumer.ts': { other: ['-service'] },
  'packages/observability/src/__tests__/diagnostics.fixture.ts': { positionals: ['enum'] },
  'packages/observability/src/__tests__/exporter-selection.fixture.ts': { positionals: ['enum'] },
  'packages/observability/src/__tests__/telemetry-boundary.fixture.ts': {
    positionals: ['enum', 'identifier'],
  },

  // --- scripts ----------------------------------------------------------------
  'scripts/aggregation-campaign-accounting.mjs': {
    accepts: { '--reports-manifest': 'path' },
    positionals: ['path'],
  },
  'scripts/aggregation-campaign-image-cohort.mjs': {
    accepts: { '--reports-manifest': 'path' },
    positionals: ['path', 'path'],
  },
  'scripts/aggregation-campaign-log-recovery.mjs': {
    accepts: { '--logs-manifest': 'path', '--output-dir': 'path' },
    positionals: ['path'],
  },
  'scripts/aggregation-campaign-preflight.mjs': { positionals: ['path', 'path', 'path'] },
  'scripts/aggregation-campaign-retrieval-comparison.mjs': {
    positionals: ['path'],
    accepts: {
      '--artifacts': 'path',
      '--artifacts-manifest': 'path',
      '--fallback': 'path',
      '--fallback-manifest': 'path',
    },
  },
  // The campaign workflow's own command line, checked as text in a workflow file.
  'scripts/aggregation-campaign-workflow-lib.mjs': { other: ['--pairs', '--slot'] },
  'scripts/aggregation-campaign-workflow.mjs': { positionals: ['path'] },
  'scripts/aggregation-evidence-lib.mjs': {
    accepts: { '--calibrate': 'switch', '--pairs': 'integer', '--slot': 'integer' },
    positionals: ['path'],
    other: [
      '--json',
      '--passWithNoTests',
      '--runInBand',
      '--selectProjects',
      '--testNamePattern',
      '-P',
      '-T',
      '-c',
      '-f',
      '-j',
      '-n',
      '-t',
    ],
  },
  'scripts/aggregation-evidence.mjs': {
    positionals: ['path'],
    other: [
      '--format',
      '--name',
      '--network',
      '--rm',
      '--signal',
      '-A',
      '-X',
      '-c',
      '-e',
      '-f',
      '-i',
      '-q',
      '-t',
      '-v',
    ],
  },
  'scripts/backup-restore-drill-lib.mjs': {
    other: ['--encoding', '--format', '--quote-all-identifiers', '--schema-only', '-service'],
  },
  'scripts/backup-restore-drill.mjs': {
    positionals: [],
    accepts: { '--report': 'path' },
    other: [
      '--concurrency',
      '--create',
      '--exit-on-error',
      '--file',
      '--filter',
      '--help',
      '--project-name',
      '--quiet',
      '--restrict-key',
      '--timeout',
      '--version',
      '--volumes',
      '--wait',
      '--wait-timeout',
      '-Fc',
      '-qAt',
      '-source',
      '-U',
      '-X',
      '-a',
      '-d',
      '-i',
      '-q',
      '-v',
    ],
  },
  'scripts/check-db-runtime-privileges.mjs': { other: ['-X', '-d', '-q', '-tA', '-v'] },
  // Docker command lines read from Dockerfiles and compose files, never run.
  'scripts/check-dockerfile-pins-lib.mjs': {
    other: [
      '--add-host',
      '--all-tags',
      '--cap-add',
      '--cap-drop',
      '--config',
      '--context',
      '--cpus',
      '--debug',
      '--detach',
      '--device',
      '--entrypoint',
      '--env',
      '--env-file',
      '--file',
      '--health-cmd',
      '--host',
      '--hostname',
      '--init',
      '--interactive',
      '--label',
      '--log-level',
      '--memory',
      '--mount',
      '--name',
      '--net',
      '--network',
      '--platform',
      '--publish',
      '--pull',
      '--quiet',
      '--read-only',
      '--restart',
      '--rm',
      '--security-opt',
      '--shm-size',
      '--tls',
      '--tlsverify',
      '--tmpfs',
      '--tty',
      '--ulimit',
      '--user',
      '--volume',
      '--workdir',
      '-D',
      '-H',
      '-a',
      '-c',
      '-d',
      '-e',
      '-f',
      '-h',
      '-i',
      '-it',
      '-l',
      '-m',
      '-p',
      '-q',
      '-t',
      '-u',
      '-v',
      '-w',
    ],
  },
  'scripts/check-grafana-dashboard.mjs': { positionals: [], accepts: { '--root': 'path' } },
  'scripts/check-kafka-credential-scope.mjs': { other: ['-service'] },
  'scripts/check-kafka-topic-limits.mjs': { positionals: ['path'] },
  'scripts/check-keycloak-dev-realm-lib.mjs': { other: ['--import-realm'] },
  'scripts/check-local-postgres-config.mjs': { positionals: [], accepts: { '--file': 'path' } },
  'scripts/check-service-boundaries.mjs': { positionals: [], accepts: { '--root': 'path' } },
  'scripts/check-test-phases.mjs': { positionals: ['script'] },
  'scripts/ci-image-matrix.mjs': { other: ['--all'] },
  'scripts/ci-integration-split-lib.mjs': { other: ['--noprofile', '--norc', '-eo'] },
  'scripts/ci-migration-reversibility-lib.mjs': { other: ['--noprofile', '--norc', '-eo'] },
  'scripts/container-scope-proof.mjs': {
    other: ['--test', '--test-name-pattern', '--test-reporter'],
  },
  'scripts/container-scope.mjs': {
    positionals: [],
    accepts: { '--all': 'switch', '--base': 'sha' },
    other: ['--name-only', '--no-renames', '-C', '-e', '-z'],
  },
  'scripts/database-services.mjs': { other: ['-service'] },
  'scripts/disposable-broker.mjs': { positionals: ['script'] },
  'scripts/infra-preflight-lib.mjs': { other: ['-service'] },
  'scripts/kafka-acl.mjs': { accepts: { '--profile': 'enum' }, positionals: ['enum'] },
  'scripts/kafka-outbox-tables.mjs': { positionals: ['script'] },
  // `temporal workflow` options; the address is TEMPORAL_ADDRESS's, never an argument here.
  'scripts/marketplace-saga-drain-check.mjs': {
    other: [
      '--address',
      '--namespace',
      '--output',
      '--query',
      '--run-id',
      '--task-queue',
      '--workflow-id',
    ],
  },
  'scripts/outbox-b2-backfill.mjs': { positionals: [] },
  'scripts/outbox-b2-lib.mjs': {
    accepts: {
      '--all': 'switch',
      '--apply': 'switch',
      '--batch-size': 'integer',
      '--dry-run': 'switch',
      '--max-batches': 'integer',
      '--service': 'identifier',
      '--vacuum-every': 'integer',
    },
  },
  'scripts/outbox-b2-vacuum.mjs': {
    positionals: [],
    accepts: { '--all': 'switch', '--service': 'identifier' },
  },
  'scripts/prisma.mjs': { positionals: ['forwarded'], other: ['--schema', '--stdin'] },
  'scripts/progress.mjs': { positionals: ['enum'] },
  'scripts/replay-dlq-lib.mjs': {
    accepts: {
      '--allow-stale': 'identifier',
      '--check-marker': 'identifier',
      '--dlq': 'topic',
      '--event-id': 'identifier',
      '--execute': 'switch',
      '--expect-count': 'integer',
      '--from-offset': 'integer',
      '--max': 'integer',
      '--offset': 'integer',
      '--partition': 'integer',
      '--replayed-at': 'identifier',
      '--report': 'path',
      '--to-offset': 'integer',
      '--topic': 'topic',
    },
  },
  'scripts/replay-dlq.mjs': { positionals: [], accepts: { '--check-marker': 'identifier' } },
  'scripts/run-test-phases.mjs': { positionals: ['enum', 'forwarded'] },
  'scripts/runtime-preflight.e2e.mjs': { positionals: ['enum', 'enum'] },
  'scripts/service-env-withheld-base.mjs': {
    positionals: ['script'],
    other: ['--depth', '--no-tags', '--quiet', '--verify'],
  },
  'scripts/test-phases-lib.mjs': {
    accepts: { '--calibrate': 'switch', '--pairs': 'integer' },
    other: ['--passWithNoTests', '--runInBand', '--selectProjects', '--testNamePattern'],
  },
  'scripts/verify-audit-correction-command-migration.mjs': {
    positionals: [],
    accepts: { '--schema': 'identifier' },
    other: ['--stdin'],
  },
  'scripts/verify-grafana-dashboard-isolation-lib.mjs': { other: ['--internal'] },
  'scripts/verify-grafana-dashboard-live.mjs': {
    positionals: ['script'],
    other: [
      '--attach',
      '--cap-drop',
      '--config.file',
      '--filter',
      '--format',
      '--name',
      '--network',
      '--network-alias',
      '--pull',
      '--read-only',
      '--security-opt',
      '--tail',
      '--user',
      '-a',
      '-d',
      '-e',
      '-f',
      '-v',
      '-w',
    ],
  },
  'scripts/verify-migration-reversible-lib.mjs': {
    other: ['--file', '--single-transaction', '-At', '-X', '-c', '-q', '-v'],
  },
  'scripts/verify-migration-reversible.mjs': {
    accepts: { '--schema': 'identifier' },
    positionals: ['identifier'],
    other: ['--rolled-back', '--stdin'],
  },
  'scripts/verify-outbox-claim-migration.mjs': {
    accepts: { '--in-place': 'switch', '--schema': 'identifier' },
    positionals: ['identifier'],
    other: ['--stdin', '-service'],
  },
  'scripts/verify-security-event-outbox-migration.mjs': {
    positionals: [],
    accepts: { '--schema': 'identifier' },
    other: ['--stdin'],
  },
  'scripts/verify-seed-guard.mjs': {
    positionals: [],
    accepts: { '--with-database': 'switch' },
    other: ['--filter', '-X', '-c', '-tA', '-v'],
  },
  'scripts/verify-test-independence.mjs': {
    accepts: { '--project': 'identifier' },
    positionals: ['path', 'forwarded'],
    other: ['--json', '--runInBand', '--selectProjects', '-t'],
  },

  // --- services ---------------------------------------------------------------
  'services/analytics-service/src/openapi/document.ts': { other: PRETTIER },
  'services/analytics-service/test/migration-helpers.ts': { other: ['--input-type', '-e'] },
  'services/asset-service/src/insurance/drain-check.cli.ts': { positionals: [] },
  'services/asset-service/src/insurance/reproject.args.ts': {
    accepts: {
      '--dry-run': 'switch',
      '--organization': 'identifier',
      '--page-size': 'integer',
      '--reissue': 'switch',
    },
  },
  'services/asset-service/src/insurance/reproject.cli.ts': { positionals: [] },
  'services/asset-service/src/outbox/flush.cli.ts': {
    positionals: [],
    accepts: { '--max-seconds': 'integer' },
  },
  'services/construction-service/src/openapi/document.ts': { other: PRETTIER },
  'services/contract-service/src/openapi/document.ts': { other: PRETTIER },
  'services/economic-service/src/transaction/resolved-dispute-backfill.cli.ts': {
    positionals: [],
  },
  'services/economic-service/src/transaction/resolved-dispute-backfill.ts': {
    accepts: {
      '--after': 'identifier',
      '--apply': 'switch',
      '--batch-size': 'integer',
      '--lock-timeout-ms': 'integer',
      '--max-batches': 'integer',
      '--statement-timeout-ms': 'integer',
    },
  },
  'services/fleet-service/src/fleet/clear-transferred.args.ts': {
    accepts: {
      '--dry-run': 'switch',
      '--include-unknown-generation': 'switch',
      '--organization': 'identifier',
      '--page-size': 'integer',
    },
  },
  'services/fleet-service/src/fleet/clear-transferred.cli.ts': { positionals: [] },
  'services/fleet-service/src/fleet/drain-check.cli.ts': { positionals: [] },
  'services/identity-service/src/keycloak/projection.cli.ts': { positionals: ['enum'] },
  'services/inventory-service/src/openapi/document.ts': { other: PRETTIER },
  'services/notification-service/src/openapi/document.ts': { other: PRETTIER },
  'services/procurement-service/src/openapi/document.ts': { other: PRETTIER },
});
