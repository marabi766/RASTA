#!/usr/bin/env node
// A name filter alone exits zero even when it matches no tests. Require exactly
// one successful narrowing proof, with no failures or skips, after CI's install.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-reporter=tap',
    '--test-name-pattern=^filtered parser narrows:',
    fileURLToPath(new URL('./container-scope.test.mjs', import.meta.url)),
  ],
  { encoding: 'utf8' },
);
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
// Node can count a zero-match file itself as one pass. Require the named
// successful subtest too, rather than trusting only its aggregate counters.
const matches = result.stdout?.match(/^ok \d+ - filtered parser narrows: .+$/gm) ?? [];
const exactly = (label, count) =>
  new RegExp(`^# ${label} ${count}$`, 'm').test(result.stdout ?? '');
if (
  result.status !== 0 ||
  matches.length !== 1 ||
  !exactly('tests', 1) ||
  !exactly('pass', 1) ||
  !exactly('fail', 0) ||
  !exactly('skipped', 0)
) {
  process.stderr.write('Container scope proof requires exactly one passing narrowing test.\n');
  process.exitCode = 1;
}
