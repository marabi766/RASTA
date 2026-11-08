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

/**
 * Whether `kill(target, 0)` finds the process (a negative `target` is a group). Only ESRCH means
 * gone: EPERM is a process that exists and cannot be signalled, and anything else is not an
 * answer, so neither may read as "gone". A killed child its parent has not reaped still answers.
 */
export function signalProbe(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

// --- the one owner of every process a fixture starts ---------------------------------------------
//
// A fixture directory is created by `ownedDirectory`, every child is started by `spawnOwned` (which
// records it the moment it exists) or reported by `adoptGroup`/`adoptPid` the moment a test learns
// of it, and `disposeOwned` stops all of it and CONFIRMS it is gone before the directory is
// removed. Stubs hold through `holdUntil`, whose loop polls a file inside that directory: removing
// the directory first would strand them.
//
// Ownership is PROVEN, never inferred. A process is the fixture's only when this module started it
// (`spawnOwned`), or it descends, by walking parent pids, from a process that is (found while the
// chain is alive and retained from then on), and it is remembered by its identity: pid AND the
// start time /proc reports. A signal is sent only while that identity still matches. A directory
// named in a command line or an environment proves nothing: another session may run
// `tail -f <directory>/x` and it must be neither signalled nor blamed on the test. No identity
// (unreadable at registration) means the registration fails; it never means "any pid will do".
//
// Every link of such a walk is proven by identity AT THE TIME IT IS USED: the child is read first
// (it names the parent), then the parent is read again and must still be the registered process
// (same start time, running). A parent whose identity was known before the child was read and is
// confirmed after it was the child's parent in between: nothing else can have had its number.
// What a table read a moment earlier says about a parent is never enough on its own.
//
// The records of a scope belong to the ONE process table they were read from (the first one the
// scope used): under any other table (a test's injected one, or the real one after a test's) the
// scope inspects nothing, signals nothing and reports itself unknown. A number in one table is not
// evidence about a number in another.
//
// Inspection has three answers: alive, gone, unknown. Only "no such process" is gone; an unreadable
// or malformed /proc entry is UNKNOWN, which keeps the ownership and the directory, is retried
// until the stop budget is spent, and then fails the test loudly. Unknown also holds for a row of
// the process table that nobody registered but that could descend from the fixture (its parent
// chain is unreadable or leads into what the fixture owns), and it holds back every group signal:
// a group is never signalled while anything of the fixture cannot be told apart from a stranger.
//
// A row that could descend from the fixture and cannot be identified is a CANDIDATE, and a candidate
// belongs to the scope, not to the look that found it: it is kept across inspections, and
// re-parenting (to init, or to a subreaper such as `systemd --user`) never makes it somebody
// else's, because a child of the fixture whose parent exits is exactly such a row. A candidate is
// never signalled and never evidence for anything: not for registering itself (its identity was
// not readable when its ancestry was, so the process that answers at its number later may be one
// that took the number since) and not for registering a row below it. It is settled only by the
// kernel saying it is absent, by the number answering as another process (the start time recorded
// when it was readable differs, or it is a zombie), or by being freshly proven the fixture's: a
// walk from a live process of the fixture reaches it, link by link, as above. Until then the stop
// and the after-hook fail, naming it.
//
// Every child is started as the leader of its own process group, so the owner holds one handle and
// one group for it. If registering it fails, the group is killed through that handle (the child
// has not been reaped, so its pid is still its own) and stays on the books until `stopOwned`
// has seen the group empty.
//
// ACCEPTED RESIDUALS (decision D-089, 2026-10-30: this is test-support code on a dedicated host;
// pidfd / supervisor / cgroup containment is out of scope and nothing here pretends to be it):
//   (a) PID reuse in the microseconds between the final /proc identity re-read and the kill() that
//       follows it. Node has no pidfd, and pid_max is 4194304.
//   (b) A detached grandchild that forks and whose parent exits before a look has read it as the
//       child of a live process of the fixture (the 25 ms sample). The fixture commands are our own
//       scripts and none does this; a test over their source ("no fixture detaches",
//       backup-restore-drill.test.mjs) fails if one starts to.

/** How long a stop may take after SIGKILL before a process counts as having survived it. */
export const ownerSettings = {
  stopBudgetMs: 15_000,
  // The kernel's process table, replaceable by a test that needs to inject one.
  system: {
    listPids: () =>
      readdirSync('/proc')
        .filter((name) => /^\d+$/.test(name))
        .map(Number),
    readProcFile: (pid, name) => readFileSync(`/proc/${pid}/${name}`, 'latin1'),
    signal: (target, name) => process.kill(target, name),
  },
};
const scopes = new Map();

/** A new private directory under the temp root, owned from this line on. */
export function ownedDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  // pid -> { start, leads }: `start` is the identity, `leads` that the pid leads its own group.
  // `condemned`: groups killed after their leader could not be registered, until seen empty.
  // `candidates`: pid -> { start, ancestry, reason }, rows of the process table that may descend
  // from the fixture and cannot be identified (see `look`); kept until they are settled.
  // `table`: the process table every record of the scope was read from (bound by the first one).
  scopes.set(directory, { procs: new Map(), condemned: [], candidates: new Map(), table: null });
  return directory;
}

