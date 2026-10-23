/**
 * Migration reversibility runs as parallel jobs, each against a PostgreSQL of
 * its own (task 082): `migration-reversibility-chain`, a matrix whose legs each
 * run the whole-chain check for a shard of services, and `migration-guards`,
 * the by-name verifiers and the database guards. `migration-reversibility`
 * ("Migration reversibility and database guards") is only their aggregate: the
 * check branch protection and the merge queue require by name. Until then it
 * was one job, whose reversibility step had reached 1417 s of its 28 minutes.
 *
 * What would quietly weaken the gate, and is refused here:
 *
 *   - a service with migrations that no shard of the matrix verifies, one that
 *     two shards verify, a shard with no services (its loop would pass having
 *     run nothing), or a matrix entry naming anything else;
 *   - a matrix axis besides `include`, or an entry key besides shard and
 *     services, either of which changes which legs exist;
 *   - the whole-chain step not being exactly its loop over the leg's services,
 *     or the by-name verifiers not being exactly their three commands in the
 *     order `test:migration` runs them;
 *   - a step of the single job that no job here runs any more (the database
 *     guards included), a test or guard step whose command changed, and
 *     `MIGRATION_LIB_TEST_DATABASE_REQUIRED` not 'true' (without it the
 *     verifier library's PostgreSQL cases skip themselves);
 *   - an order that changes what a step proves: migrations applied first, the
 *     in-place verifier before the seed guard, the runtime-privileges check
 *     last in each job, after its reversals;
 *   - `if:` or `continue-on-error` on either job or any of their steps;
 *   - an aggregate that does not need exactly both jobs, that does not run
 *     always() (a job skipped because its dependency failed reports
 *     "skipped", which a required check counts as passing), or whose verdict
 *     does not fail on every result but `success` — executed, not read, with
 *     the integration aggregate's harness (scripts/ci-integration-split-lib.mjs).
 *
 * And `test:migration`, the full sequential run developers use, must still run
 * every service's whole chain and the three by-name verifiers after them.
 *
 * Workflow text (or its parsed object) in, problems out.
 */
import { parse as parseYaml } from 'yaml';

import { verdictFailures } from './ci-integration-split-lib.mjs';

export const AGGREGATE_JOB = 'migration-reversibility';
export const AGGREGATE_NAME = 'Migration reversibility and database guards';
export const CHAIN_JOB = 'migration-reversibility-chain';
export const GUARDS_JOB = 'migration-guards';

const PROVISION_STEP = 'Provision databases, roles and extensions';
const MIGRATE_STEP = 'Apply migrations';
const CHAIN_STEP = 'Migration reversibility, whole chain';
const BY_NAME_STEP = 'Migration reversibility, by-name verifiers';
const LIB_STEP = 'Migration verifier library, against PostgreSQL';
const B2_STEP = "Outbox B2 vacuum is the owner's, and verified (D-045)";
const SEED_STEP = 'Demo seeds refuse outside development and test';
const PRIVILEGES_STEP = 'Runtime roles own nothing (D-045), after the reversals';

/** The whole-chain loop, line by line. */
export const CHAIN_RUN = [
  'test -n "${MIGRATION_SERVICES}"',
  'for service in ${MIGRATION_SERVICES}; do',
  'node scripts/verify-migration-reversible.mjs "${service}"',
  'done',
];
const CHAIN_ENV = { MIGRATION_SERVICES: '${{ matrix.services }}' };

/** The by-name verifiers, in `test:migration`'s order. */
export const BY_NAME_COMMANDS = [
  'node scripts/verify-outbox-claim-migration.mjs --in-place',
  'node scripts/verify-security-event-outbox-migration.mjs',
  'node scripts/verify-audit-correction-command-migration.mjs',
];

/**
 * Each job's steps, in the order they must run, with the exact command of the
 * ones that test or guard something (`undefined`: present, command not pinned).
 */
