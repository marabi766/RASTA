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
 *     succeeded. It must be the aggregate's only step, with no condition;
 *   - `continue-on-error`, `if:`, `strategy` or `defaults` on a split job or
 *     the aggregate, `continue-on-error` or `if:` on any step of one (the
 *     allowlist below is empty: main has none), and `defaults` for the whole
 *     workflow, which would change the shell every step runs in;
 *   - a test or guard step whose `run` is not exactly its declared command
 *     (comments and blank lines aside), so `true`, `cmd || true` or an `echo`
 *     of the command are refused; that lacks an environment variable it was
 *     declared with (without KAFKA_BROKERS the broker suites skip themselves,
 *     without RETRY_REPLAY_REQUIRED retry replay does); that has any key but
 *     name, run, env and timeout-minutes (so no `shell`, `working-directory`,
 *     `if` or `continue-on-error`); or whose time limit is missing, above its
 *     declared one or above its job's;
 *   - a step of the inventory that no split job runs any more, or that two of
 *     them run;
 *   - a step started without the infrastructure it reads (broker, bucket,
 *     scanner, Redis, a provisioned and migrated PostgreSQL), or a job that
 *     starts infrastructure none of its steps reads;
 *   - a test run outside turbo with nothing having built the packages its
 *     suites resolve to their dist.
 *
 * Workflow text (or its parsed object) in, problems out. The one side effect
 * is running the verdict script under bash, memoised per script.
 */
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

export const AGGREGATE_JOB = 'integration';
export const AGGREGATE_NAME = 'Integration and security tests';
export const SPLIT_PREFIX = 'integration-';

/** Present, any value. */
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
const POSTGRES = { PGHOST: ANY, PGPORT: ANY, PGUSER: ANY, PGPASSWORD: ANY };

const withKafka = (principal, ...commands) => [
  `kafka_credentials="$(bash infrastructure/docker/kafka/kafka-credentials.sh ${principal})"`,
  'eval "${kafka_credentials}"',
  ...commands,
];
const coverageGate = (service, env = {}) => ({
  run: withKafka('tests', `pnpm --filter @rasta/${service}-service run test:coverage`),
  env: { ...KAFKA_TESTS, ...databases(service.toUpperCase()), ...env },
  timeout: 8,
});
const postgresGuard = (command) => ({ run: [command], env: POSTGRES, timeout: 5 });

/**
 * Every test and guard step the single job ran, each to run in exactly one
 * split job: its command lines, the environment it must keep (exact value, or
 * ANY), and the most minutes it may take.
 */