/**
 * Null while the scope's records belong to the process table in use (or it has none yet), else
 * why nothing of it can be inspected here. Every operation on a scope asks this first.
 */
function foreignTable(scope) {
  if (scope.table === null || scope.table === ownerSettings.system) return null;
  return {
    pid: 0,
    reason:
      'recorded in another process table: nothing of it is inspected or signalled in this one',
  };
}

/** Refuses to work on the scope under a table other than its own. */
function sameTable(scope) {
  const foreign = foreignTable(scope);
  if (foreign) throw new Error(`the fixture's processes were ${foreign.reason}`);
}

/** Puts a record in the scope, which binds the scope to the table it was read from. */
function record(scope, pid, entry) {
  sameTable(scope);
  scope.table = ownerSettings.system;
  scope.procs.set(pid, entry);
}

const scopeOf = (directory) => {
  const scope = scopes.get(directory);
  assert.ok(
    scope,
    `${directory} was not created by ownedDirectory(): nothing would own its processes`,
  );
  return scope;
};

/**
 * What /proc says about one process: `gone` (there is no such process), `unknown` (the entry
 * cannot be read or understood: NOT evidence of absence) or `alive`, with the fields that tell a
 * process apart from a later one that reuses its number. A zombie is `dead`: it runs nothing.
 */
function inspect(pid) {
  let text;
  try {
    text = ownerSettings.system.readProcFile(pid, 'stat');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return { status: 'gone' };
    return { status: 'unknown', reason: `${error?.code ?? error}` };
  }
  // "pid (comm) state ppid pgrp ...": comm may hold spaces and parentheses, so cut after the last ')'.
  const close = text.lastIndexOf(')');
  const fields = close < 0 ? [] : text.slice(close + 2).split(' ');
  const [state] = fields;
  const ppid = Number(fields[1]);
  const pgrp = Number(fields[2]);
  const start = fields[19];
  if (!state || !Number.isInteger(ppid) || !Number.isInteger(pgrp) || !start)
    return { status: 'unknown', reason: 'unreadable stat' };
  return { status: 'alive', dead: state === 'Z' || state === 'X', ppid, pgrp, start };
}

/** Whether the process now at `pid` is the one registered under `entry`, and runs. */
function classify(pid, entry, info = inspect(pid)) {
  if (info.status !== 'alive') return info.status;
  return info.start === entry.start && !info.dead ? 'alive' : 'gone';
}

/**
 * Records `pid` in the scope with the identity it has NOW. Fails when there is none: a process
 * whose identity cannot be read cannot be told apart from a later one with the same number.
 */
export function recordOwned(directory, pid, { leads = false } = {}) {
  const scope = scopeOf(directory);
  sameTable(scope);
  const info = inspect(pid);
  if (info.status !== 'alive')
    throw new Error(`process ${pid} has no readable identity (${info.status}): not registered`);
  record(scope, pid, { start: info.start, leads });
}

/**
 * `child_process.spawn`, with the child recorded in `directory`'s scope before this returns (and
 * so before it can fail, exit or start anything of its own). The child always leads a process
 * group of its own, which is what lets the owner end it, and whatever it has started in that group
 * by then, through the one handle it holds.
 */
