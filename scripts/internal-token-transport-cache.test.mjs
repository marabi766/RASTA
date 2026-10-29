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
    '../../scripts/internal-token-source-rule.mjs',
    '../../scripts/internal-token-parser.mjs',
    'src/fleet/transfer-record.ts',
  ]) {
    assert.equal(typeof task.inputs[file], 'string', `lint cache must hash ${file}`);
  }
});
