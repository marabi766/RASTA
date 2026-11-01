import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { ROOT } from './turbo-env-lib.mjs';

/**
 * Every repository file a lint config loads: the config and, transitively,
 * each module it imports by a relative path (the rules and what they import).
 * Turbo must hash all of them, or a changed rule replays a cached lint.
 */
function lintClosure(config) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const [, specifier] of text.matchAll(
      /^\s*(?:import|export)\b[^'"]*?['"](\.{1,2}\/[^'"]+)['"]/gm,
    )) {
      visit(resolve(dirname(file), specifier));
    }
  };
  visit(config);
  return [...seen];
}

/** The files `lintClosure` finds, as turbo names a workspace's inputs. */
const closureInputs = (workspace) =>
  lintClosure(join(ROOT, workspace, 'eslint.config.mjs')).map((file) =>
    relative(join(ROOT, workspace), file),
  );

test('the lint closure is read: rules and the modules they import', () => {
  const inputs = closureInputs('services/fleet-service');
  for (const file of [
    '../../scripts/internal-token-source-rule.mjs',
    '../../scripts/test-only-path.mjs',
    '../../scripts/no-zod-default-rule.mjs',
  ]) {
    assert.ok(inputs.includes(file), `${file} in ${inputs}`);
  }
});

test('Turbo hashes the shared internal transport lint policy and the sending workspace source', () => {
  const run = spawnSync(
    'pnpm',
    ['exec', 'turbo', 'run', 'lint', '--filter=@rasta/fleet-service', '--dry=json'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
    },
  );
  assert.equal(run.status, 0, run.stderr);
  const task = JSON.parse(run.stdout).tasks.find(
    (task) => task.taskId === '@rasta/fleet-service#lint',
  );
  assert.ok(task, 'fleet lint task must exist');
  for (const file of [...closureInputs('services/fleet-service'), 'src/fleet/transfer-record.ts']) {
    assert.equal(typeof task.inputs[file], 'string', `lint cache must hash ${file}`);
  }
});

test('Turbo hashes the shared rule for the portal lint too (Q-155)', () => {
  const run = spawnSync(
    'pnpm',
    ['exec', 'turbo', 'run', 'lint', '--filter=@rasta/web', '--dry=json'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
    },
  );
  assert.equal(run.status, 0, run.stderr);
  const task = JSON.parse(run.stdout).tasks.find((task) => task.taskId === '@rasta/web#lint');
  assert.ok(task, 'web lint task must exist');
  for (const file of [
    ...closureInputs('apps/web'),
    'src/server/credential-fetch.ts',
    // The browser suite is linted too (PR #492 r1 F2).
    'e2e/provisioned-people.ts',
  ]) {
    assert.equal(typeof task.inputs[file], 'string', `lint cache must hash ${file}`);
  }
});

test('every lint task hashes every module its eslint config loads', () => {
  const run = spawnSync('pnpm', ['exec', 'turbo', 'run', 'lint', '--dry=json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
  });
  assert.equal(run.status, 0, run.stderr);
  const tasks = JSON.parse(run.stdout).tasks.filter((task) => task.task === 'lint');
  let checked = 0;
  for (const task of tasks) {
    const config = join(ROOT, task.directory, 'eslint.config.mjs');
    if (!existsSync(config)) continue;
    checked += 1;
    for (const file of closureInputs(task.directory)) {
      assert.equal(typeof task.inputs[file], 'string', `${task.taskId} must hash ${file}`);
    }
  }
  assert.ok(checked >= 26, `only ${checked} lint tasks with an eslint config`);
});
