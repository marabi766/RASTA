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
 *   - an aggregate that runs only on success(): a job skipped because its
 *     dependency failed reports "skipped", which a required check counts as
 *     passing, so it must run always() and fail unless every result is
 *     `success`;
 *   - a step of the old single job that no split job runs any more, or that
 *     two of them run;
 *   - a step started without the infrastructure it reads (broker, bucket,
 *     scanner, Redis, a provisioned and migrated PostgreSQL), or a job that
 *     starts infrastructure none of its steps reads;
 *   - a test run outside turbo with nothing having built the packages its
 *     suites resolve to their dist.
 *
 * Pure: workflow text (or its parsed object) in, problems out.
 */
import { parse as parseYaml } from 'yaml';

export const AGGREGATE_JOB = 'integration';
export const AGGREGATE_NAME = 'Integration and security tests';
export const SPLIT_PREFIX = 'integration-';

/** Every test and guard step the single job ran, each to run in exactly one split job. */
export const SPLIT_STEPS = Object.freeze([
  'Integration tests',
  'Economic coverage gate',
  'Marketplace coverage gate',
  'Document coverage gate',
  'Supplier coverage gate',
  'Construction coverage gate',
  'Contract coverage gate',
  'Inventory coverage gate',
  'Audit coverage gate',
  'Notification coverage gate',
  'Organization coverage gate',
  'Test independence (F-25)',
  'Tenant isolation and authorization tests',
  'Outbox stream-sequence protocol (ADR-051 B3)',
  'Supplier privilege split, upgraded from main',
  'Runtime roles own nothing (D-045)',
  'Runtime-role check and the generic split, on a throwaway database',
  'Every database session runs in UTC (L7-37)',
  'The runtime pool and statement timeout come from configuration',
  'Retry replay, published as ops-replay',
]);

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

  if (splitIds.length === 0) problems.push(`no ${SPLIT_PREFIX}* jobs`);
  if (!isMapping(aggregate)) {
    problems.push(`no "${AGGREGATE_JOB}" job`);
  } else {
    if (aggregate.name !== AGGREGATE_NAME) {
      problems.push(`"${AGGREGATE_JOB}" must be named "${AGGREGATE_NAME}" (the required check)`);
    }
    const needs = listOf(aggregate.needs);
    for (const id of splitIds) {
      if (!needs.includes(id)) problems.push(`"${AGGREGATE_JOB}" does not need ${id}`);
    }
    for (const id of needs) {
      if (!splitIds.includes(id)) problems.push(`"${AGGREGATE_JOB}" needs ${id}, not a split job`);
    }
    if (!/\balways\(\)/.test(String(aggregate.if ?? ''))) {
      problems.push(
        `"${AGGREGATE_JOB}" must run if: always(); a skipped required check counts as passing`,
      );
    }
    const steps = Array.isArray(aggregate.steps) ? aggregate.steps.filter(isMapping) : [];
    const verdict = steps.some(
      (step) =>
        Object.values(isMapping(step.env) ? step.env : {}).some((value) =>
          /toJSON\(\s*needs\s*\)/.test(String(value)),
        ) &&
        /!==\s*"success"/.test(String(step.run ?? '')) &&
        /process\.exit\(1\)/.test(String(step.run ?? '')),
    );
    if (!verdict) {
      problems.push(`"${AGGREGATE_JOB}" must fail unless every needed job's result is "success"`);
    }
    if (steps.some((step) => SPLIT_STEPS.includes(step.name))) {
      problems.push(`"${AGGREGATE_JOB}" runs a test step itself; it only aggregates`);
    }
  }

  const seen = new Map(SPLIT_STEPS.map((name) => [name, []]));
  for (const id of splitIds) {
    const job = jobs[id];
    if (!listOf(job.needs).includes('quality')) problems.push(`${id} must need quality`);
    const services = isMapping(job.services) ? job.services : {};
    const steps = Array.isArray(job.steps) ? job.steps.filter(isMapping) : [];
    const env = (step) => (isMapping(step.env) ? step.env : {});
    const run = (step) => String(step.run ?? '');
    const indexOf = (name) => steps.findIndex((step) => step.name === name);
    const uses = (key) => steps.some((step) => key in env(step));

    steps.forEach((step, index) => {
      if (seen.has(step.name)) seen.get(step.name).push(id);
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
