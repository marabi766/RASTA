/**
 * The integration work runs as parallel `integration-*` jobs, and
 * `integration` ("Integration and security tests") is only their aggregate:
 * the check branch protection and the merge queue require by name. Until
 * 2026-10-14 it was one job, which had grown to 33–34 minutes.
 *
 * What would quietly weaken the gate, and is refused here:
 *
 *   - a split job the aggregate does not need, so its failure never reaches
 *     the required check (or a need on a job that is not a split job);
 *   - an aggregate that does not run always(), or runs always() combined with
 *     anything else: a job skipped because its dependency failed reports
 *     "skipped", which a required check counts as passing;
 *   - an aggregate whose verdict does not fail on every result but `success`.
 *     That is executed, not read: the verdict step's own script runs here
 *     against every needed job failed, cancelled and skipped in turn, and all
 *     of them skipped, and must exit non-zero for each and zero only when all
 *     succeeded. It must be the aggregate's only step, with no condition, and
 *     name its shell (bash): without one the runner uses `bash -e`, no
 *     pipefail, so the options it is run with here are exactly the ones it
 *     declares and `node -e … | cat` cannot pass here and succeed there;
 *   - `continue-on-error`, `if:`, `strategy` or `defaults` on a split job or
 *     the aggregate, `continue-on-error` or `if:` on any step of one (the
 *     allowlist below is empty: main has none), and `defaults` for the whole
 *     workflow, which would change the shell every step runs in;
 *   - a test or guard step whose `run` is not exactly its declared command
 *     (comments and blank lines aside), so `true`, `cmd || true` or an `echo`
 *     of the command are refused; that lacks an environment variable it was
 *     declared with (without KAFKA_BROKERS the broker suites skip themselves,
 *     without RETRY_REPLAY_REQUIRED retry replay does), or sets one empty or
 *     from an expression that may resolve to empty (`KAFKA_BROKERS: ''` skips
 *     the broker suites just the same); that has any key but
 *     name, run, env and timeout-minutes (so no `shell`, `working-directory`,
 *     `if` or `continue-on-error`); or whose time limit is missing, above its
 *     declared one or above its job's;
 *   - a step of the inventory that no split job runs any more, or that two of
 *     them run;
 *   - a step started without the infrastructure it reads (broker, bucket,
 *     scanner, Redis, a provisioned and migrated PostgreSQL), or a job that
 *     starts infrastructure none of its steps reads;
 *   - a step that sets REQUIRE_MAILPIT (notification's SMTP suites then fail
 *     instead of skipping) in a job without a mailpit service container, or a
 *     mailpit container no step of the job reads;
 *   - a test run outside turbo with nothing having built the packages its
 *     suites resolve to their dist;
 *   - any job, split or not, whose steps' time limits cannot all be spent: the
 *     limits of its steps that have one, plus the setup allowance for the
 *     steps that have none (JOB_SETUP_MINUTES), must fit inside the job's own
 *     `timeout-minutes`, or the job deadline cancels a later step that is
 *     still within its own limit. Every limit and every budget entry is a
 *     positive whole number of minutes (a fraction, zero, a string, an
 *     expression or an entry declared as `undefined` is refused); so are a job
 *     with step limits and no declared allowance, and a job with no
 *     `timeout-minutes`; and a job whose measured runtime needed more than it
 *     had (JOB_FLOOR_MINUTES) may not go back.
 *
 * Workflow text (or its parsed object) in, problems out. The one side effect
 * is running the verdict script under bash from a temporary file, memoised per
 * script and shell.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { workspaceManifestFiles } from './workspace-roots-lib.mjs';

export const AGGREGATE_JOB = 'integration';
export const AGGREGATE_NAME = 'Integration and security tests';
export const SPLIT_PREFIX = 'integration-';
/**
 * The one quality job every split job waits for (FU-111). The former single
 * `quality` job is five parallel `quality-*` jobs; a split job builds and runs
 * its own copy of everything it tests and takes nothing from them, so what it
 * waits for is only a reason not to start ~20 jobs on a tree that cannot
 * type-check. Lint, unit tests, the static guards and the build checks are not
 * waited for: they are demanded by the `quality` aggregate (a required check),
 * and waiting for them would put their minutes on the critical path again.
 */
export const QUALITY_GATE_JOB = 'quality-types';
/** The required check "Lint, types and unit tests" and the parallel jobs it aggregates (FU-111). */
export const QUALITY_AGGREGATE = 'quality';
export const QUALITY_AGGREGATE_NAME = 'Lint, types and unit tests';
export const QUALITY_PREFIX = 'quality-';
/** The one job that may wait for the aggregate: the images verdict demands it, beside the tests. */
export const QUALITY_AGGREGATE_WAITERS = Object.freeze(['images']);
export const QUALITY_JOBS = Object.freeze([
  'quality-guards',
  'quality-lint',
  'quality-types',
  'quality-unit',
  'quality-build',
]);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

import { planTestRun } from './test-phases-lib.mjs';
import { INTEGRATION_PARTITIONS } from './integration-partitions.mjs';
export { INTEGRATION_PARTITIONS };

/** Read every configured workspace root; never infer membership from the registry. */
export function discoverIntegrationPackages(root = ROOT) {
  // Membership is the shared, fail-closed reader's (scripts/workspace-roots-lib.mjs).
  const manifests = workspaceManifestFiles(root);
  const names = new Set();
  for (const file of manifests) {
    const manifest = JSON.parse(readFileSync(join(root, file), 'utf8'));
    if (!Object.hasOwn(manifest.scripts ?? {}, 'test:integration')) continue;
    if (
      typeof manifest.name !== 'string' ||
      !manifest.name.trim() ||
      typeof manifest.scripts['test:integration'] !== 'string' ||
      !manifest.scripts['test:integration'].trim()
    ) {
      throw new Error(`${file}: integration workspace needs a name and nonempty script`);
    }
    if (names.has(manifest.name))
      throw new Error(`duplicate integration workspace name: ${manifest.name}`);
    names.add(manifest.name);
  }
  return [...names].sort();
}

/** Exact set equality with multiplicity: unknown, missing and duplicate members fail. */
export function integrationPartitionProblems(partitions = INTEGRATION_PARTITIONS, root = ROOT) {
  let packages;
  try {
    packages = discoverIntegrationPackages(root);
  } catch (error) {
    return [`integration package discovery failed: ${error.message}`];
  }
  const owners = new Map(packages.map((name) => [name, []]));
  const problems = [];
  if (!isMapping(partitions) || Object.keys(partitions).length === 0) {
    return ['integration partitions must be a nonempty mapping'];
  }
  for (const [step, members] of Object.entries(partitions)) {
    if (!Array.isArray(members) || members.length === 0) {
      problems.push(`${step}: integration partition must be a nonempty package list`);
      continue;
    }
    for (const name of members) {
      if (!owners.has(name)) problems.push(`${step}: unknown integration package ${textOf(name)}`);
      else owners.get(name).push(step);
    }
  }
  for (const [name, steps] of owners) {
    if (steps.length !== 1) {
      problems.push(`${name}: expected exactly one integration partition, found ${steps.length}`);
    }
  }
  return problems;
}

