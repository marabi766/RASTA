// Every variable of databaseEnvSchema reaches a service through every turbo
// task that starts one (Codex r1 on #268).
//
// The trap of scripts/outbox-purge-turbo-env.test.mjs (D-052), for the
// database settings: `pnpm dev` is `turbo run dev`, and turbo withholds from
// the child every variable the task does not declare. With `dev` declaring
// none of them, `DATABASE_POOL_SIZE=2 pnpm dev` ran on Prisma's default pool,
// and a malformed value in the shell never reached the check that refuses it.
//
// Two checks: statically, every such task allows every variable of
// `databaseEnvSchema` (read from its source, so a new variable is held to it
// at once) for every service that merges the schema; and turbo itself,
// through the root `pnpm dev`, resolves the variables for the task (a dry
// run: nothing starts).
//
// `DATABASE_URL` is the one variable a service receives under another name:
// each loader reads `source.DATABASE_URL ?? source.DATABASE_URL_<SVC>` (audit
// only the latter), and `dev` passes only the per-service name on purpose
// (turbo.json), so that name is what each task must allow.
//
// Codex r4 on #268 (F2), the same rule for two more lists, each derived from
// source: every setting a service's operation budgets are computed from (its
// src/config/operation-budgets.ts and the shared `…OperationBudget(env)`
// helpers it calls) — loadEnv holds DATABASE_STATEMENT_TIMEOUT_MS above them —
// and every setting of the construction and gateway configurations, whose
// tender caps and deadlines (#250) arrived undeclared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, allows, taskPatterns, turbo, workspacePackages } from './turbo-env-lib.mjs';

const CONFIG_SOURCE = 'packages/config/src/env.ts';

/**
 * Turbo tasks whose command builds a service's configuration from its process
 * environment: `dev` runs `src/main.ts`, the integration suites (`test`,
 * `test:integration`, identity's `test:aggregation-stress`) build the
 * application from `process.env`. `start` is not a turbo task.
 */
const TASKS_STARTING_A_SERVICE = ['dev', 'test', 'test:integration', 'test:aggregation-stress'];

/** The keys of `databaseEnvSchema`, read from its source. */
function databaseVariables() {
  const source = readFileSync(join(ROOT, CONFIG_SOURCE), 'utf8');
  const start = source.indexOf('export const databaseEnvSchema = z.object({');
  assert.ok(start >= 0, `${CONFIG_SOURCE} no longer defines databaseEnvSchema`);
  const end = source.indexOf('\n});', start);
  const block = source.slice(start, end);
  return [...block.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
}

/**
 * Every service that merges the schema, with the per-service connection
 * string its loader falls back to (`source.DATABASE_URL_<SVC>`).
 */
function servicesWithADatabase() {
  const found = new Map();
  for (const entry of readdirSync(join(ROOT, 'services'), { withFileTypes: true })) {
    const envFile = join(ROOT, 'services', entry.name, 'src', 'config', 'env.ts');
    if (!entry.isDirectory() || !existsSync(envFile)) continue;
    const source = readFileSync(envFile, 'utf8');
    if (!/\.merge\(databaseEnvSchema\)/.test(source)) continue;
    // audit-service reads only its own name, never the bare DATABASE_URL.
    const fallback = source.match(
      /DATABASE_URL:\s*(?:source\.DATABASE_URL\s*\?\?\s*)?source\.(DATABASE_URL_[A-Z0-9_]+)/,
    );
    found.set(entry.name, fallback?.[1]);
  }
  return found;
}

/** The settings a source reads as `env.NAME`. */
function settingsRead(source) {
  return [...new Set([...source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))];
}

/** Where the shared `…OperationBudget(env)` helpers are defined. */
const SHARED_BUDGET_SOURCES = [
  'packages/config/src/env.ts',
  'packages/nest-common/src/outbox/outbox.ts',
];

/** Each shared budget helper, with the settings its body reads. */
function sharedBudgetHelpers() {
  const helpers = new Map();
  for (const file of SHARED_BUDGET_SOURCES) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const match of source.matchAll(/^export function (\w+OperationBudget)\(/gm)) {
      const body = source.slice(match.index, source.indexOf('\n}\n', match.index));
      helpers.set(match[1], settingsRead(body));
    }
  }
  return helpers;
}

