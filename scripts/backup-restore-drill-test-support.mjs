// What the drill's test files share to wait for the machine instead of guessing how long it takes.
// Nothing here is the code under test.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A wall-clock budget, not a tick count: a loaded machine gets the same time as an idle one, and
// a pass costs only as long as the condition takes. Generous, because it is only ever spent when
// something is already wrong.
export const POLL_TIMEOUT_MS = 60_000;

/** Resolves with the first truthy `check()`; fails with `what` once the budget is spent. */
export async function pollUntil(check, what, timeoutMs = POLL_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    assert.ok(performance.now() < deadline, `timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The parsed file, or null while it is missing or half-written (a poll just tries again). */
export function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * A child writing its own marker file only says it STARTED. What its parent records about it (the
 * report's `processGroups`, the journal's `groups`) is written after the spawn returns, so a test
 * that reads that record on the marker alone races the parent. Wait for the record itself.
 */
export const waitForRecordedGroup = (path, pgid, key) =>
  pollUntil(
    () => readJsonOrNull(path)?.[key]?.includes(pgid),
    `${key} in ${path} to name process group ${pgid}`,
  );

/** True once the file exists. */
export const waitForFile = (path) => pollUntil(() => existsSync(path), path);

/**
 * The pid a stub wrote with `echo $$ > file`. The shell creates the file before it writes into it,
 * so "the file exists" is not "the pid is there": read it only once it is a whole line.
 */
export const waitForPid = (path, timeoutMs = POLL_TIMEOUT_MS) =>
  pollUntil(
    () => {
      try {
        const text = readFileSync(path, 'utf8');
        return /^\d+\n$/.test(text) && Number(text) > 0 ? Number(text) : 0;
      } catch {
        return 0;
      }
    },
    `a process id in ${path}`,
    timeoutMs,
  );

/**
 * Shell text for a stub (run under bash) that blocks until `file` exists WITHOUT forking. A
 * `sleep` per poll puts a short-lived child into the group every 50 ms, and a recovery that
 * inspects the group can catch it mid-exec or mid-exit, when its environment reads empty: the
 * group is then, correctly, not proven to be the run's and the recovery refuses it. `read -t` on
 * a FIFO that nobody writes is a sleep that stays one process. (`|| :`: the timeout's status 142
 * would otherwise be the loop's, and so the stub's, exit status.)
 */
export function holdUntil(directory, file) {
  const fifo = join(directory, `${file.split('/').pop()}.hold`);
  if (!existsSync(fifo)) execFileSync('mkfifo', [fifo]);
  return `exec 9<>'${fifo}'; while [ ! -f '${file}' ]; do read -t 0.05 -u 9 _ || :; done`;
}