/** Present and not empty, any value. */
const ANY = null;

const SERVICES = [
  'IDENTITY',
  'ORGANIZATION',
  'ASSET',
  'FLEET',
  'MAINTENANCE',
  'ECONOMIC',
  'MARKETPLACE',
  'DOCUMENT',
  'SUPPLIER',
  'CONSTRUCTION',
  'CONTRACT',
  'INVENTORY',
  'ANALYTICS',
  'PROCUREMENT',
  'NOTIFICATION',
  'AUDIT',
];
const databases = (...services) =>
  Object.fromEntries(
    services.flatMap((service) => [
      [`DATABASE_URL_${service}`, ANY],
      [`DATABASE_URL_${service}_MIGRATOR`, ANY],
    ]),
  );
const KAFKA_TESTS = { KAFKA_SECRETS_DIR: ANY, NODE_ENV: 'test', KAFKA_BROKERS: ANY };
const BUCKET = {
  S3_ENDPOINT: ANY,
  S3_REGION: ANY,
  S3_ACCESS_KEY: ANY,
  S3_SECRET_KEY: ANY,
  S3_BUCKET_DOCUMENTS: ANY,
  S3_FORCE_PATH_STYLE: ANY,
};
const SCANNER = { DOCUMENT_CLAMAV_SOCKET_PATH: ANY, DOCUMENT_SCAN_SIGNATURE_MAX_AGE_HOURS: ANY };
/** notification-service's SMTP suites fail, rather than skip, without Mailpit. */
const MAILPIT = { REQUIRE_MAILPIT: '1' };
const POSTGRES = { PGHOST: ANY, PGPORT: ANY, PGUSER: ANY, PGPASSWORD: ANY };

const withKafka = (principal, ...commands) => [
  `kafka_credentials="$(bash infrastructure/docker/kafka/kafka-credentials.sh ${principal})"`,
  'eval "${kafka_credentials}"',
  ...commands,
];
const coverageGate = (service, env = {}, timeout = 8) => ({
  run: withKafka('tests', `pnpm --filter @rasta/${service}-service run test:coverage`),
  env: { ...KAFKA_TESTS, ...databases(service.toUpperCase()), ...env },
  timeout,
});
const postgresGuard = (command) => ({ run: [command], env: POSTGRES, timeout: 5 });

/**
 * Every test and guard step the single job ran, each to run in exactly one
 * split job: its command lines, the environment it must keep (exact value, or
 * ANY), and the most minutes it may take.
 */