export function spawnOwned(directory, command, args, options = {}) {
  const scope = scopeOf(directory);
  sameTable(scope); // nothing is started that could not be recorded
  const child = spawn(command, args, { ...options, detached: true });
  if (child.pid !== undefined) {
    try {
      recordOwned(directory, child.pid, { leads: true });
    } catch (error) {
      // The event loop has not turned since the spawn, so the child is not reaped and its pid, and
      // the group it leads, are surely its own: signal the GROUP, through the handle, while the
      // handle says so. `stopOwned` confirms the group empty before the directory may go.
      scope.condemned.push(child.pid);
      if (child.exitCode === null && child.signalCode === null) signalOnce(-child.pid, 'SIGKILL');
      throw error;
    }
  }
  return child;
}

/**
 * The identity (start time) of `pid` when it is a descendant of a live process the scope owns,
 * walking parent pids; else null. The walk is read twice: the first pass finds the chain, the
 * second re-reads every link child first, then its parent, each with the identity the first pass
 * recorded, and the owned process last. A chain is only as good as its links at the time they are
 * used: a number on the way that was taken by another process in between breaks it.
 */
function descendsFromScope(scope, pid) {
  const chain = [];
  let current = pid;
  for (let hops = 0; hops < 64; hops++) {
    const info = inspect(current);
    if (info.status === 'unknown')
      throw new Error(`process ${current} cannot be inspected (${info.reason}): not adopted`);
    if (info.status !== 'alive' || info.dead) return null;
    chain.push({ pid: current, start: info.start, ppid: info.ppid });
    const parent = scope.procs.get(info.ppid);
    if (parent && classify(info.ppid, parent) === 'alive') {
      for (const link of chain) {
        const now = inspect(link.pid);
        if (
          now.status !== 'alive' ||
          now.dead ||
          now.start !== link.start ||
          now.ppid !== link.ppid
        )
          return null;
      }
      return classify(info.ppid, parent) === 'alive' ? chain[0].start : null;
    }
    if (info.ppid <= 1) return null;
    current = info.ppid;
  }
  return null;
}

function adopt(directory, pid, leads) {
  const scope = scopeOf(directory);
  sameTable(scope);
  const info = inspect(pid);
  if (info.status === 'unknown')
    throw new Error(`process ${pid} cannot be inspected (${info.reason}): not adopted`);
  if (info.status === 'gone' || info.dead) return; // nothing alive to own
  const known = scope.procs.get(pid);
  if (known && known.start === info.start) {
    known.leads ||= leads;
    return;
  }
  const start = descendsFromScope(scope, pid);
  assert.ok(
    start !== null,
    `process ${pid} cannot be shown to descend from a process of ${directory}: it is not adopted, and will not be signalled`,
  );
  record(scope, pid, { start, leads });
}

/** A process group a test learned of (a stub wrote its `$$`): owned from now on, if provably ours. */
export const adoptGroup = (directory, pgid) => adopt(directory, pgid, true);
/** A single process a test learned of (a pid a stub wrote): owned from now on, if provably ours. */
export const adoptPid = (directory, pid) => adopt(directory, pid, false);

/** The group a stub led (`echo $$ > file`), owned as soon as its whole pid line is readable. */
export async function waitForGroup(directory, file) {
  const pgid = await waitForPid(file);
  adoptGroup(directory, pgid);
  return pgid;
}

/**
 * A fresh look at what the scope owns. Walks parent pids from every live owned process (and the
 * group of every live owned leader) and RETAINS what it proves with its identity, so that a child
 * whose parent later dies and is re-parented is still known. Returns the owned processes that are
 * `alive` and the ones whose state is `unknown`; `gone` ones are neither.
 */
