// What the drill's test files share to wait for the machine instead of guessing how long it takes,
// and the ONE owner of every process a fixture starts. Nothing here is the code under test.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'node:test';

// A wall-clock budget, not a tick count: a loaded machine gets the same time as an idle one, and
// a pass costs only as long as the condition takes. Generous, because it is only ever spent when
// something is already wrong.
export const POLL_TIMEOUT_MS = 60_000;

/**
 * Resolves with the first truthy `check()` that is observed WITHIN the budget; fails with `what`
 * once it is spent. The deadline is read on the monotonic clock after every check and before its
 * result is accepted: a condition first seen true after the deadline (a stalled scheduler, a slow
 * check) is a late observation, not a pass. `now` is injectable so a test can drive the clock.
 */
export async function pollUntil(
  check,
  what,
  timeoutMs = POLL_TIMEOUT_MS,
  now = () => performance.now(),
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const value = check();
    const expired = now() >= deadline;
    if (value && !expired) return value;
    assert.ok(
      !expired,
      `timed out after ${timeoutMs} ms waiting for ${what}${value ? ' (seen only after the deadline)' : ''}`,
    );
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

// --- the one owner of every process a fixture starts ---------------------------------------------
//
// A fixture directory is created by `ownedDirectory`, every child is started by `spawnOwned` (which
// records it the moment it exists) or reported by `adoptGroup`/`adoptPid` the moment a test learns
// of it, and `disposeOwned` stops all of it and CONFIRMS it is gone before the directory is
// removed. Stubs hold through `holdUntil`, whose loop polls a file inside that directory: removing
// the directory first would strand them. On top of the records, a process is also the fixture's
// when its environment or command line names the fixture's own unique directory (every stub the
// drill starts inherits PATH=<directory>:...), so a group no test ever read a pid for is found too.
// The proof is the directory, never a name pattern: nothing of another session can carry it.

/** How long a stop may take after SIGKILL before a process counts as having survived it. */
export const ownerSettings = { stopBudgetMs: 15_000 };
const scopes = new Map();

/** A new private directory under the temp root, owned from this line on. */
export function ownedDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scopes.set(directory, { groups: new Map(), pids: new Map() });
  return directory;
}

const scopeOf = (directory) => {
  const scope = scopes.get(directory);
  assert.ok(
    scope,
    `${directory} was not created by ownedDirectory(): nothing would own its processes`,
  );
  return scope;
};

/** What /proc says about a process, or null once it is gone. `start` tells a reused pid apart. */
function procStat(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // "pid (comm) state ppid pgrp ...": comm may hold spaces and parentheses, so cut after the last ')'.
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], pgrp: Number(fields[2]), start: fields[19] };
  } catch {
    return null;
  }
}

function register(kind, directory, id) {
  scopeOf(directory)[kind].set(id, procStat(id)?.start ?? null);
}

/**
 * `child_process.spawn`, with the child recorded in `directory`'s scope before this returns (and
 * so before it can fail, exit or start anything of its own). A detached child leads its own group.
 */
export function spawnOwned(directory, command, args, options = {}) {
  scopeOf(directory);
  const child = spawn(command, args, options);
  if (child.pid !== undefined) {
    register('pids', directory, child.pid);
    if (options.detached) register('groups', directory, child.pid);
  }
  return child;
}

/** A process group a test learned of (a stub wrote its `$$`): owned from now on. */
export const adoptGroup = (directory, pgid) => register('groups', directory, pgid);
/** A single process a test learned of (a pid a stub wrote): owned from now on. */
export const adoptPid = (directory, pid) => register('pids', directory, pid);

/** The group a stub led (`echo $$ > file`), owned as soon as its whole pid line is readable. */
export async function waitForGroup(directory, file) {
  const pgid = await waitForPid(file);
  adoptGroup(directory, pgid);
  return pgid;
}

function ownsDirectory(pid, directory) {
  try {
    const environment = readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0');
    if (
      environment.some(
        (entry) => entry.startsWith(`PATH=${directory}:`) || entry === `TMPDIR=${directory}`,
      )
    )
      return true;
    return readFileSync(`/proc/${pid}/cmdline`, 'latin1').includes(`${directory}/`);
  } catch {
    return false; // gone, or not readable: not provably ours
  }
}