export const STEP_INVENTORY = Object.freeze({
  'Integration tests': {
    run: withKafka('tests', 'pnpm run test:integration'),
    env: {
      ...KAFKA_TESTS,
      ...databases(...SERVICES),
      ...BUCKET,
      ...SCANNER,
      REDIS_URL: ANY,
    },
    timeout: 12,
  },
  'Economic coverage gate': coverageGate('economic'),
  'Marketplace coverage gate': coverageGate('marketplace'),
  'Document coverage gate': coverageGate('document', { ...BUCKET, ...SCANNER }),
  'Supplier coverage gate': coverageGate('supplier'),
  'Construction coverage gate': coverageGate('construction'),
  'Contract coverage gate': coverageGate('contract'),
  'Inventory coverage gate': coverageGate('inventory'),
  'Audit coverage gate': coverageGate('audit'),
  'Notification coverage gate': coverageGate('notification'),
  'Organization coverage gate': coverageGate('organization'),
  'Test independence (F-25)': {
    run: withKafka('tests', 'pnpm run test:independence'),
    env: { ...KAFKA_TESTS, ...databases('MAINTENANCE') },
    timeout: 8,
  },
  'Tenant isolation and authorization tests': {
    run: withKafka(
      'tests',
      'pnpm run test -- --testNamePattern="(tenant|isolation|authorization|subtree visibility)"',
      'pnpm run test:integration -- --testNamePattern="(tenant|isolation|exclusivity|duplicate|provenance|immutab|balance|concurren|idempot|atomic|dispute|overspend|cap)"',
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
  'Runtime-role check and the generic split, on a throwaway database': postgresGuard(
    'pnpm run test:db-runtime-privileges',
  ),
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
 * Empty: no split job, and no step of one, has a condition on main, so every
 * step runs on every pull request and push. A failure()-only diagnostic step
 * would be a legitimate entry, with its reason.
 */
export const ALLOWED_CONDITIONS = Object.freeze([]);

/** The keys a test step, and the verdict, may have: nothing that skips it, forgives it or changes its shell. */
const STEP_KEYS = new Set(['name', 'run', 'env', 'timeout-minutes']);
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
const squash = (value) => String(value).replace(/\s+/g, ' ').trim();
const commandLines = (run) =>
  String(run ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
const isMinutes = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function checkIntegrationSplitText(text) {
  let workflow;
  try {
    workflow = parseYaml(text);
  } catch (error) {
    return [`ci.yml is not valid YAML: ${error.message}`];
  }
  return checkIntegrationSplit(workflow);
}

export function checkIntegrationSplit(workflow) {
  const problems = [];
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
      problems.push(`${id} has no timeout-minutes (a positive number)`);
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
    if (!listOf(job.needs).includes('quality')) problems.push(`${id} must need quality`);
    jobLevel(id, job);
    const services = isMapping(job.services) ? job.services : {};
    const steps = Array.isArray(job.steps) ? job.steps.filter(isMapping) : [];
    const env = (step) => (isMapping(step.env) ? step.env : {});
    const run = (step) => String(step.run ?? '');
    const indexOf = (name) => steps.findIndex((step) => step.name === name);
    const uses = (key) => steps.some((step) => key in env(step));

    steps.forEach((step, index) => {
      const label = `${id}: "${step.name ?? step.uses ?? step.run ?? `step ${index + 1}`}"`;
      if ('continue-on-error' in step && step['continue-on-error'] !== false) {
        problems.push(`${label} sets continue-on-error: its failure would not fail the job`);
      }
      if ('if' in step) {
        const allowed = ALLOWED_CONDITIONS.some(
          (entry) => entry.job === id && entry.step === step.name && entry.if === step.if,
        );
        if (!allowed) problems.push(`${label} has if: ${step.if}, which can skip it`);
      }
      const declared = STEP_INVENTORY[step.name];
      if (declared) {
        seen.get(step.name).push(id);
        problems.push(...testStepProblems(label, step, declared, job['timeout-minutes']));
      }

      const before = (name) => {
        const at = indexOf(name);
        return at >= 0 && at < index;
      };
      const needsInfra = (condition, what, present) => {
        if (condition && !present) problems.push(`${id}: "${step.name}" runs without ${what}`);
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
      const database =
        vars.some((key) => key.startsWith('DATABASE_URL_')) || vars.includes('PGHOST');
      needsInfra(
        database,
        `a postgres service container provisioned ("${PROVISION_STEP}") before it`,
        'postgres' in services && before(PROVISION_STEP),
      );
      needsInfra(
        database && step.name !== MIGRATE_STEP,
        `"${MIGRATE_STEP}" before it`,
        before(MIGRATE_STEP),
      );
      if (UNBUILT.some((pattern) => pattern.test(run(step)))) {
        const built = steps
          .slice(0, index)
          .some((earlier) => earlier.name === BUILD_STEP || TURBO_BUILDS.test(run(earlier)));
        if (!built) {
          problems.push(
            `${id}: "${step.name}" needs the packages built before it ("${BUILD_STEP}")`,
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
  }
  for (const [name, where] of seen) {
    if (where.length === 0) problems.push(`no ${SPLIT_PREFIX}* job runs "${name}"`);
    if (where.length > 1) problems.push(`"${name}" runs in more than one job: ${where.join(', ')}`);
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
  for (const [key, value] of Object.entries(declared.env)) {
    if (!(key in env)) problems.push(`${label} lost ${key} from its env`);
    else if (value !== ANY && String(env[key]) !== value) {
      problems.push(`${label} must set ${key}: ${value}, not ${env[key]}`);
    }
  }
  const minutes = step['timeout-minutes'];
  if (!isMinutes(minutes)) {
    problems.push(`${label} has no timeout-minutes (at most ${declared.timeout})`);
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
 * The aggregate's one step must be a verdict that runs unconditionally and
 * whose script, run with the needs context GitHub would give it, fails on
 * every result but `success`. Its only expression is `${{ toJSON(needs) }}`
 * in one env variable, which is what lets it run here at all.
 */
function verdictProblems(aggregate, needs) {
  const label = `"${AGGREGATE_JOB}"`;
  const steps = Array.isArray(aggregate.steps) ? aggregate.steps : [];
  if (steps.length !== 1 || !isMapping(steps[0])) {
    return [`${label} must have exactly one step, its verdict; it only aggregates`];
  }
  const [step] = steps;
  const problems = [];
  for (const key of Object.keys(step)) {
    if (!STEP_KEYS.has(key)) {
      problems.push(
        `${label}'s verdict sets ${key}; it must run unconditionally, its failure failing the job`,
      );
    }
  }
  const run = typeof step.run === 'string' ? step.run : '';
  if (run.includes('${{')) {
    problems.push(`${label}'s verdict run has an expression; pass it through env`);
  }
  const env = isMapping(step.env) ? step.env : {};
  const expressions = Object.entries(env).filter(([, value]) => String(value).includes('${{'));
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
  for (const failure of verdictFailures(run, literal, needsVar, needs)) {
    problems.push(`${label} must fail unless every needed job's result is "success": ${failure}`);
  }
  return problems;
}

const verdictMemo = new Map();

/** Runs the verdict as the runner does (bash -eo pipefail) for each case; returns the wrong outcomes. */
export function verdictFailures(run, env, needsVar, needs) {
  const memoKey = JSON.stringify([run, env, needsVar, needs]);
  if (verdictMemo.has(memoKey)) return verdictMemo.get(memoKey);
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
    const outcome = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], {
      env: {
        PATH: process.env.PATH,
        ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])),
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
  verdictMemo.set(memoKey, failures);
  return failures;
}
