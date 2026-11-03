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
const stdout = result.stdout ?? '';
// Node can count a zero-match file itself as one pass. Require the named
// successful subtest too, rather than trusting only its aggregate counters.
// A line starts after a real \n only (`(?<![^\n])`): in a multiline regular
// expression `^` would also start a line after a printed \r.
const matches = stdout.match(/(?<![^\n])ok \d+ - filtered parser narrows: [^\n]+/g) ?? [];
// The counters are read from the runner's own closing block only: the plan
// line and the eight summary lines that END the output. Whatever a test prints
// is re-emitted earlier in the stream as `# <line>`, so a test that prints
// `tests 1` or `pass 1` itself can never stand in for the real summary. The
// anchor is the end of the output; a different layout fails closed.
const SUMMARY_KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const summary = stdout.match(
  new RegExp(
    `(?<![^\\n])1\\.\\.(\\d+)\\n${SUMMARY_KEYS.map((key) => `# ${key} (\\d+)\\n`).join('')}# duration_ms [0-9.eE+-]+\\n(?![\\s\\S])`,
  ),
);
const counted = summary && Object.fromEntries(SUMMARY_KEYS.map((key, i) => [key, summary[i + 2]]));
if (
  result.status !== 0 ||
  matches.length !== 1 ||
  !summary ||
  summary[1] !== '1' ||
  counted.tests !== '1' ||
  counted.suites !== '0' ||
  counted.pass !== '1' ||
  counted.fail !== '0' ||
  counted.cancelled !== '0' ||
  counted.skipped !== '0' ||
  counted.todo !== '0'
) {
  process.stderr.write('Container scope proof requires exactly one passing narrowing test.\n');
  process.exitCode = 1;
}