/**
 * Every service with an operation-budgets.ts, with the settings its budgets
 * are computed from: read there directly, or by a shared helper it hands `env`.
 */
function budgetSettings() {
  const helpers = sharedBudgetHelpers();
  const found = new Map();
  for (const entry of readdirSync(join(ROOT, 'services'), { withFileTypes: true })) {
    const file = join(ROOT, 'services', entry.name, 'src', 'config', 'operation-budgets.ts');
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    const settings = new Set(settingsRead(source));
    for (const [, helper] of source.matchAll(/\b(\w+OperationBudget)\(env\)/g)) {
      assert.ok(
        helpers.has(helper),
        `${entry.name} calls ${helper}(env), not found in a shared source`,
      );
      for (const name of helpers.get(helper)) settings.add(name);
    }
    found.set(entry.name, [...settings]);
  }
  return found;
}

/**
 * The configurations whose own settings every task starting them must pass:
 * every key of the schema named with the configuration's prefix.
 */
const CONFIGURATIONS = [
  { service: 'construction-service', prefix: 'CONSTRUCTION_' },
  { service: 'api-gateway', prefix: 'GATEWAY_' },
];

function ownSettings({ service, prefix }) {
  const source = readFileSync(join(ROOT, 'services', service, 'src', 'config', 'env.ts'), 'utf8');
  return [
    ...new Set(
      [...source.matchAll(/^ {4}([A-Z][A-Z0-9_]*):/gm)]
        .map((m) => m[1])
        .filter((name) => name.startsWith(prefix)),
    ),
  ];
}

/** Every task that starts `service` and the variables it withholds of `names`. */
function withheld(service, names) {
  const problems = [];
  const pkg = workspacePackages().find(({ dir }) => dir.split('/').at(-1) === service);
  assert.ok(pkg, `no workspace package for ${service}`);
  let checked = 0;
  for (const task of TASKS_STARTING_A_SERVICE) {
    if (!pkg.manifest.scripts?.[task]) continue;
    checked += 1;
    const patterns = taskPatterns(task);
    for (const name of names) {
      if (!allows(patterns, name)) {
        problems.push(`turbo.json "${task}" withholds ${name} from ${pkg.manifest.name}`);
      }
    }
  }
  assert.ok(checked > 0, `${service} has none of ${TASKS_STARTING_A_SERVICE.join(', ')}`);
  return problems;
}

