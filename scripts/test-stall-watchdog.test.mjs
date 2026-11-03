import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STALL_MS, stallBudget } from './test-stall-watchdog.mjs';

const watchdog = fileURLToPath(new URL('./test-stall-watchdog.mjs', import.meta.url));

/** Run `node --test` with the watchdog preloaded on a fixture test file. */
function runFixture(t, source, env = {}, preloads = []) {
  const directory = mkdtempSync(join(tmpdir(), 'stall-watchdog-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'fixture.test.mjs');
  writeFileSync(file, source);
  const started = performance.now();
  // Inside `node --test` this variable makes a nested runner act as a child.
  const { NODE_TEST_CONTEXT: _context, ...inherited } = process.env;
  const result = spawnSync(
    process.execPath,
    ['--test', ...preloads.flatMap((path) => ['--import', path]), '--import', watchdog, file],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...inherited, RASTA_TEST_STALL_MS: '1500', ...env },
    },
  );
  return { ...result, output: `${result.stdout}${result.stderr}`, ms: performance.now() - started };
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
  assert.ok(result.ms < 15_000, `killed in ${Math.round(result.ms)} ms`);
});

test('an asynchronous hang past the budget is killed and named', (t) => {
  const result = runFixture(
    t,
    `import test from 'node:test';
     test('waits forever', async () => { await new Promise((resolve) => setTimeout(resolve, 600_000)); });`,
  );
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /TEST STALL: test "waits forever" is still running/);
  assert.ok(result.ms < 15_000, `killed in ${Math.round(result.ms)} ms`);
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

/**
 * A preload that steps the WALL clock (Date.now) once the flag
 * file exists, in every thread that loads it - the watchdog thread included,
 * because Node hands its --import list to workers. performance.now() and
 * process.hrtime stay untouched, as on a real system where only the realtime
 * clock is corrected.
 */
function clockStep(t, deltaMs) {
  const directory = mkdtempSync(join(tmpdir(), 'clock-step-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preload = join(directory, 'step.mjs');
  const flag = join(directory, 'flag');
  writeFileSync(
    preload,
    `import { existsSync } from 'node:fs';
     const real = Date.now.bind(Date);
     Date.now = () => real() + (existsSync(${JSON.stringify(flag)}) ? ${deltaMs} : 0);`,
  );
  return { preload, flag };
}

for (const [direction, delta] of [
  ['forward', 61_000],
  ['backward', -61_000],
]) {
  test(`a ${direction} wall-clock step does not kill a healthy test`, (t) => {
    const { preload, flag } = clockStep(t, delta);
    // The step happens while the test runs, 300 ms in; the test needs 1000 ms of a 1500 ms budget.
    const result = runFixture(
      t,
      `import test from 'node:test';
       import { writeFileSync } from 'node:fs';
       test('healthy test during a clock step', async () => {
         await new Promise((resolve) => setTimeout(resolve, 300));
         writeFileSync(${JSON.stringify(flag)}, '');
         await new Promise((resolve) => setTimeout(resolve, 700));
       });
       test('and the next one', () => {});`,
      {},
      [preload],
    );
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /TEST STALL/);
  });

  test(`a spinning test is still killed after a ${direction} wall-clock step`, (t) => {
    const { preload, flag } = clockStep(t, delta);
    const result = runFixture(
      t,
      `import test from 'node:test';
       import { writeFileSync } from 'node:fs';
       test('spins after the clock step', () => {
         writeFileSync(${JSON.stringify(flag)}, '');
         const end = performance.now() + 6000;
         while (performance.now() < end);
       });`,
      {},
      [preload],
    );
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /TEST STALL: test "spins after the clock step" is still running/);
    assert.ok(result.ms < 5500, `killed in ${Math.round(result.ms)} ms`);
  });
}
