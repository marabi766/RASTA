// Every CONSTRUCTION_* setting reaches construction-service through every turbo
// task that starts it (Codex r1 on #271).
//
// The trap of scripts/outbox-purge-turbo-env.test.mjs (D-052) once more, for
// the service's own settings: `pnpm dev` is `turbo run dev`, and turbo
// withholds from the child every variable the task does not declare. The
// service reads the root .env itself (`node --env-file`, where the shell's
// value wins), so undeclared, `CONSTRUCTION_TRANSACTION_TIMEOUT_MS=60000 pnpm
// dev` ran on the .env value, and an invalid value in the shell never reached
// the validation that refuses it.
//
// Two checks: statically, every such task allows every CONSTRUCTION_* key of
// `constructionEnvSchema` (read from its source, so a new setting is held to
// it at once); and turbo itself, through the root `pnpm dev`, resolves them
// for the task (a dry run: nothing starts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, allows, taskPatterns, turbo, readJson } from './turbo-env-lib.mjs';

const SERVICE_DIR = join(ROOT, 'services', 'construction-service');
const ENV_SOURCE = join(SERVICE_DIR, 'src', 'config', 'env.ts');
const PACKAGE = '@rasta/construction-service';

/**
 * Turbo tasks whose command builds the service's AppModule (or its
 * configuration) from its process environment: `dev` runs `src/main.ts`, the
 * integration suites build the application from `process.env`, and `test` is
 * held too, as for the purge.
 */
const TASKS_STARTING_THE_SERVICE = ['dev', 'test', 'test:integration'];

/** The CONSTRUCTION_* keys of `constructionEnvSchema`, read from its source. */
function constructionVariables() {
  const source = readFileSync(ENV_SOURCE, 'utf8');
  const start = source.indexOf('export const constructionEnvSchema = ');
  assert.ok(start >= 0, 'construction env.ts no longer defines constructionEnvSchema');
  return [...source.slice(start).matchAll(/^ {4}(CONSTRUCTION_[A-Z0-9_]*):/gm)].map((m) => m[1]);
}

test('the variable list is read from the schema itself', () => {
  const variables = constructionVariables();
  // Not empty, and it keeps finding the ones this test was written for.
  for (const name of [
    'CONSTRUCTION_TRANSACTION_TIMEOUT_MS',
    'CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS',
    'CONSTRUCTION_TENDER_MAX_STANDING_BIDS',
    'CONSTRUCTION_PROJECT_ROLES',
  ]) {
    assert.ok(variables.includes(name), `${name} not found in constructionEnvSchema`);
  }
});

test('every task that starts construction-service allows every CONSTRUCTION_* variable', () => {
  const variables = constructionVariables();
  const manifest = readJson(join(SERVICE_DIR, 'package.json'));
  assert.equal(manifest.name, PACKAGE);
  assert.ok(
    !existsSync(join(SERVICE_DIR, 'turbo.json')),
    `${PACKAGE} has its own turbo.json; extend this test to read it`,
  );
  // `dev` must exist and run the service: the case the finding was about.
  assert.match(manifest.scripts?.dev ?? '', /src\/main\.ts/, `${PACKAGE} dev`);

  const problems = [];
  let checked = 0;
  for (const task of TASKS_STARTING_THE_SERVICE) {
    if (!manifest.scripts?.[task]) continue;
    assert.ok(turbo.tasks[task], `turbo.json has no "${task}" task`);
    checked += 1;
    for (const name of variables) {
      if (!allows(taskPatterns(task), name)) {
        problems.push(`turbo.json "${task}" withholds ${name} from ${PACKAGE}`);
      }
    }
  }
  assert.ok(checked >= 2, 'dev and test:integration not both checked: the check ran on nothing');
  assert.deepEqual(problems, []);
});

test('the root `pnpm dev` resolves every CONSTRUCTION_* variable for the service (turbo dry run)', () => {
  const variables = constructionVariables();
  // Values the service refuses, as an operator's typo would be: only turbo's
  // resolution is under test, and a dry run starts nothing.
  const env = { ...process.env };
  for (const name of variables) env[name] = 'not-a-valid-value';

  const run = spawnSync('pnpm', ['run', 'dev', `--filter=${PACKAGE}`, '--dry=json'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  assert.equal(run.error, undefined, `pnpm did not start: ${run.error}`);
  assert.equal(run.status, 0, `turbo dry run failed:\n${run.stdout}\n${run.stderr}`);
  // pnpm echoes the script line first; the plan is the JSON after it.
  const plan = JSON.parse(run.stdout.slice(run.stdout.indexOf('\n{') + 1));
  const task = plan.tasks.find((t) => t.taskId === `${PACKAGE}#dev`);
  assert.ok(task, `no ${PACKAGE}#dev in the plan`);
  const configured = new Set(
    task.environmentVariables.configured.map((entry) => entry.slice(0, entry.indexOf('='))),
  );
  for (const name of variables) {
    assert.ok(configured.has(name), `turbo withholds ${name} from construction-service's dev`);
  }
});
