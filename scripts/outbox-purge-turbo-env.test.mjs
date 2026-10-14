// Every OUTBOX_PURGE_* variable reaches a service that runs the purge, through
// every turbo task that starts one (D-052, Codex r1 on #247).
//
// The same trap as #242 (scripts/prisma-turbo-env.test.mjs), in the task that
// starts the services: `pnpm dev` is `turbo run dev`, and turbo withholds
// from the child every variable the task does not declare. A service reads
// the root .env itself (`node --env-file`, where the shell's value wins), so
// with `dev` declaring nothing, `OUTBOX_PURGE_ENABLED=false pnpm dev` ran with
// the purge on, and an invalid value in the shell never reached the
// validation that refuses it — while `pnpm --dir services/<svc> dev` honoured
// both.
//
// Two checks: statically, every such task allows every variable of
// `outboxPurgeEnvSchema` (read from its source, so a new variable is held to
// it at once) for every service that merges the schema; and turbo itself,
// through the root `pnpm dev`, resolves the variables for the task (a dry
// run: nothing starts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, allows, taskPatterns, turbo, workspacePackages } from './turbo-env-lib.mjs';

const CONFIG_SOURCE = 'packages/config/src/env.ts';

/**
 * Turbo tasks whose command builds a service's AppModule from its process
 * environment: `dev` runs `src/main.ts`, and the integration suites
 * (`test`, `test:integration`) build the application from `process.env`.
 * `start` is not a turbo task: `node --env-file=… dist/main.js` gets the
 * shell's environment directly.
 */
const TASKS_STARTING_A_SERVICE = ['dev', 'test', 'test:integration'];

/** The keys of `outboxPurgeEnvSchema`, read from its source. */
function purgeVariables() {
  const source = readFileSync(join(ROOT, CONFIG_SOURCE), 'utf8');
  const start = source.indexOf('export const outboxPurgeEnvSchema = z.object({');
  assert.ok(start >= 0, `${CONFIG_SOURCE} no longer defines outboxPurgeEnvSchema`);
  const end = source.indexOf('\n});', start);
  const block = source.slice(start, end);
  return [...block.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
}

/** Every service that merges the schema into its own environment — runs the purge. */
function servicesRunningThePurge() {
  const found = [];
  for (const entry of readdirSync(join(ROOT, 'services'), { withFileTypes: true })) {
    const envFile = join(ROOT, 'services', entry.name, 'src', 'config', 'env.ts');
    if (!entry.isDirectory() || !existsSync(envFile)) continue;
    if (/\.merge\(outboxPurgeEnvSchema\)/.test(readFileSync(envFile, 'utf8'))) {
      found.push(entry.name);
    }
  }
  return found;
}

test('the variable list is read from the schema itself', () => {
  const variables = purgeVariables();
  // Not empty, and it keeps finding the ones this test was written for.
  for (const name of [
    'OUTBOX_PURGE_ENABLED',
    'OUTBOX_PURGE_RETENTION_HOURS',
    'OUTBOX_PURGE_MAX_WAIT_MS',
  ]) {
    assert.ok(variables.includes(name), `${name} not found in outboxPurgeEnvSchema`);
  }
  assert.ok(variables.every((name) => name.startsWith('OUTBOX_PURGE_')));
});

test('every task that starts a service running the purge allows every OUTBOX_PURGE_* variable', () => {
  const variables = purgeVariables();
  const purging = new Set(servicesRunningThePurge());
  // The five of phase 1, at least; a sixth is held to the same rule at once.
  for (const service of [
    'fleet-service',
    'asset-service',
    'document-service',
    'maintenance-service',
    'organization-service',
  ]) {
    assert.ok(purging.has(service), `${service} no longer merges outboxPurgeEnvSchema`);
  }

  const problems = [];
  let checked = 0;
  for (const { dir, manifest } of workspacePackages()) {
    if (!purging.has(dir.split('/').at(-1))) continue;
    if (existsSync(join(dir, 'turbo.json'))) {
      problems.push(`${manifest.name} has its own turbo.json; extend this test to read it`);
    }
    // `dev` must exist and run the service: the case the finding was about.
    assert.match(manifest.scripts?.dev ?? '', /src\/main\.ts/, `${manifest.name} dev`);
    for (const task of TASKS_STARTING_A_SERVICE) {
      if (!manifest.scripts?.[task]) continue;
      assert.ok(turbo.tasks[task], `turbo.json has no "${task}" task`);
      checked += 1;
      for (const name of variables) {
        if (!allows(taskPatterns(task), name)) {
          problems.push(`turbo.json "${task}" withholds ${name} from ${manifest.name}`);
        }
      }
    }
  }
  assert.ok(checked >= purging.size, 'fewer tasks checked than services: the check ran on nothing');
  assert.deepEqual(problems, []);
});

test('the root `pnpm dev` resolves every OUTBOX_PURGE_* variable for the service (turbo dry run)', () => {
  const variables = purgeVariables();
  // Values a service refuses, as an operator's typo would be: only turbo's
  // resolution is under test, and a dry run starts nothing.
  const env = { ...process.env };
  for (const name of variables) env[name] = 'not-a-valid-value';

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
    assert.ok(configured.has(name), `turbo withholds ${name} from fleet-service's dev`);
  }
});