export const STEP_INVENTORY = Object.freeze({
  ...Object.fromEntries(
    Object.entries({
      'Integration tests': 'identity',
      'Integration construction': 'construction',
      'Integration economic': 'economic',
      'Integration contract': 'contract',
    }).map(([name, shard]) => {
      return [
        name,
        {
          shard,
          run: withKafka('tests', `pnpm run test:integration --shard=${shard} -- --verbose`),
          env: {
            TEMPORAL_TEST_SERVER_DIR: '${{ runner.temp }}/temporal-test-server',
            KAFKA_SECRETS_DIR: '${{ runner.temp }}/rasta-kafka-secrets',
            NODE_ENV: 'test',
            KAFKA_BROKERS: 'localhost:9092',
            REQUIRE_MAILPIT: '1',
            MAILPIT_API_URL: 'http://localhost:8025',
            NOTIFICATION_SMTP_HOST: 'localhost',
            NOTIFICATION_SMTP_PORT: '1025',
            DATABASE_URL_IDENTITY:
              'postgresql://rasta_identity:rasta_identity_dev_password@localhost:5432/rasta_identity?schema=public',
            DATABASE_URL_IDENTITY_MIGRATOR:
              'postgresql://rasta_identity_migrator:rasta_identity_migrator_dev_password@localhost:5432/rasta_identity?schema=public',
            DATABASE_URL_ORGANIZATION:
              'postgresql://rasta_organization:rasta_organization_dev_password@localhost:5432/rasta_organization?schema=public',
            DATABASE_URL_ORGANIZATION_MIGRATOR:
              'postgresql://rasta_organization_migrator:rasta_organization_migrator_dev_password@localhost:5432/rasta_organization?schema=public',
            DATABASE_URL_ASSET:
              'postgresql://rasta_asset:rasta_asset_dev_password@localhost:5432/rasta_asset?schema=public',
            DATABASE_URL_ASSET_MIGRATOR:
              'postgresql://rasta_asset_migrator:rasta_asset_migrator_dev_password@localhost:5432/rasta_asset?schema=public',
            DATABASE_URL_FLEET:
              'postgresql://rasta_fleet:rasta_fleet_dev_password@localhost:5432/rasta_fleet?schema=public',
            DATABASE_URL_FLEET_MIGRATOR:
              'postgresql://rasta_fleet_migrator:rasta_fleet_migrator_dev_password@localhost:5432/rasta_fleet?schema=public',
            DATABASE_URL_MAINTENANCE:
              'postgresql://rasta_maintenance:rasta_maintenance_dev_password@localhost:5432/rasta_maintenance?schema=public',
            DATABASE_URL_MAINTENANCE_MIGRATOR:
              'postgresql://rasta_maintenance_migrator:rasta_maintenance_migrator_dev_password@localhost:5432/rasta_maintenance?schema=public',
            DATABASE_URL_ECONOMIC:
              'postgresql://rasta_economic:rasta_economic_dev_password@localhost:5432/rasta_economic?schema=public',
            DATABASE_URL_ECONOMIC_MIGRATOR:
              'postgresql://rasta_economic_migrator:rasta_economic_migrator_dev_password@localhost:5432/rasta_economic?schema=public',
            DATABASE_URL_MARKETPLACE:
              'postgresql://rasta_marketplace:rasta_marketplace_dev_password@localhost:5432/rasta_marketplace?schema=public',
            DATABASE_URL_MARKETPLACE_MIGRATOR:
              'postgresql://rasta_marketplace_migrator:rasta_marketplace_migrator_dev_password@localhost:5432/rasta_marketplace?schema=public',
            DATABASE_URL_DOCUMENT:
              'postgresql://rasta_document:rasta_document_dev_password@localhost:5432/rasta_document?schema=public',
            DATABASE_URL_DOCUMENT_MIGRATOR:
              'postgresql://rasta_document_migrator:rasta_document_migrator_dev_password@localhost:5432/rasta_document?schema=public',
            DATABASE_URL_SUPPLIER:
              'postgresql://rasta_supplier:rasta_supplier_dev_password@localhost:5432/rasta_supplier?schema=public',
            DATABASE_URL_SUPPLIER_MIGRATOR:
              'postgresql://rasta_supplier_migrator:rasta_supplier_migrator_dev_password@localhost:5432/rasta_supplier?schema=public',
            DATABASE_URL_CONSTRUCTION:
              'postgresql://rasta_construction:rasta_construction_dev_password@localhost:5432/rasta_construction?schema=public',
            DATABASE_URL_CONSTRUCTION_MIGRATOR:
              'postgresql://rasta_construction_migrator:rasta_construction_migrator_dev_password@localhost:5432/rasta_construction?schema=public',
            DATABASE_URL_CONTRACT:
              'postgresql://rasta_contract:rasta_contract_dev_password@localhost:5432/rasta_contract?schema=public',
            DATABASE_URL_CONTRACT_MIGRATOR:
              'postgresql://rasta_contract_migrator:rasta_contract_migrator_dev_password@localhost:5432/rasta_contract?schema=public',
            DATABASE_URL_INVENTORY:
              'postgresql://rasta_inventory:rasta_inventory_dev_password@localhost:5432/rasta_inventory?schema=public',
            DATABASE_URL_INVENTORY_MIGRATOR:
              'postgresql://rasta_inventory_migrator:rasta_inventory_migrator_dev_password@localhost:5432/rasta_inventory?schema=public',
            DATABASE_URL_ANALYTICS:
              'postgresql://rasta_analytics:rasta_analytics_dev_password@localhost:5432/rasta_analytics?schema=public',
            DATABASE_URL_ANALYTICS_MIGRATOR:
              'postgresql://rasta_analytics_migrator:rasta_analytics_migrator_dev_password@localhost:5432/rasta_analytics?schema=public',
            DATABASE_URL_PROCUREMENT:
              'postgresql://rasta_procurement:rasta_procurement_dev_password@localhost:5432/rasta_procurement?schema=public',
            DATABASE_URL_PROCUREMENT_MIGRATOR:
              'postgresql://rasta_procurement_migrator:rasta_procurement_migrator_dev_password@localhost:5432/rasta_procurement?schema=public',
            DATABASE_URL_NOTIFICATION:
              'postgresql://rasta_notification:rasta_notification_dev_password@localhost:5432/rasta_notification?schema=public',
            DATABASE_URL_NOTIFICATION_MIGRATOR:
              'postgresql://rasta_notification_migrator:rasta_notification_migrator_dev_password@localhost:5432/rasta_notification?schema=public',
            DATABASE_URL_AUDIT:
              'postgresql://rasta_audit:rasta_audit_dev_password@localhost:5432/rasta_audit?schema=audit',
            DATABASE_URL_AUDIT_MIGRATOR:
              'postgresql://rasta_audit_migrator:rasta_audit_migrator_dev_password@localhost:5432/rasta_audit?schema=audit',
            S3_ENDPOINT: 'http://localhost:9000',
            S3_REGION: 'us-east-1',
            S3_ACCESS_KEY: 'rasta_minio_admin',
            S3_SECRET_KEY: 'rasta_minio_ci_password',
            S3_BUCKET_DOCUMENTS: 'rasta-documents',
            S3_FORCE_PATH_STYLE: 'true',
            DOCUMENT_CLAMAV_SOCKET_PATH: '/tmp/clamav-socket/clamd.sock',
            DOCUMENT_SCAN_SIGNATURE_MAX_AGE_HOURS: '8760',
            REDIS_URL: 'redis://localhost:6379',
          },
          exactEnv: true,
          timeout: { identity: 13, construction: 17, economic: 16, contract: 15 }[shard],
        },
      ];
    }),
  ),
  'Backup restore SQL on a disposable database': postgresGuard(
    'pnpm run test:backup-restore-drill-pg',
  ),
  'Economic coverage gate': coverageGate('economic'),
  'Marketplace coverage gate': coverageGate('marketplace', {}, 14),
  'Document coverage gate': coverageGate('document', { ...BUCKET, ...SCANNER }),
  'Supplier coverage gate': coverageGate('supplier'),
  // 11 = ceil(429 s x 1.5 / 60): the slowest of the last 20 green runs took 429 s.
  'Construction coverage gate': coverageGate('construction', {}, 11),
  'Contract coverage gate': coverageGate('contract'),
  'Inventory coverage gate': coverageGate('inventory'),
  'Audit coverage gate': coverageGate('audit'),
  'Notification coverage gate': coverageGate('notification', MAILPIT),
  'Organization coverage gate': coverageGate('organization'),
  'Procurement coverage gate': coverageGate('procurement'),
  'Analytics coverage gate': coverageGate('analytics', { TEST_ANALYTICS_ADMIN_URL: ANY }),
  'Analytics database privilege integration tests': {
    run: ['pnpm --filter @rasta/analytics-service run test:db-privileges'],
    env: { NODE_ENV: 'test', ...databases('ANALYTICS'), TEST_ANALYTICS_ADMIN_URL: ANY },
    timeout: 5,
  },
  'Test independence (F-25)': {
    run: withKafka('tests', 'pnpm run test:independence'),
    env: { ...KAFKA_TESTS, ...databases('MAINTENANCE') },
    timeout: 8,
  },
  'Tenant isolation and authorization tests': {
    run: withKafka(
      'tests',
      'pnpm run test -- --testNamePattern="(tenant|isolation|authorization|subtree visibility)"',
      'pnpm run test:integration -- --testNamePattern="(tenant|isolation|exclusivity|duplicate|provenance|immutab|balance|concurren|idempot|atomic|dispute|overspend|cap)" --verbose',
    ),
    env: { ...KAFKA_TESTS, ...databases(...SERVICES), ...BUCKET, ...SCANNER },
    timeout: 10,
  },
  'Outbox stream-sequence protocol (ADR-051 B3)': {
    run: ['pnpm run test:outbox-b3'],
    env: databases(...SERVICES.slice(0, SERVICES.indexOf('SUPPLIER') + 1)),
    timeout: 5,
  },
  'Supplier privilege split, upgraded from main': postgresGuard(
    'pnpm run test:supplier-privilege-split',
  ),
  'Runtime roles own nothing (D-045)': postgresGuard('pnpm run check:db-runtime-privileges'),
  // 18 = ceil(710 s x 1.5 / 60), an estimate (#540 r3): the three files took
  // 640 s in CI at 709012e7; the R3-1 fixtures and the two psql calls each
  // split adds come to ~70 s more there (ci.yml has the arithmetic).
  'Runtime-role check and the generic split, on a throwaway database': {
    ...postgresGuard('pnpm run test:db-runtime-privileges'),
    timeout: 18,
  },
  'Every database session runs in UTC (L7-37)': postgresGuard('pnpm run test:db-session-utc'),
  'The runtime pool and statement timeout come from configuration': postgresGuard(
    'pnpm run test:db-pool-config',
  ),
  'Retry replay, published as ops-replay': {
    run: withKafka('replay', 'pnpm run test:retry-replay'),
    env: {
      ...KAFKA_TESTS,
      KAFKA_ADMIN_SECRETS_DIR: ANY,
      RETRY_REPLAY_REQUIRED: 'true',
      ...databases('AUDIT'),
    },
    timeout: 5,
  },
});
export const SPLIT_STEPS = Object.freeze(Object.keys(STEP_INVENTORY));