/** The variables turbo's plan for `<package>#dev` configures, given `env` (a dry run). */
function devPlanConfigures(packageName, env) {
  const run = spawnSync('pnpm', ['run', 'dev', `--filter=${packageName}`, '--dry=json'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  assert.equal(run.error, undefined, `pnpm did not start: ${run.error}`);
  assert.equal(run.status, 0, `turbo dry run failed:\n${run.stdout}\n${run.stderr}`);
  // pnpm echoes the script line first; the plan is the JSON after it.
  const plan = JSON.parse(run.stdout.slice(run.stdout.indexOf('\n{') + 1));
  const task = plan.tasks.find((t) => t.taskId === `${packageName}#dev`);
  assert.ok(task, `no ${packageName}#dev in the plan`);
  return new Set(
    task.environmentVariables.configured.map((entry) => entry.slice(0, entry.indexOf('='))),
  );
}

test('the variable list is read from the schema itself', () => {
  const variables = databaseVariables();
  for (const name of [
    'DATABASE_URL',
    'DATABASE_POOL_SIZE',
    'DATABASE_POOL_TIMEOUT_SECONDS',
    'DATABASE_STATEMENT_TIMEOUT_MS',
  ]) {
    assert.ok(variables.includes(name), `${name} not found in databaseEnvSchema`);
  }
  assert.ok(variables.every((name) => name.startsWith('DATABASE_')));
});

test('every task that starts a service with a database allows every databaseEnvSchema variable', () => {
  const variables = databaseVariables();
  const services = servicesWithADatabase();
  // The fourteen that own a database today; a fifteenth is held to the same rule at once.
  assert.ok(services.size >= 14, `only ${services.size} services merge databaseEnvSchema`);
  for (const [service, fallback] of services) {
    assert.ok(fallback, `${service} does not read DATABASE_URL_<SVC>`);
  }

  const problems = [];
  let checked = 0;
  for (const { dir, manifest } of workspacePackages()) {
    const service = dir.split('/').at(-1);
    if (!services.has(service)) continue;
    if (existsSync(join(dir, 'turbo.json'))) {
      problems.push(`${manifest.name} has its own turbo.json; extend this test to read it`);
    }
    assert.match(manifest.scripts?.dev ?? '', /src\/main\.ts/, `${manifest.name} dev`);
    for (const task of TASKS_STARTING_A_SERVICE) {
      if (!manifest.scripts?.[task]) continue;
      assert.ok(turbo.tasks[task], `turbo.json has no "${task}" task`);
      checked += 1;
      const patterns = taskPatterns(task);
      for (const name of variables) {
        // The connection string arrives under the service's own name.
        const passed = name === 'DATABASE_URL' ? services.get(service) : name;
        if (!allows(patterns, passed)) {
          problems.push(`turbo.json "${task}" withholds ${passed} from ${manifest.name}`);
        }
      }
    }
  }
  assert.ok(
    checked >= services.size,
    'fewer tasks checked than services: the check ran on nothing',
  );
  assert.deepEqual(problems, []);
});

test('the budget settings are read from every operation-budgets.ts and the helpers it calls', () => {
  const budgets = budgetSettings();
  assert.ok(budgets.size >= 14, `only ${budgets.size} services declare operation budgets`);
  // Read directly in a service's module, and through each shared helper.
  assert.ok(budgets.get('fleet-service').includes('FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS'));
  assert.ok(budgets.get('construction-service').includes('CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS'));
  assert.ok(budgets.get('fleet-service').includes('OUTBOX_CLAIM_LEASE_SECONDS'));
  assert.ok(budgets.get('fleet-service').includes('OUTBOX_PURGE_STATEMENT_TIMEOUT_MS'));
});

test('every task that starts a service allows every setting its operation budgets are computed from', () => {
  const problems = [];
  for (const [service, names] of budgetSettings()) problems.push(...withheld(service, names));
  assert.deepEqual(problems, []);
});

test('every task that starts construction-service or the gateway allows each of its settings', () => {
  const problems = [];
  for (const configuration of CONFIGURATIONS) {
    const names = ownSettings(configuration);
    assert.ok(names.length >= 10, `only ${names.length} ${configuration.prefix} settings found`);
    problems.push(...withheld(configuration.service, names));
  }
  // The five Codex r4 found withheld are among those read.
  const read = CONFIGURATIONS.flatMap(ownSettings);
  for (const name of [
    'CONSTRUCTION_TENDER_MAX_RECEIPTS',
    'CONSTRUCTION_BID_MAX_REVISIONS',
    'CONSTRUCTION_TENDER_MAX_STANDING_BIDS',
    'CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS',
    'GATEWAY_TENDER_OPEN_TIMEOUT_MS',
  ]) {
    assert.ok(read.includes(name), `${name} not read from its configuration`);
  }
  assert.deepEqual(problems, []);
});

test('the root `pnpm dev` resolves every database setting for the service (turbo dry run)', () => {
  const variables = databaseVariables();
  const budget = budgetSettings().get('fleet-service');
  // Values a service refuses, as an operator's typo would be: only turbo's
  // resolution is under test, and a dry run starts nothing.
  const env = { DATABASE_URL_FLEET: 'not-a-url' };
  for (const name of [...variables, ...budget]) {
    if (name !== 'DATABASE_URL') env[name] = 'not-a-valid-value';
  }

  const configured = devPlanConfigures('@rasta/fleet-service', env);
  for (const name of [...variables, ...budget]) {
    const expected = name === 'DATABASE_URL' ? 'DATABASE_URL_FLEET' : name;
    assert.ok(configured.has(expected), `turbo withholds ${expected} from fleet-service's dev`);
  }
});

test('the root `pnpm dev` resolves construction’s and the gateway’s settings (turbo dry run)', () => {
  for (const configuration of CONFIGURATIONS) {
    const names = [
      ...ownSettings(configuration),
      ...(budgetSettings().get(configuration.service) ?? []),
    ];
    const env = Object.fromEntries(names.map((name) => [name, 'not-a-valid-value']));
    const configured = devPlanConfigures(`@rasta/${configuration.service}`, env);
    for (const name of names) {
      assert.ok(
        configured.has(name),
        `turbo withholds ${name} from ${configuration.service}'s dev`,
      );
    }
  }
});
