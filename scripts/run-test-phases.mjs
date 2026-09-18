#!/usr/bin/env node
/**
 * Runs a workspace test task in two phases.
 *
 *   node scripts/run-test-phases.mjs test [-- <test-runner args>]
 *   node scripts/run-test-phases.mjs test:integration [-- <test-runner args>]
 *
 * 1. workspace  `turbo run <task>` — every package in parallel, as before; the
 *               aggregation stress spec is excluded from identity's task.
 * 2. exclusive  `turbo run test:aggregation-stress --filter=@rasta/identity-service`
 *               — that spec alone, started only after phase 1 has exited.
 *
 * Phase 2 runs even when phase 1 failed: it still starts only once every
 * workspace task has ended, and an unrelated failure must not also hide the
 * stress evidence. The exit code is the first non-zero one, so the run still
 * fails. Only a turbo that could not be started at all stops the run early.
 *
 * Arguments after `--` reach both phases. The reasoning, and the measurements
 * behind it, are in `test-phases-lib.mjs`. Each phase is announced with a UTC
 * timestamp so a log shows the order it ran in.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planTestRun } from './test-phases-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let plan;
try {
  plan = planTestRun(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

// turbo's own launcher is a node script; running it with this node avoids a
// shell, so a `--testNamePattern="(a|b)"` is never re-parsed on the way.
const turbo = join(
  dirname(createRequire(join(root, 'package.json')).resolve('turbo/package.json')),
  'bin',
  'turbo',
);

let exitCode = 0;
for (const { phase, args } of plan) {
  console.warn(
    `[test-phases] ${phase} phase started ${new Date().toISOString()}: turbo ${args.join(' ')}`,
  );
  const result = spawnSync(process.execPath, [turbo, ...args], { cwd: root, stdio: 'inherit' });
  const code = result.status ?? 1;
  console.warn(`[test-phases] ${phase} phase finished ${new Date().toISOString()}: exit ${code}`);
  if (result.error) {
    console.error(`[test-phases] could not start turbo: ${result.error.message}`);
    process.exit(code);
  }
  if (code !== 0 && exitCode === 0) exitCode = code;
}
if (exitCode !== 0) console.error(`[test-phases] failed: exit ${exitCode}`);
process.exit(exitCode);