/**
 * `if:` conditions allowed on a split job's step, as `{ job, step, if, reason }`.
 * No test or guard step has one on main, so each runs on every pull request and
 * push. The only entries are the connection report that must follow a failed
 * run too: it measures, it is not in STEP_INVENTORY and never fails the job.
 */
export const ALLOWED_CONDITIONS = Object.freeze([
  {
    job: 'integration-suites',
    step: 'PostgreSQL connection peak',
    if: 'always()',
    reason: 'prints the connection peak against max_connections after a failed run too',
  },
  {
    job: 'integration-security',
    step: 'PostgreSQL connection peak',
    if: 'always()',
    reason: 'prints the connection peak against max_connections after a failed run too',
  },
]);

/**
 * Minutes a job needs for its steps that carry no `timeout-minutes` of their
 * own (checkout, install, build, migrations, broker start-up, the runner's
 * set-up and completion): ceil(max x 1.5 / 60), where max is the most any run
 * of the job took in those steps over the last 20 green CI runs on main and
 * `mq/train-*` (2026-10-29, GitHub job listings). A job that has step limits
 * is refused here without an entry, rather than assumed to need no setup.
 * Measured maxima, in seconds: suites 298, security 309, critical 281,
 * coverage 310, backup drill 92, migration chain 135 (per shard), migration
 * guards 253, trivy-db 5. `quality-unit` (FU-111): its one limited step is the
 * unit-step concurrency step (74-87 s in green runs); the rest of the job is
 * setup, `pnpm install`, `db:generate`, the Temporal cache and the unit
 * tests: 8 + 16 + 19 + 16 + 9 + 306 = 374 s in run 41985369242 (2026-11-05),
 * and up to 2216/1608 = 1.38 times that on the slowest measured day (2026-11-02,
 * whole-job times), so ceil(374 x 1.38 x 1.5 / 60) = 13, plus the turbo
 * `^build` the job now does for itself (it shared the old job's cache), 2: 15.
 * Derived from one run's step times, not from 20 runs: re-measure after a week
 * of runs.
 */
export const JOB_SETUP_MINUTES = Object.freeze({
  'integration-suites': 8,
  'integration-construction': 8,
  'integration-economic': 8,
  'integration-contract': 8,
  'integration-security': 8,
  'integration-coverage-critical': 8,
  'integration-coverage': 8,
  'integration-backup-drill': 3,
  'migration-reversibility-chain': 4,
  'migration-guards': 7,
  'trivy-db': 1,
  'quality-unit': 15,
});

/**
 * The least `timeout-minutes` a job may have where the runtime itself, not
 * the sum of its step limits, set it: the slowest of the last 20 green runs
 * took more than 80 % of the old limit, so the new one is ceil(max x 1.5 / 60).
 * `web-browser` took up to 1462 s (old limit 30, 81 %). The former single
 * `quality` job had a floor of 56 (it took up to 2216 s on 2026-11-02 and
 * cancelled healthy runs); FU-111 split it into five jobs of 20/20/15/25/20
 * minutes whose longest step list is 8-9 minutes, so that floor went with it
 * (and would now fail the 5-minute aggregate). The new jobs have no measured
 * history yet: set floors for them once 20 green runs exist.
 */
export const JOB_FLOOR_MINUTES = Object.freeze({ 'web-browser': 37 });

/** The keys a test step may have: nothing that skips it, forgives it or changes its shell. */
const STEP_KEYS = new Set(['name', 'run', 'env', 'timeout-minutes']);
/** The verdict's, which must also name the shell it is run with here. */
const VERDICT_KEYS = new Set([...STEP_KEYS, 'shell']);
/**
 * What the runner runs `shell: bash` as (GitHub's documented
 * `bash --noprofile --norc -eo pipefail {0}`). A custom `bash <options> {0}`
 * is run with its own options.
 */
const BASH_OPTIONS = ['--noprofile', '--norc', '-eo', 'pipefail'];
const SHELL_TOKEN = /^(?:-[A-Za-z]+|--[a-z]+(?:-[a-z]+)*|[a-z]+)$/;
/** Expressions a required variable may be built from: set on every runner, never empty. */
const RESOLVED_EXPRESSIONS = new Set(['runner.temp']);
const REFUSED_JOB_KEYS = {
  if: 'a condition can skip it, and a skipped job counts as passing',
  'continue-on-error': 'a failure would not fail the job',
  strategy: 'a matrix turns one job into several the aggregate does not name',
  defaults: 'it changes the shell or directory every step runs in',
};
const NEEDS_EXPRESSION = '${{ toJSON(needs) }}';
const BAD_RESULTS = ['failure', 'cancelled', 'skipped'];

const KAFKA_STEP = 'Start the authenticated Kafka broker';
const MINIO_STEP = 'Start MinIO and create the document bucket';
const CLAMAV_STEP = 'Start ClamAV on a Unix socket';
const PROVISION_STEP = 'Provision databases, roles and extensions';
const MIGRATE_STEP = 'Apply migrations';
const BUILD_STEP = 'Build the shared packages';

/** Commands that run jest or load package dist without going through turbo's `^build`. */
const UNBUILT = [
  /\btest:coverage\b/,
  /\btest:independence\b/,
  /\btest:retry-replay\b/,
  /\btest:db-session-utc\b/,
  /\btest:db-pool-config\b/,
];
const TURBO_BUILDS = /\bpnpm run test:integration\b/;

const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const listOf = (value) => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []);
/**
 * A workflow value as text. `String()` throws on `{toString: x}`, which YAML
 * can say, and a checker that throws turns a malformed value into a crash
 * instead of a problem.
 */
export const textOf = (value) => {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '[object]';
  }
};
const squash = (value) => textOf(value).replace(/\s+/g, ' ').trim();
const commandLines = (run) =>
  textOf(run)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
/** A positive whole number of minutes: the one definition every limit and budget is held to. */
const isMinutes = (value) => Number.isSafeInteger(value) && value > 0;
const MINUTES = 'a positive whole number of minutes';
/**
 * A budget table as a Map of its own entries, so that a name taken from the
 * workflow can only find what the table declares (`table['constructor']` or
 * `table['__proto__']` is a function or an object, which makes
 * `sum + setup > limit` false and so accepts the overrun), and so that an
 * entry's presence stays apart from its value (`{ slow: undefined }` is
 * declared, and wrong, not absent).
 */