function look(scope) {
  const { system } = ownerSettings;
  const foreign = foreignTable(scope);
  if (foreign) return { alive: [], unknown: [foreign], condemned: scope.condemned };
  let pids;
  try {
    pids = system.listPids();
  } catch (error) {
    return {
      alive: [],
      unknown: [{ pid: 0, reason: `process table: ${error?.code ?? error}` }],
      condemned: scope.condemned,
    };
  }
  const table = new Map();
  const unreadable = new Map();
  for (const pid of pids) {
    const info = inspect(pid);
    if (info.status === 'alive' && !info.dead) table.set(pid, info);
    else if (info.status === 'unknown' && pid !== process.pid) unreadable.set(pid, info.reason);
  }
  const children = new Map();
  for (const [pid, info] of table)
    children.set(info.ppid, [...(children.get(info.ppid) ?? []), pid]);
  const known = (pid, start) => scope.procs.get(pid)?.start === start;
  const confirmed = (pid) => classify(pid, scope.procs.get(pid)) === 'alive';
  // Roots: registered before this snapshot was read, and confirmed after it, so what the snapshot
  // says about their group (only a root can lead one) was said while they were there.
  const frontier = [];
  for (const [pid, entry] of scope.procs) if (classify(pid, entry) === 'alive') frontier.push(pid);
  for (const pid of frontier) {
    const entry = scope.procs.get(pid);
    if (entry.leads && table.get(pid)?.pgrp === pid)
      for (const [member, info] of table)
        if (info.pgrp === pid && member !== process.pid && !known(member, info.start))
          scope.procs.set(member, { start: info.start, leads: false });
  }
  // Children: the snapshot only says where to look, because a parent retained in this walk was read
  // in the same snapshot, possibly after its child. A child is retained only once a FRESH read of
  // it names the parent, and the parent is then confirmed to be the recorded process: its identity
  // predates that read and is confirmed after it, so nothing else had its number in between.
  for (let next = 0; next < frontier.length; next++) {
    const parent = frontier[next];
    for (const child of children.get(parent) ?? []) {
      if (child === process.pid) continue;
      const now = inspect(child);
      if (now.status !== 'alive' || now.dead || now.ppid !== parent) continue;
      if (known(child, now.start)) continue; // registered: walked from on its own
      if (!confirmed(parent)) continue;
      scope.procs.set(child, { start: now.start, leads: false });
      frontier.push(child);
    }
  }
  // Candidates: rows that may descend from the fixture and cannot be identified. Those kept from an
  // earlier look are checked against this table FIRST, so that one whose number now answers as
  // another process (or none) is settled before anything below that number is read as being below
  // it. A candidate is never evidence of ownership: what is found below one is a candidate too.
  // (Registered: a walk proved the process at the number the fixture's, by identity.)
  const settled = (pid, candidate, info) =>
    info.status === 'gone' ||
    (info.status === 'unknown' && scope.procs.has(pid)) ||
    (info.status === 'alive' &&
      (info.dead || known(pid, info.start) || (candidate.start && candidate.start !== info.start)));
  for (const [pid, candidate] of [...scope.candidates])
    if (settled(pid, candidate, inspect(pid))) scope.candidates.delete(pid);
  // Found now (an unreadable row whose ancestry leads into the fixture, or is itself unreadable; a
  // readable row below such a candidate) and KEPT in the scope, so that the next look still has
  // them after their parent was killed and they were re-parented.
  const found = new Map();
  for (const [pid, reason] of unreadable) {
    if (scope.procs.has(pid)) continue;
    const ancestry = ancestryOf(scope, pid, table, unreadable);
    if (ancestry) found.set(pid, { ...ancestry, reason: `unreadable row: ${reason}` });
  }
  if (found.size + scope.candidates.size > 0)
    for (const [pid, info] of table) {
      if (pid === process.pid || known(pid, info.start) || found.has(pid)) continue;
      let current = info.ppid;
      for (let hops = 0; hops < 64 && current > 1; hops++) {
        if (found.has(current) || scope.candidates.has(current)) {
          found.set(pid, {
            ancestry: 'unknown',
            start: info.start,
            reason: `descends from ${current}, which cannot be identified`,
          });
          break;
        }
        current = table.get(current)?.ppid ?? 0;
      }
    }
  if (found.size > 0) scope.table = system;
  for (const [pid, candidate] of found) {
    const kept = scope.candidates.get(pid);
    if (!kept) scope.candidates.set(pid, candidate);
    else if (kept.ancestry === 'unknown' && candidate.ancestry === 'fixture')
      kept.ancestry = 'fixture';
  }
  // The verdict is a fresh one, taken after everything above: what was readable a moment ago and
  // is not now is unknown, not absent.
  const alive = [];
  const unknown = [];
  for (const [pid, entry] of scope.procs) {
    if (pid === process.pid) continue;
    const info = inspect(pid);
    const state = classify(pid, entry, info);
    if (state === 'alive') alive.push({ pid, ...entry });
    else if (state === 'unknown') unknown.push({ pid, reason: info.reason });
  }
  for (const [pid, candidate] of [...scope.candidates]) {
    const info = inspect(pid);
    if (settled(pid, candidate, info)) scope.candidates.delete(pid);
    else if (info.status === 'unknown')
      unknown.push({ pid, reason: `unreadable row: ${info.reason}` });
    else if (candidate.reason.startsWith('descends'))
      unknown.push({ pid, reason: candidate.reason });
    else
      unknown.push({
        pid,
        reason:
          candidate.ancestry === 'fixture'
            ? `${candidate.reason}; readable now, but it was never identified while it descended from the fixture`
            : `${candidate.reason}; readable now, but never shown to descend from the fixture`,
      });
  }
  // A group killed after its leader could not be registered: present until the kernel says it is not
  // (a member keeps its number from being reused, so asking is safe; only ESRCH ends the question).
  scope.condemned = scope.condemned.filter((pgid) => signalProbe(-pgid));
  return { alive, unknown, condemned: scope.condemned };
}