const JOB_STEPS = {
  [CHAIN_JOB]: [
    { name: PROVISION_STEP },
    { name: MIGRATE_STEP, run: ['pnpm run db:migrate'] },
    { name: CHAIN_STEP, run: CHAIN_RUN, env: CHAIN_ENV },
    { name: PRIVILEGES_STEP, run: ['pnpm run check:db-runtime-privileges'], last: true },
  ],
  [GUARDS_JOB]: [
    { name: PROVISION_STEP },
    { name: MIGRATE_STEP, run: ['pnpm run db:migrate'] },
    { name: BY_NAME_STEP, run: BY_NAME_COMMANDS },
    {
      name: LIB_STEP,
      run: ['pnpm run test:migration-lib'],
      env: { MIGRATION_LIB_TEST_DATABASE_REQUIRED: 'true' },
    },
    { name: B2_STEP, run: ['pnpm run test:outbox-b2-vacuum-pg'] },
    { name: SEED_STEP, run: ['pnpm run test:seed-guard:db'] },
    { name: PRIVILEGES_STEP, run: ['pnpm run check:db-runtime-privileges'], last: true },
  ],
};

const BASH_OPTIONS = ['--noprofile', '--norc', '-eo', 'pipefail'];
const NEEDS_EXPRESSION = '${{ toJSON(needs) }}';

const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const squash = (text) => String(text).replace(/\s+/g, ' ').trim();

