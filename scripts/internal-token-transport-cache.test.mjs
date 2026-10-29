import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ROOT } from './turbo-env-lib.mjs';

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
  for (const file of [
    '../../eslint.config.mjs',
    '../../scripts/internal-token-transport-rule.mjs',
    '../../scripts/raw-http-boundary-rule.mjs',
    'src/fleet/transfer-record.ts',
  ]) {
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
    'eslint.config.mjs',
    '../../scripts/internal-token-transport-rule.mjs',
    '../../scripts/raw-http-boundary-rule.mjs',
    'src/server/credential-fetch.ts',
    // The browser suite is linted too (PR #492 r1 F2).
    'e2e/provisioned-people.ts',
  ]) {
    assert.equal(typeof task.inputs[file], 'string', `lint cache must hash ${file}`);
  }
});
