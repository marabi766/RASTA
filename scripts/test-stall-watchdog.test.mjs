import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STALL_MS, stallBudget } from './test-stall-watchdog.mjs';

const watchdog = fileURLToPath(new URL('./test-stall-watchdog.mjs', import.meta.url));

/** Run `node --test` with the watchdog preloaded on a fixture test file. */
function runFixture(t, source, env = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stall-watchdog-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'fixture.test.mjs');
  writeFileSync(file, source);
  const started = Date.now();
  // Inside `node --test` this variable makes a nested runner act as a child.
  const { NODE_TEST_CONTEXT: _context, ...inherited } = process.env;
  const result = spawnSync(process.execPath, ['--test', '--import', watchdog, file], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...inherited, RASTA_TEST_STALL_MS: '1500', ...env },
  });
  return { ...result, output: `${result.stdout}${result.stderr}`, ms: Date.now() - started };
}

test('a synchronous spin is killed and the spinning test is named', (t) => {
  const result = runFixture(
    t,
    `import test from 'node:test';
     test('fast first', () => {});
     test('the spinning test', () => { for (;;); });
     test('never reached', () => {});`,
  );
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /TEST STALL: test "the spinning test" is still running/);
  assert.doesNotMatch(result.output, /never reached/);
  assert.ok(result.ms < 15_000, `killed in ${result.ms} ms`);
});

test('an asynchronous hang past the budget is killed and named', (t) => {
  const result = runFixture(
    t,
    `import test from 'node:test';
     test('waits forever', async () => { await new Promise((resolve) => setTimeout(resolve, 600_000)); });`,
  );
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /TEST STALL: test "waits forever" is still running/);
  assert.ok(result.ms < 15_000, `killed in ${result.ms} ms`);
});

test('many tests that each stay within the budget pass, however long the file takes', (t) => {
  const result = runFixture(
    t,
    `import test from 'node:test';
     for (let i = 0; i < 6; i++)
       test('step ' + i, async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });`,
  );
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /TEST STALL/);
});

test('an unusable budget falls back to the default, never to "no limit"', () => {
  for (const raw of [undefined, '', '0', '-5', '1e3', '12abc', ' 5', 'NaN', '9'.repeat(12)])
    assert.equal(stallBudget(raw), DEFAULT_STALL_MS, String(raw));
  assert.equal(stallBudget('2500'), 2500);
  assert.equal(DEFAULT_STALL_MS, 60_000);
});