/** The parent pid /proc/<pid>/status names, or undefined when that cannot be read either. */
function statusParent(pid) {
  try {
    const parent = /^PPid:\s*(\d+)$/m.exec(ownerSettings.system.readProcFile(pid, 'status'))?.[1];
    return parent === undefined ? undefined : Number(parent);
  } catch {
    return undefined;
  }
}

/**
 * What a row nobody registered, and whose stat cannot be read, may be: `null` when its parent
 * chain is read all the way up to init through rows the fixture does not own (it is somebody
 * else's), otherwise a candidate: `ancestry: 'fixture'` when the chain was read as reaching a live
 * process of the fixture, `'unknown'` when it is unreadable at some hop or leads into another
 * candidate. Either way it is only a candidate: its own identity was not readable, so neither
 * answer can later stand for the process that is at its number then.
 */
function ancestryOf(scope, row, table, unreadable) {
  let current = row;
  for (let hops = 0; hops < 64; hops++) {
    const parent = current === row ? statusParent(current) : table.get(current)?.ppid;
    if (parent === undefined) return { ancestry: 'unknown' };
    if (parent <= 1) return null;
    const owned = scope.procs.get(parent);
    if (owned) {
      const state = classify(parent, owned);
      if (state === 'alive') return { ancestry: 'fixture' };
      if (state === 'unknown') return { ancestry: 'unknown' };
    }
    if (unreadable.has(parent) || scope.candidates.has(parent)) return { ancestry: 'unknown' };
    if (!table.has(parent)) return { ancestry: 'unknown' }; // not in the snapshot: cannot be told this round
    current = parent;
  }
  return { ancestry: 'unknown' };
}

const signalOnce = (target, name) => {
  try {
    ownerSettings.system.signal(target, name);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error; // gone already is fine; anything else is not
  }
};

/** Signals one owned process, only while it still IS the registered one. */
function signalOwned(entry, name) {
  if (classify(entry.pid, entry) === 'alive') signalOnce(entry.pid, name);
}

/**
 * Freezes everything owned (SIGSTOP, repeated until a look finds nothing new, so that nothing can
 * start another child), then SIGKILLs it. A group is signalled as a group only while its
 * registered leader is still there (same identity, running) and still leads it, and nothing of the
 * fixture is unknown; otherwise its registered members are signalled one by one, by identity: a
 * group number is never signalled on its own authority.
 */
function sweep(scope) {
  const frozen = new Set();
  for (let round = 0; round < 8; round++) {
    const fresh = look(scope).alive.filter((entry) => !frozen.has(entry.pid));
    if (fresh.length === 0) break;
    for (const entry of fresh) {
      signalOwned(entry, 'SIGSTOP');
      frozen.add(entry.pid);
    }
  }
  const own = inspect(process.pid).pgrp;
  const covered = new Set();
  const { alive, unknown } = look(scope);
  // Something of the fixture cannot be told from a stranger right now: a group signal would reach
  // it unverified, so only the members whose identity is confirmed are signalled, one by one.
  const groupsAllowed = unknown.length === 0;
  for (const entry of alive) {
    const info = inspect(entry.pid);
    // The identity the snapshot had (start time, still running) AND still leading that group.
    if (
      groupsAllowed &&
      entry.leads &&
      classify(entry.pid, entry, info) === 'alive' &&
      info.pgrp === entry.pid &&
      entry.pid !== own
    ) {
      covered.add(entry.pid);
      signalOnce(-entry.pid, 'SIGKILL');
    }
  }
  for (const entry of alive) {
    const group = inspect(entry.pid).pgrp;
    if (!covered.has(entry.pid) && !covered.has(group)) signalOwned(entry, 'SIGKILL');
  }
}