const budgetTable = (table) => new Map(Object.entries(table));
/** The inventory by step name; a step's name comes from the workflow, so no plain-object lookup. */
const INVENTORY = new Map(Object.entries(STEP_INVENTORY));

export function checkIntegrationSplitText(text, root = ROOT) {
  let workflow;
  try {
    workflow = parseYaml(text);
  } catch (error) {
    return [`ci.yml is not valid YAML: ${error.message}`];
  }
  return checkIntegrationSplit(workflow, root);
}

/** FU-027: ownership, command inventory and executable workflow must agree on step keys. */
export function integrationPartitionStepProblems(
  workflow,
  partitions = INTEGRATION_PARTITIONS,
  inventory = STEP_INVENTORY,
) {
  if (!isMapping(partitions) || !isMapping(inventory))
    return ['partition steps and suite inventory must be mappings'];
  const problems = [];
  const partitionNames = new Set(Object.keys(partitions));
  // Inventory is independent of ownership: deriving these keys from partitions
  // would let an ownership rename silently rename its own supposed cross-check.
  const suiteNames = new Set(
    Object.entries(inventory)
      .filter(
        ([, entry]) =>
          isMapping(entry) &&
          (Object.hasOwn(entry, 'shard') || /--shard(?:=|\s)/.test(textOf(entry.run))),
      )
      .map(([name]) => name),
  );
  const occurrences = new Map([...partitionNames].map((name) => [name, 0]));
  for (const name of partitionNames) {
    if (!suiteNames.has(name))
      problems.push(`${name}: partition step missing from suite inventory`);
  }
  for (const name of suiteNames) {
    if (!partitionNames.has(name)) problems.push(`${name}: suite inventory step has no partition`);
  }
  // Scan every job, so a duplicate outside integration-* cannot escape the guard.
  for (const [id, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      if (occurrences.has(step?.name)) occurrences.set(step.name, occurrences.get(step.name) + 1);
      const integrationRun = /test:integration|run-test-phases\.mjs|--shard(?:=|\s)/.test(
        textOf(step?.run),
      );
      if (integrationRun && !id.startsWith(SPLIT_PREFIX))
        problems.push(`${id}: integration execution must run in an integration-* job`);
      if (integrationRun && !Object.hasOwn(inventory, step?.name))
        problems.push(`${textOf(step?.name)}: workflow integration step missing from inventory`);
      if (
        (suiteNames.has(step?.name) || /--shard(?:=|\s)/.test(textOf(step?.run))) &&
        !partitionNames.has(step?.name)
      )
        problems.push(`${textOf(step?.name)}: workflow suite step has no partition`);
    }
  }
  for (const [name, count] of occurrences) {
    if (count !== 1)
      problems.push(`${name}: partition step must occur exactly once in workflow, found ${count}`);
  }
  return problems;
}

