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

test('the root `pnpm dev` resolves every database setting for the service (turbo dry run)', () => {
  const variables = databaseVariables();
  // Values a service refuses, as an operator's typo would be: only turbo's
  // resolution is under test, and a dry run starts nothing.
  const env = { ...process.env, DATABASE_URL_FLEET: 'not-a-url' };
  for (const name of variables) {
    if (name !== 'DATABASE_URL') env[name] = 'not-a-valid-value';
  }

  const run = spawnSync('pnpm', ['run', 'dev', '--filter=@rasta/fleet-service', '--dry=json'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  assert.equal(run.error, undefined, `pnpm did not start: ${run.error}`);
  assert.equal(run.status, 0, `turbo dry run failed:\n${run.stdout}\n${run.stderr}`);
  // pnpm echoes the script line first; the plan is the JSON after it.
  const plan = JSON.parse(run.stdout.slice(run.stdout.indexOf('\n{') + 1));
  const task = plan.tasks.find((t) => t.taskId === '@rasta/fleet-service#dev');
  assert.ok(task, 'no @rasta/fleet-service#dev in the plan');
  const configured = new Set(
    task.environmentVariables.configured.map((entry) => entry.slice(0, entry.indexOf('='))),
  );
  for (const name of variables) {
    const expected = name === 'DATABASE_URL' ? 'DATABASE_URL_FLEET' : name;
    assert.ok(configured.has(expected), `turbo withholds ${expected} from fleet-service's dev`);
  }
});
