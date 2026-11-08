/**
 * Preload for `node --test --require ./scripts/test-stall-watchdog.mjs`: no test
 * may run longer than a wall-clock budget, and a test that does is NAMED.
 *
 * Why not `--test-timeout` alone. On Node 22 that flag is enforced on the test
 * FILE as a whole, by the parent process: it bounds a file but never names the
 * test that stopped. A per-test `timeout` is a timer on the stuck thread, so a
 * synchronous spin or a blocked syscall never lets it fire. And the runner
 * prints a file's results in bursts (a 22,621-test file printed nothing until
 * it ended), so the last `ok` line of a hung CI step does not identify the hung
 * test either (task 310, run 41562129261).
 *
 * This is the out-of-thread version: a worker thread polls a shared record that
 * the main thread updates around every test; when one test (or the gap between
 * two) outlasts the budget it writes the test's name to stderr synchronously
 * and kills the process, so the file fails in about a minute instead of at the
 * job limit.
 *
 * The same preload also guards the `node --test` RUNNER (the parent process),
 * whose own event loop can stop for good: on Node 22 a child's v8-serialized
 * report that arrives split right after a 0xFF byte is reordered by the parent's
 * parser, the frame after it is read at a false header with a huge length, and
 * once the file ends `#drainRawBuffer` loops forever on it (nodejs/node#62693,
 * fixed upstream by nodejs/node#62704, not in Node 22.23). The child has exited,
 * so the test watchdog is gone; the runner prints nothing more, ignores
 * --test-timeout (its timer never runs) and SIGTERM, and holds the CI step to
 * its limit (FU-118: runs 42043438996 and 42035896072). Here the main thread
 * stamps a heartbeat from a timer and the same out-of-thread watchdog kills the
 * runner, naming the cause, when the heartbeat stops for one budget. This needs
 * `--require`: on Node 22 the runner loads --require preloads but not --import
 * ones (those reach only the test files). Node 22.12+ requires this ES module.
 *
 * Budget: RASTA_TEST_STALL_MS, default 60 s. Anything that is not a positive
 * integer is ignored and the default applies, never "disabled".
 */
import { afterEach, beforeEach } from 'node:test';
import { isMainThread, Worker } from 'node:worker_threads';
import { monotonicMs } from './test-stall-watchdog-clock.mjs';

export const DEFAULT_STALL_MS = 60_000;
const NAME_BYTES = 1024;

export function stallBudget(raw) {
  return /^[1-9][0-9]{0,8}$/.test(raw ?? '') ? Number(raw) : DEFAULT_STALL_MS;
}

/**
 * Node hands its preload list to every worker thread, the watchdog's own
 * included: without the main-thread test each watchdog worker would start a
 * watchdog of its own, whose hooks never fire, and kill the process after one
 * budget. NODE_TEST_CONTEXT is set by the runner in the process that runs a
 * test file, so a plain `node` that preloads this file is left alone.
 */
export const runsTestFile = isMainThread && process.env.NODE_TEST_CONTEXT !== undefined;
/** The `node --test` runner itself: the parent that spawns the test files. */
export const runsTestRunner =
  isMainThread &&
  process.env.NODE_TEST_CONTEXT === undefined &&
  process.execArgv.includes('--test');

function startWatchdog(buffer, runner) {
  new Worker(new URL('./test-stall-watchdog-worker.mjs', import.meta.url), {
    workerData: { buffer, budget: stallBudget(process.env.RASTA_TEST_STALL_MS), runner },
  }).unref();
}

if (runsTestRunner) {
  const buffer = new SharedArrayBuffer(16 + NAME_BYTES);
  const state = new Float64Array(buffer, 0, 2);
  const beat = () => {
    state[0] = monotonicMs();
  };
  beat();
  setInterval(beat, 250).unref();
  startWatchdog(buffer, true);
}

if (runsTestFile) {
  const buffer = new SharedArrayBuffer(16 + NAME_BYTES);
  const state = new Float64Array(buffer, 0, 2); // [monotonic time of the last change (ms), 1 while a test runs]
  const nameBytes = new Uint8Array(buffer, 16);
  const encoder = new TextEncoder();
  const record = (running, name) => {
    nameBytes.fill(0);
    // Keep a terminating zero byte; a cut multi-byte character only garbles the name.
    encoder.encodeInto(name.slice(0, 200), nameBytes.subarray(0, NAME_BYTES - 1));
    state[1] = running ? 1 : 0;
    state[0] = monotonicMs();
  };
  record(false, '(start of file)');
  startWatchdog(buffer, false);
  beforeEach((t) => record(true, t.name));
  afterEach((t) => record(false, t.name));
}