export function checkIntegrationSplit(workflow, root = ROOT) {
  const problems = [
    ...integrationPartitionProblems(INTEGRATION_PARTITIONS, root),
    ...integrationPartitionStepProblems(workflow),
  ];
  // Inspect the exact plan the executable runner consumes, not only ownership.
  const effective = {};
  let stressCount = 0;
  for (const name of Object.keys(INTEGRATION_PARTITIONS)) {
    const shard = name === 'Integration tests' ? 'identity' : name.split(' ')[1];
    try {
      const plan = planTestRun(['test:integration', `--shard=${shard}`]);
      const workspace = plan[0];
      if (
        workspace?.phase !== 'workspace' ||
        workspace.args[0] !== 'run' ||
        workspace.args[1] !== 'test:integration' ||
        workspace.args.slice(2).some((arg) => !arg.startsWith('--filter=@rasta/'))
      ) {
        problems.push(`${name}: invalid effective workspace execution`);
      }
      effective[name] = workspace.args.slice(2).map((arg) => arg.slice('--filter='.length));
      if (JSON.stringify(effective[name]) !== JSON.stringify(INTEGRATION_PARTITIONS[name]))
        problems.push(`${name}: effective filters differ from ownership`);
      const stress = plan.slice(1);
      stressCount += stress.length;
      if (
        JSON.stringify(stress) !==
        JSON.stringify(
          shard === 'identity'
            ? [
                {
                  phase: 'exclusive',
                  args: ['run', 'test:aggregation-stress', '--filter=@rasta/identity-service'],
                },
              ]
            : [],
        )
      )
        problems.push(`${name}: incorrect exclusive stress plan`);
    } catch (error) {
      problems.push(`${name}: effective execution failed: ${error.message}`);
    }
  }
  problems.push(...integrationPartitionProblems(effective, root));
  problems.push(...qualitySplitProblems(workflow));
  if (stressCount !== 1)
    problems.push(`expected exactly one exclusive stress phase, found ${stressCount}`);
  const jobs = isMapping(workflow?.jobs) ? workflow.jobs : {};
  const splitIds = Object.keys(jobs).filter((id) => id.startsWith(SPLIT_PREFIX));
  const aggregate = jobs[AGGREGATE_JOB];

  if (workflow?.defaults !== undefined) {
    problems.push('the workflow sets defaults; they change the shell every split step runs in');
  }
  const jobLevel = (id, job) => {
    for (const [key, why] of Object.entries(REFUSED_JOB_KEYS)) {
      if (key === 'if' && id === AGGREGATE_JOB) continue;
      if (key === 'continue-on-error' && job[key] === false) continue;
      if (key in job) problems.push(`${id} sets ${key}: ${why}`);
    }
    if (!isMinutes(job['timeout-minutes'])) {
      problems.push(`${id} has no timeout-minutes (${MINUTES})`);
    }
  };

  if (splitIds.length === 0) problems.push(`no ${SPLIT_PREFIX}* jobs`);
  if (!isMapping(aggregate)) {
    problems.push(`no "${AGGREGATE_JOB}" job`);
  } else {
    if (aggregate.name !== AGGREGATE_NAME) {
      problems.push(`"${AGGREGATE_JOB}" must be named "${AGGREGATE_NAME}" (the required check)`);
    }
    jobLevel(AGGREGATE_JOB, aggregate);
    const needs = listOf(aggregate.needs);
    for (const id of splitIds) {
      if (!needs.includes(id)) problems.push(`"${AGGREGATE_JOB}" does not need ${id}`);
    }
    for (const id of needs) {
      if (!splitIds.includes(id)) problems.push(`"${AGGREGATE_JOB}" needs ${id}, not a split job`);
    }
    const condition = squash(aggregate.if ?? '').replace(/^\$\{\{\s*(.*?)\s*\}\}$/, '$1');
    if (condition !== 'always()') {
      problems.push(
        `"${AGGREGATE_JOB}" must run if: always() and nothing else; a skipped required check counts as passing`,
      );
    }
    problems.push(...verdictProblems(aggregate, needs));
  }

  const seen = new Map(SPLIT_STEPS.map((name) => [name, []]));
  for (const id of splitIds) {
    const job = jobs[id];
    if (!isMapping(job)) {
      problems.push(`${id} is not a job`);
      continue;
    }
    if (!listOf(job.needs).includes(QUALITY_GATE_JOB))
      problems.push(`${id} must need ${QUALITY_GATE_JOB}`);
    jobLevel(id, job);
    const services = isMapping(job.services) ? job.services : {};
    const steps = Array.isArray(job.steps) ? job.steps.filter(isMapping) : [];
    const env = (step) => (isMapping(step.env) ? step.env : {});
    const run = (step) => textOf(step.run);
    const indexOf = (name) => steps.findIndex((step) => step.name === name);
    const uses = (key) => steps.some((step) => key in env(step));

    steps.forEach((step, index) => {
      const label = `${id}: "${textOf(step.name ?? step.uses ?? step.run ?? `step ${index + 1}`)}"`;
      if ('continue-on-error' in step && step['continue-on-error'] !== false) {
        problems.push(`${label} sets continue-on-error: its failure would not fail the job`);
      }
      if ('if' in step) {
        const allowed = ALLOWED_CONDITIONS.some(
          (entry) => entry.job === id && entry.step === step.name && entry.if === step.if,
        );
        if (!allowed) problems.push(`${label} has if: ${textOf(step.if)}, which can skip it`);
      }
      const declared = INVENTORY.get(step.name);
      if (declared) {
        seen.get(step.name).push(id);
        problems.push(...testStepProblems(label, step, declared, job['timeout-minutes']));
      }

      const before = (name) => {
        const at = indexOf(name);
        return at >= 0 && at < index;
      };
      const needsInfra = (condition, what, present) => {
        if (condition && !present)
          problems.push(`${id}: "${textOf(step.name)}" runs without ${what}`);
      };
      const vars = Object.keys(env(step));
      needsInfra(vars.includes('KAFKA_BROKERS'), `"${KAFKA_STEP}" before it`, before(KAFKA_STEP));
      needsInfra(vars.includes('S3_ENDPOINT'), `"${MINIO_STEP}" before it`, before(MINIO_STEP));
      needsInfra(
        vars.includes('DOCUMENT_CLAMAV_SOCKET_PATH'),
        `"${CLAMAV_STEP}" before it`,
        before(CLAMAV_STEP),
      );
      needsInfra(vars.includes('REDIS_URL'), 'a redis service container', 'redis' in services);
      needsInfra(
        vars.includes('REQUIRE_MAILPIT'),
        'a mailpit service container',
        'mailpit' in services,
      );
      const database =
        vars.some((key) => key.startsWith('DATABASE_URL_')) || vars.includes('PGHOST');
      needsInfra(
        database,
        `a postgres service container provisioned ("${PROVISION_STEP}") before it`,
        'postgres' in services && before(PROVISION_STEP),
      );
      needsInfra(
        database &&
          step.name !== MIGRATE_STEP &&
          !(
            id === 'integration-backup-drill' &&
            step.name === 'Backup restore SQL on a disposable database'
          ),
        `"${MIGRATE_STEP}" before it`,
        before(MIGRATE_STEP),
      );
      if (UNBUILT.some((pattern) => pattern.test(run(step)))) {
        const built = steps
          .slice(0, index)
          .some((earlier) => earlier.name === BUILD_STEP || TURBO_BUILDS.test(run(earlier)));
        if (!built) {
          problems.push(
            `${id}: "${textOf(step.name)}" needs the packages built before it ("${BUILD_STEP}")`,
          );
        }
      }
    });

    const unused = (present, key, what) => {
      if (present && !uses(key)) problems.push(`${id} starts ${what}, which no step of it reads`);
    };
    unused(indexOf(KAFKA_STEP) >= 0, 'KAFKA_BROKERS', 'the broker');
    unused(indexOf(MINIO_STEP) >= 0, 'S3_ENDPOINT', 'MinIO');
    unused(indexOf(CLAMAV_STEP) >= 0, 'DOCUMENT_CLAMAV_SOCKET_PATH', 'ClamAV');
    unused('redis' in services, 'REDIS_URL', 'Redis');
    unused('mailpit' in services, 'REQUIRE_MAILPIT', 'Mailpit');
  }
  problems.push(...jobBudgetProblems(jobs, splitIds));
  for (const [name, where] of seen) {
    if (where.length === 0) problems.push(`no ${SPLIT_PREFIX}* job runs "${name}"`);
    if (where.length > 1) problems.push(`"${name}" runs in more than one job: ${where.join(', ')}`);
  }
  return problems;
}

/**
 * FU-111: the required check "Lint, types and unit tests" is an aggregate of
 * the parallel `quality-*` jobs, and nothing may let it pass without every one
 * of them having succeeded. Fail closed:
 *
 *  - the aggregate keeps its name, needs exactly the `quality-*` jobs found in
 *    the workflow (so a job added later is needed, not forgotten) and exactly
 *    QUALITY_JOBS (so adding or dropping one is a reviewed edit here), runs
 *    `if: always()` and nothing else, and its verdict, run here against every
 *    result, fails on all but `success`;
 *  - no quality job, and no step of one, can be skipped or forgiven (`if`,
 *    `continue-on-error`), which would turn a failed check into a pass;
 *  - the gate the integration jobs wait for runs the type check.
 */