/** A run script's commands: comment and blank lines aside, each line trimmed. */
function commands(run) {
  return String(run ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** The chain matrix's shards, as listed: `[{ shard, services: [...] }]`. */
export function chainShards(workflow) {
  const include = workflow?.jobs?.[CHAIN_JOB]?.strategy?.matrix?.include;
  if (!Array.isArray(include)) return [];
  return include.map((entry) => ({
    shard: isMapping(entry) ? entry.shard : undefined,
    services: isMapping(entry)
      ? String(entry.services ?? '')
          .split(/\s+/)
          .filter(Boolean)
      : [],
  }));
}

export function checkMigrationReversibilityText(text, options) {
  return checkMigrationReversibility(parseYaml(text), options);
}

/**
 * @param workflow the parsed ci.yml
 * @param options.services every service that ships migrations
 * @param options.testMigration the root package's `test:migration` script
 */
export function checkMigrationReversibility(workflow, { services, testMigration }) {
  const jobs = isMapping(workflow?.jobs) ? workflow.jobs : {};
  const problems = [];
  for (const id of [CHAIN_JOB, GUARDS_JOB, AGGREGATE_JOB]) {
    if (!isMapping(jobs[id])) problems.push(`no "${id}" job`);
  }
  if (problems.length > 0) return problems;

  problems.push(...matrixProblems(jobs[CHAIN_JOB], services));
  for (const id of [CHAIN_JOB, GUARDS_JOB]) problems.push(...jobProblems(id, jobs[id]));
  problems.push(...aggregateProblems(jobs[AGGREGATE_JOB]));
  problems.push(...testMigrationProblems(testMigration, services));
  return problems;
}

function matrixProblems(job, services) {
  const label = `"${CHAIN_JOB}"`;
  const problems = [];
  const strategy = isMapping(job.strategy) ? job.strategy : {};
  const matrix = isMapping(strategy.matrix) ? strategy.matrix : {};
  const axes = Object.keys(matrix).filter((key) => key !== 'include');
  if (axes.length > 0) problems.push(`${label}'s matrix has ${axes.join(', ')} beside include`);
  if (!Array.isArray(matrix.include) || matrix.include.length === 0) {
    return [...problems, `${label} has no matrix include: no shard runs`];
  }
  for (const [i, entry] of matrix.include.entries()) {
    const keys = isMapping(entry) ? Object.keys(entry) : [];
    const extra = keys.filter((key) => key !== 'shard' && key !== 'services');
    if (extra.length > 0) problems.push(`${label} shard #${i + 1} sets ${extra.join(', ')}`);
  }

  const seen = new Map();
  const names = new Set();
  for (const { shard, services: listed } of chainShards({ jobs: { [CHAIN_JOB]: job } })) {
    if (shard === undefined || squash(shard) === '')
      problems.push(`${label} has a shard with no name`);
    else if (names.has(String(shard))) problems.push(`${label} has two shards named ${shard}`);
    names.add(String(shard));
    if (listed.length === 0) problems.push(`${label} shard ${shard} lists no services`);
    for (const service of listed) {
      if (seen.has(service)) {
        problems.push(`${service} is in shards ${seen.get(service)} and ${shard}`);
      } else {
        seen.set(service, String(shard));
      }
      if (!services.includes(service)) {
        problems.push(`shard ${shard} lists ${service}, which is not a service with migrations`);
      }
    }
  }
  for (const service of services) {
    if (!seen.has(service))
      problems.push(`${service} has migrations and is in no shard of ${label}`);
  }
  return problems;
}

function jobProblems(id, job) {
  const label = `"${id}"`;
  const problems = [];
  for (const key of ['if', 'continue-on-error']) {
    if (key in job) problems.push(`${label} sets ${key}`);
  }
  if (!isMapping(job.services?.postgres)) problems.push(`${label} starts no postgres service`);
  const steps = Array.isArray(job.steps) ? job.steps.filter(isMapping) : [];
  for (const step of steps) {
    for (const key of ['if', 'continue-on-error']) {
      if (key in step)
        problems.push(`${label}: "${step.name ?? step.uses ?? step.run}" sets ${key}`);
    }
  }

  let previous = -1;
  for (const expected of JOB_STEPS[id]) {
    const index = steps.findIndex((step) => step.name === expected.name);
    if (index < 0) {
      problems.push(`${label} does not run "${expected.name}"`);
      continue;
    }
    const step = steps[index];
    if (index < previous) problems.push(`${label} runs "${expected.name}" out of order`);
    previous = Math.max(previous, index);
    if (expected.last && index !== steps.length - 1) {
      problems.push(`${label}'s "${expected.name}" must be its last step, after the reversals`);
    }
    if (expected.run && JSON.stringify(commands(step.run)) !== JSON.stringify(expected.run)) {
      problems.push(`${label}'s "${expected.name}" must run exactly: ${expected.run.join('; ')}`);
    }
    const env = isMapping(step.env) ? step.env : {};
    for (const [key, value] of Object.entries(expected.env ?? {})) {
      if (squash(env[key] ?? '') !== squash(value)) {
        problems.push(`${label}'s "${expected.name}" must set ${key}: ${value}`);
      }
    }
  }
  return problems;
}

function aggregateProblems(job) {
  const label = `"${AGGREGATE_JOB}"`;
  const problems = [];
  if (job.name !== AGGREGATE_NAME) problems.push(`${label} must be named "${AGGREGATE_NAME}"`);
  const needs = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
  const expected = [CHAIN_JOB, GUARDS_JOB];
  if (needs.length !== expected.length || !expected.every((id) => needs.includes(id))) {
    problems.push(`${label} must need exactly ${expected.join(' and ')}`);
  }
  if (!['${{ always() }}', 'always()'].includes(squash(job.if ?? ''))) {
    problems.push(`${label} must run if: \${{ always() }}, so a skipped job fails it`);
  }
  if ('continue-on-error' in job) problems.push(`${label} sets continue-on-error`);

  const steps = Array.isArray(job.steps) ? job.steps : [];
  const [step] = steps;
  if (steps.length !== 1 || !isMapping(step)) {
    return [...problems, `${label} must have exactly one step, its verdict`];
  }
  for (const key of Object.keys(step)) {
    if (!['name', 'shell', 'env', 'run'].includes(key))
      problems.push(`${label}'s verdict sets ${key}`);
  }
  if (step.shell !== 'bash') problems.push(`${label}'s verdict must set shell: bash`);
  const env = isMapping(step.env) ? step.env : {};
  if (Object.keys(env).length !== 1 || squash(env.NEEDS ?? '') !== NEEDS_EXPRESSION) {
    problems.push(`${label}'s verdict must read the needs context from one env: NEEDS`);
  }
  const run = typeof step.run === 'string' ? step.run : '';
  if (run.includes('${{')) problems.push(`${label}'s verdict run has an expression`);
  if (problems.length > 0 || run === '') {
    return [...problems, `${label} must fail unless every needed job's result is "success"`];
  }
  for (const failure of verdictFailures(run, BASH_OPTIONS, {}, 'NEEDS', expected)) {
    problems.push(`${label} must fail unless every needed job's result is "success": ${failure}`);
  }
  return problems;
}

function testMigrationProblems(script, services) {
  const problems = [];
  const parts = String(script ?? '')
    .split('&&')
    .map((part) => squash(part));
  const chained = parts
    .map((part) => /^node scripts\/verify-migration-reversible\.mjs (\S+)$/.exec(part)?.[1])
    .filter(Boolean);
  for (const service of services) {
    if (!chained.includes(service))
      problems.push(`${service} is not in the root test:migration chain`);
  }
  const lastChain = parts.findLastIndex((part) => part.includes('verify-migration-reversible.mjs'));
  if (JSON.stringify(parts.slice(lastChain + 1)) !== JSON.stringify(BY_NAME_COMMANDS)) {
    problems.push(`test:migration must end with ${BY_NAME_COMMANDS.join(' && ')}`);
  }
  return problems;
}
