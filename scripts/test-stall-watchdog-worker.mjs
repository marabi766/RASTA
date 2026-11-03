/** Watchdog thread of scripts/test-stall-watchdog.mjs; see the header there. */
import { writeSync } from 'node:fs';
import { workerData } from 'node:worker_threads';

const { buffer, budget } = workerData;
const state = new Float64Array(buffer, 0, 2); // [time of the last change (ms), 1 while a test runs]
const nameBytes = new Uint8Array(buffer, 16);
const poll = Math.max(10, Math.min(1000, Math.floor(budget / 4)));

setInterval(() => {
  const elapsed = Date.now() - state[0];
  if (elapsed <= budget) return;
  const end = nameBytes.indexOf(0);
  const name = new TextDecoder().decode(nameBytes.subarray(0, end < 0 ? nameBytes.length : end));
  const what =
    state[1] === 1 ? `test "${name}" is still running` : `no test started after "${name}"`;
  try {
    // Synchronous write to descriptor 2: needs neither the event loop of the
    // stuck thread nor the test reporter.
    writeSync(
      2,
      `\nTEST STALL: ${what} after ${elapsed} ms (budget ${budget} ms, RASTA_TEST_STALL_MS); killing the test process.\n`,
    );
  } finally {
    process.kill(process.pid, 'SIGKILL');
  }
}, poll);