export function qualitySplitProblems(workflow) {
  const jobs = isMapping(workflow?.jobs) ? workflow.jobs : {};
  const ids = Object.keys(jobs).filter((id) => id.startsWith(QUALITY_PREFIX));
  const problems = [];
  if (JSON.stringify([...ids].sort()) !== JSON.stringify([...QUALITY_JOBS].sort())) {
    problems.push(
      `the quality jobs are ${JSON.stringify(ids)}, not ${JSON.stringify(QUALITY_JOBS)}: a job added or removed must be added to QUALITY_JOBS in the same change`,
    );
  }
  const aggregate = jobs[QUALITY_AGGREGATE];
  if (!isMapping(aggregate)) {
    problems.push(`no "${QUALITY_AGGREGATE}" job`);
  } else {
    if (aggregate.name !== QUALITY_AGGREGATE_NAME) {
      problems.push(
        `"${QUALITY_AGGREGATE}" must be named "${QUALITY_AGGREGATE_NAME}" (the required check)`,
      );
    }
    const needs = listOf(aggregate.needs);
    for (const id of ids) {
      if (!needs.includes(id)) problems.push(`"${QUALITY_AGGREGATE}" does not need ${id}`);
    }
    for (const id of needs) {
      if (!ids.includes(id)) problems.push(`"${QUALITY_AGGREGATE}" needs ${id}, not a quality job`);
    }
    const condition = squash(aggregate.if ?? '').replace(/^\$\{\{\s*(.*?)\s*\}\}$/, '$1');
    if (condition !== 'always()') {
      problems.push(
        `"${QUALITY_AGGREGATE}" must run if: always() and nothing else; a skipped required check counts as passing`,
      );
    }
    if ('continue-on-error' in aggregate && aggregate['continue-on-error'] !== false) {
      problems.push(`"${QUALITY_AGGREGATE}" sets continue-on-error`);
    }
    problems.push(...verdictProblems(aggregate, needs, QUALITY_AGGREGATE));
  }
  for (const id of ids) {
    const job = jobs[id];
    if (!isMapping(job)) {
      problems.push(`${id} is not a job`);
      continue;
    }
    if ('if' in job) problems.push(`${id} has a job-level if, which can skip it`);
    if ('continue-on-error' in job && job['continue-on-error'] !== false) {
      problems.push(`${id} sets continue-on-error: its failure would not fail the aggregate`);
    }
    const steps = Array.isArray(job.steps) ? job.steps.filter(isMapping) : [];
    if (steps.length === 0) problems.push(`${id} has no steps`);
    for (const step of steps) {
      const label = `${id}: "${textOf(step.name ?? step.uses ?? step.run)}"`;
      if ('if' in step) problems.push(`${label} has if: ${textOf(step.if)}, which can skip it`);
      if ('continue-on-error' in step && step['continue-on-error'] !== false) {
        problems.push(`${label} sets continue-on-error: its failure would not fail the job`);
      }
    }
  }
  // No other job waits for the aggregate or for a quality job but the gate: waiting for
  // lint, unit tests, the guards or the build would put their minutes on the path again.
  for (const [id, job] of Object.entries(jobs)) {
    if (id === QUALITY_AGGREGATE || ids.includes(id) || !isMapping(job)) continue;
    for (const need of listOf(job.needs)) {
      if (need === QUALITY_AGGREGATE && QUALITY_AGGREGATE_WAITERS.includes(id)) continue;
      if ((need === QUALITY_AGGREGATE || ids.includes(need)) && need !== QUALITY_GATE_JOB) {
        problems.push(
          `${id} waits for ${need}; the only quality job another job may wait for is ${QUALITY_GATE_JOB}`,
        );
      }
    }
  }
  const gate = jobs[QUALITY_GATE_JOB];
  const gateRuns = (Array.isArray(gate?.steps) ? gate.steps : []).filter(
    (step) => isMapping(step) && step.run === 'pnpm run typecheck',
  );
  if (gateRuns.length !== 1) {
    problems.push(`${QUALITY_GATE_JOB} must run pnpm run typecheck exactly once, it is the gate`);
  }
  return problems;
}

/**
 * Every job's cumulative time budget. A step's own `timeout-minutes` only
 * bounds that step: the steps run one after the other under the job's, so
 * limits that sum to more than the job's leave a later step cancelled by the
 * job deadline while it is still within its own limit. The sum of the step
 * limits plus the setup allowance for the steps without one must fit.
 */
export function jobBudgetProblems(
  jobs,
  splitIds,
  setupMinutes = JOB_SETUP_MINUTES,
  floorMinutes = JOB_FLOOR_MINUTES,
) {
  const setups = budgetTable(setupMinutes);
  const floors = budgetTable(floorMinutes);
  // The one place a table's values are validated, whether or not a job uses them.
  const problems = [
    ...[...setups].flatMap(([id, value]) =>
      isMinutes(value)
        ? []
        : [`${id} has a setup allowance in JOB_SETUP_MINUTES that is not ${MINUTES}`],
    ),
    ...[...floors].flatMap(([id, value]) =>
      isMinutes(value) ? [] : [`${id} has a floor in JOB_FLOOR_MINUTES that is not ${MINUTES}`],
    ),
  ];
  for (const [id, job] of Object.entries(jobs)) {
    if (!isMapping(job)) continue;
    const limit = job['timeout-minutes'];
    // The split jobs and the aggregate are refused by jobLevel() already.
    if (!isMinutes(limit) && !splitIds.includes(id) && id !== AGGREGATE_JOB) {
      problems.push(`${id} has no timeout-minutes (${MINUTES})`);
    }
    const floor = floors.get(id);
    if (isMinutes(floor) && isMinutes(limit) && limit < floor) {
      problems.push(
        `${id} has timeout-minutes ${limit}, below its ${floor}: its slowest green runs needed it`,
      );
    }
    const steps = Array.isArray(job.steps) ? job.steps.filter(isMapping) : [];
    const limited = steps.filter((step) => 'timeout-minutes' in step);
    if (limited.length === 0) continue;
    const unknown = limited.filter((step) => !isMinutes(step['timeout-minutes']));
    for (const step of unknown) {
      problems.push(
        `${id}: "${textOf(step.name ?? step.uses ?? step.run)}" has a timeout-minutes that is not ${MINUTES}, so its share of the job's budget is unknown`,
      );
    }
    if (unknown.length > 0) continue;
    const sum = limited.reduce((total, step) => total + step['timeout-minutes'], 0);
    const setup = setups.get(id);
    if (!setups.has(id)) {
      problems.push(
        `${id} has step time limits (${sum} minutes in all) but no setup allowance in JOB_SETUP_MINUTES`,
      );
    } else if (isMinutes(setup) && isMinutes(limit) && sum + setup > limit) {
      problems.push(
        `${id}: its steps' timeout-minutes sum to ${sum} and the steps without one need ${setup} more, ${sum + setup} in all, above the job's timeout-minutes ${limit}`,
      );
    }
  }
  for (const id of new Set([...setups.keys(), ...floors.keys()])) {
    if (!Object.hasOwn(jobs, id) || !isMapping(jobs[id]))
      problems.push(`${id} has a declared time budget but is not a job`);
  }
  return problems;
}

function testStepProblems(label, step, declared, jobMinutes) {
  const problems = [];
  for (const key of Object.keys(step)) {
    if (!STEP_KEYS.has(key)) {
      problems.push(
        `${label} sets ${key}; a test step has only name, run, env and timeout-minutes`,
      );
    }
  }
  const lines = commandLines(step.run);
  if (JSON.stringify(lines) !== JSON.stringify(declared.run)) {
    problems.push(
      `${label} must run exactly ${JSON.stringify(declared.run)}, not ${JSON.stringify(lines)}`,
    );
  }
  const env = isMapping(step.env) ? step.env : {};
  if (declared.exactEnv) {
    for (const key of Object.keys(env)) {
      if (!Object.hasOwn(declared.env, key)) problems.push(`${label} has undeclared env ${key}`);
    }
  }
  for (const [key, value] of Object.entries(declared.env)) {
    if (!(key in env)) {
      problems.push(`${label} lost ${key} from its env`);
      continue;
    }
    const unresolved = unresolvedProblem(env[key]);
    if (unresolved) problems.push(`${label} sets ${key} ${unresolved}`);
    else if (value !== ANY && String(env[key]) !== value) {
      problems.push(`${label} must set ${key}: ${value}, not ${env[key]}`);
    }
  }
  const minutes = step['timeout-minutes'];
  if (!isMinutes(minutes)) {
    problems.push(`${label} has no timeout-minutes (${MINUTES}, at most ${declared.timeout})`);
  } else {
    if (minutes > declared.timeout) {
      problems.push(`${label} has timeout-minutes ${minutes}, above its ${declared.timeout}`);
    }
    if (isMinutes(jobMinutes) && minutes > jobMinutes) {
      problems.push(`${label} has timeout-minutes ${minutes}, above its job's ${jobMinutes}`);
    }
  }
  return problems;
}