/** Everything of the scope that is alive now, from a fresh look at /proc. */
function liveTargets(directory, scope) {
  const table = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const stat = procStat(name);
    if (stat && stat.state !== 'Z') table.set(Number(name), stat);
  }
  const own = table.get(process.pid)?.pgrp;
  const groups = new Set();
  const pids = new Set();
  for (const [pgid, start] of scope.groups) {
    const leader = table.get(pgid);
    if (leader && start && leader.start !== start) continue; // the number now belongs to another process
    if (pgid !== own && [...table.values()].some((stat) => stat.pgrp === pgid)) groups.add(pgid);
  }
  for (const [pid, start] of scope.pids) {
    const stat = table.get(pid);
    if (stat && (!start || stat.start === start) && pid !== process.pid) pids.add(pid);
  }
  for (const [pid, stat] of table)
    if (pid !== process.pid && stat.pgrp !== own && ownsDirectory(pid, directory)) pids.add(pid);
  return { groups, pids };
}

const signalOnce = (target, name) => {
  try {
    process.kill(target, name);
  } catch {
    /* gone already */
  }
};

/**
 * Kills what the scope owns and returns only once a fresh look finds none of it alive (a parent
 * killed in this round may have started one more child in the previous one). Throws, naming the
 * survivors, if that does not happen within the budget.
 */
export async function stopOwned(directory, budgetMs = ownerSettings.stopBudgetMs) {
  const scope = scopeOf(directory);
  let last;
  try {
    await pollUntil(
      () => {
        last = liveTargets(directory, scope);
        if (last.groups.size === 0 && last.pids.size === 0) return true;
        for (const pgid of last.groups) signalOnce(-pgid, 'SIGKILL');
        for (const pid of last.pids) signalOnce(pid, 'SIGKILL');
        return false;
      },
      'the fixture’s processes to stop',
      budgetMs,
    );
  } catch (error) {
    throw new Error(
      `${error.message}; still alive: groups [${[...last.groups]}], processes [${[...last.pids]}]`,
    );
  }
}

/**
 * Ends fixtures: stops everything every owned directory among `paths` owns and confirms that, and
 * only THEN removes all the paths (owned directories and plain ones such as a scratch TMPDIR). If
 * a process survives, nothing is removed and this throws.
 */
export async function disposeOwned(...paths) {
  const owned = paths.filter((path) => scopes.has(path));
  for (const directory of owned) await stopOwned(directory);
  for (const directory of owned) scopes.delete(directory);
  for (const path of paths) rmSync(path, { recursive: true, force: true });
}

/** Whether anything of the fixture is alive right now (a read, no signal). */
export const hasLiveProcesses = (directory) => {
  const live = liveTargets(directory, scopeOf(directory));
  return live.groups.size + live.pids.size > 0;
};

// The after-hook every test file that imports this module gets: a test that ends with a fixture
// not disposed, or with a registered process still alive, FAILS, after the leftovers are stopped
// so that the failure does not also leave the machine busy.
afterEach(async () => {
  const leaked = [];
  for (const directory of [...scopes.keys()]) {
    const alive = hasLiveProcesses(directory);
    try {
      await disposeOwned(directory);
    } catch (error) {
      leaked.push(error.message);
      continue;
    }
    if (alive) leaked.push(`${directory}: processes were still alive; they were killed`);
  }
  assert.deepEqual(leaked, [], 'the test left processes of its fixture running');
});

/**
 * Shell text for a stub (run under bash) that blocks until `file` exists WITHOUT forking. A
 * `sleep` per poll puts a short-lived child into the group every 50 ms, and a recovery that
 * inspects the group can catch it mid-exec or mid-exit, when its environment reads empty: the
 * group is then, correctly, not proven to be the run's and the recovery refuses it. `read -t` on
 * a FIFO that nobody writes is a sleep that stays one process. (`|| :`: the timeout's status 142
 * would otherwise be the loop's, and so the stub's, exit status.)
 *
 * This is the only wait a stub may use (backup-restore-drill-test-shell.mjs checks every fixture
 * source for any other shell loop).
 */
export function holdUntil(directory, file) {
  scopeOf(directory);
  const fifo = join(directory, `${file.split('/').pop()}.hold`);
  if (!existsSync(fifo)) execFileSync('mkfifo', [fifo]);
  return `exec 9<>'${fifo}'; while [ ! -f '${file}' ]; do read -t 0.05 -u 9 _ || :; done`;
}