/**
 * Kills what the scope owns and returns only once a fresh look finds none of it alive and none of
 * it unknown (a parent killed in this round may have started one more child in the previous one;
 * an unreadable entry is retried, never taken for gone), and every group killed at a failed
 * registration is empty. Throws, naming the survivors, if that does not happen within the budget.
 */
export async function stopOwned(directory, budgetMs = ownerSettings.stopBudgetMs) {
  const scope = scopeOf(directory);
  let last = { alive: [], unknown: [], condemned: [] };
  try {
    await pollUntil(
      () => {
        last = look(scope);
        if (last.alive.length + last.unknown.length + last.condemned.length === 0) return true;
        if (last.alive.length > 0) sweep(scope);
        return false;
      },
      'the fixture’s processes to stop',
      budgetMs,
    );
  } catch (error) {
    throw new Error(
      `${error.message}; still alive: [${last.alive.map((entry) => entry.pid)}], state unknown: [${last.unknown.map((entry) => `${entry.pid} (${entry.reason})`)}], groups of a failed registration not yet empty: [${last.condemned}]`,
    );
  }
}

/**
 * Ends fixtures: stops everything every owned directory among `paths` owns and confirms that, and
 * only THEN removes all the paths (owned directories and plain ones such as a scratch TMPDIR). If
 * a process survives or cannot be inspected, nothing is removed and this throws.
 */
export async function disposeOwned(...paths) {
  const owned = paths.filter((path) => scopes.has(path));
  for (const directory of owned) await stopOwned(directory);
  for (const directory of owned) scopes.delete(directory);
  for (const path of paths) rmSync(path, { recursive: true, force: true });
}

/** Whether anything of the fixture is alive, or not provably gone, right now (a read, no signal). */
export const hasLiveProcesses = (directory) => {
  const seen = look(scopeOf(directory));
  return seen.alive.length + seen.unknown.length + seen.condemned.length > 0;
};

/**
 * A command run to completion through the owner: started by `spawnOwned`, its tree followed while
 * it runs, and when `timeoutMs` passes the whole tree is stopped by identity and confirmed gone
 * before this rejects. (A synchronous runner killed at its timeout takes only its immediate child.)
 * Resolves `{ status, signal, stdout, stderr }`. What a finished command left behind is the
 * caller's `disposeOwned` to stop.
 */
export async function runOwned(directory, command, args, { timeoutMs = 60_000, ...options } = {}) {
  const scope = scopeOf(directory);
  const child = spawnOwned(directory, command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  // Retain the tree while it exists: a descendant whose parent exits first is re-parented to init
  // and could no longer be shown to be the fixture's.
  const follow = setInterval(() => look(scope), 25);
  let timer;
  try {
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    });
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const outcome = await Promise.race([finished, timedOut]);
    if (outcome) return outcome;
    await stopOwned(directory);
    throw new Error(
      `${command} ${args.join(' ')} timed out after ${timeoutMs} ms; its processes were stopped`,
    );
  } finally {
    clearInterval(follow);
    clearTimeout(timer);
  }
}

// The after-hook every test file that imports this module gets: a test that ends with a fixture
// not disposed, or with a registered process still alive, FAILS, after the leftovers are stopped
// so that the failure does not also leave the machine busy.
export async function leakedFixtures() {
  const leaked = [];
  for (const directory of [...scopes.keys()]) {
    const foreign = foreignTable(scopes.get(directory));
    if (foreign) {
      // A test's injected table outlived by its scope: reported once, nothing read or signalled in
      // this table on its behalf, and the directory is kept.
      scopes.delete(directory);
      leaked.push(`${directory}: its processes were ${foreign.reason}; the directory is kept`);
      continue;
    }
    const alive = hasLiveProcesses(directory);
    try {
      await disposeOwned(directory);
    } catch (error) {
      leaked.push(error.message);
      continue;
    }
    if (alive) leaked.push(`${directory}: processes were still alive; they were killed`);
  }
  return leaked;
}
afterEach(async () => {
  assert.deepEqual(await leakedFixtures(), [], 'the test left processes of its fixture running');
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