/**
 * Why a required variable's value may reach the step empty, or undefined if
 * it cannot. An empty variable reads like a missing one to
 * `if (!process.env.X)`, and an expression with nothing behind it (a secret,
 * a `vars` or `env` entry nobody set) resolves to the empty string.
 */
function unresolvedProblem(value) {
  if (value === null || typeof value === 'object') return 'to no value';
  const text = String(value);
  const expressions = [...text.matchAll(/\$\{\{(.*?)\}\}/gs)].map(([, inner]) => squash(inner));
  const unknown = expressions.filter((expression) => !RESOLVED_EXPRESSIONS.has(expression));
  if (unknown.length > 0) {
    return `from \${{ ${unknown[0]} }}, which may resolve to empty (only ${[...RESOLVED_EXPRESSIONS].join(', ')} may be used)`;
  }
  if (text.replace(/\$\{\{(.*?)\}\}/gs, 'x').includes('${{')) return 'to an unclosed expression';
  if (text.trim() === '') return 'empty';
  return undefined;
}

/**
 * The aggregate's one step must be a verdict that runs unconditionally and
 * whose script, run with the needs context GitHub would give it, fails on
 * every result but `success`. Its only expression is `${{ toJSON(needs) }}`
 * in one env variable, which is what lets it run here at all.
 */
function verdictProblems(aggregate, needs, id = AGGREGATE_JOB) {
  const label = `"${id}"`;
  const steps = Array.isArray(aggregate.steps) ? aggregate.steps : [];
  if (steps.length !== 1 || !isMapping(steps[0])) {
    return [`${label} must have exactly one step, its verdict; it only aggregates`];
  }
  const [step] = steps;
  const problems = [];
  for (const key of Object.keys(step)) {
    if (!VERDICT_KEYS.has(key)) {
      problems.push(
        `${label}'s verdict sets ${key}; it must run unconditionally, its failure failing the job`,
      );
    }
  }
  const shell = bashOptions(step.shell);
  if (typeof shell === 'string') problems.push(`${label}'s verdict ${shell}`);
  const run = typeof step.run === 'string' ? step.run : '';
  if (run.includes('${{')) {
    problems.push(`${label}'s verdict run has an expression; pass it through env`);
  }
  const env = isMapping(step.env) ? step.env : {};
  const expressions = Object.entries(env).filter(([, value]) => textOf(value).includes('${{'));
  const needsVar =
    expressions.length === 1 && squash(expressions[0][1]) === NEEDS_EXPRESSION
      ? expressions[0][0]
      : undefined;
  if (!needsVar) {
    problems.push(
      `${label}'s verdict must read the needs context from one env: ${NEEDS_EXPRESSION}`,
    );
  }
  if (problems.length > 0 || run === '' || needs.length === 0) {
    return [...problems, `${label} must fail unless every needed job's result is "success"`];
  }
  const literal = Object.fromEntries(Object.entries(env).filter(([key]) => key !== needsVar));
  for (const failure of verdictFailures(run, shell, literal, needsVar, needs)) {
    problems.push(`${label} must fail unless every needed job's result is "success": ${failure}`);
  }
  return problems;
}

/**
 * The bash options the runner runs a step with `shell` under, or why that is
 * not known here. Unset is refused rather than taken as the runner's default
 * (`bash -e {0}`, no pipefail): the verdict states its options, and they are
 * the ones it is run with below.
 */
function bashOptions(shell) {
  if (shell === undefined) {
    return 'must set shell: bash; without it the runner uses bash -e, no pipefail';
  }
  if (shell === 'bash') return BASH_OPTIONS;
  const tokens = typeof shell === 'string' ? shell.trim().split(/\s+/) : [];
  const options = tokens.slice(1, -1);
  if (
    tokens[0] !== 'bash' ||
    tokens.at(-1) !== '{0}' ||
    !options.every((token) => SHELL_TOKEN.test(token))
  ) {
    return `must set shell: bash, or "bash <options> {0}", not ${JSON.stringify(shell)}`;
  }
  return options;
}

const verdictMemo = new Map();

/**
 * Runs the verdict as the runner does, from a file under `bash <options>`,
 * for each case; returns the wrong outcomes.
 */
export function verdictFailures(run, options, env, needsVar, needs) {
  const memoKey = JSON.stringify([run, options, env, needsVar, needs]);
  if (verdictMemo.has(memoKey)) return verdictMemo.get(memoKey);
  const directory = mkdtempSync(join(tmpdir(), 'ci-integration-verdict-'));
  try {
    const script = join(directory, 'verdict.sh');
    writeFileSync(script, run);
    const failures = runVerdictCases(script, options, env, needsVar, needs);
    verdictMemo.set(memoKey, failures);
    return failures;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runVerdictCases(script, options, env, needsVar, needs) {
  const all = (result) => Object.fromEntries(needs.map((id) => [id, result]));
  const cases = [
    { what: 'every needed job succeeded', results: all('success'), pass: true },
    ...needs.flatMap((id) =>
      BAD_RESULTS.map((result) => ({
        what: `${id} ${result}`,
        results: { ...all('success'), [id]: result },
        pass: false,
      })),
    ),
    { what: 'every needed job skipped', results: all('skipped'), pass: false },
  ];
  const failures = [];
  for (const { what, results, pass } of cases) {
    const context = Object.fromEntries(
      Object.entries(results).map(([id, result]) => [id, { result, outputs: {} }]),
    );
    const outcome = spawnSync('bash', [...options, script], {
      env: {
        PATH: process.env.PATH,
        ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, textOf(value)])),
        [needsVar]: JSON.stringify(context, null, 2),
      },
      stdio: 'ignore',
      timeout: 10_000,
    });
    if (outcome.error) {
      failures.push(`could not run it (${outcome.error.message})`);
      break;
    }
    const passed = outcome.status === 0;
    if (passed !== pass) failures.push(`it ${passed ? 'passes' : 'fails'} when ${what}`);
  }
  return failures;
}
