// One exclusive lock per package, held from the invalidation of the previous output through
// the publication of the receipt (build-run.mjs), and looked at by the checker.
//
// Without it two `pnpm build` invocations in the same directory share `.next`: one can hash
// the artifacts of the other and certify them with its own layout. The lock is a file next to
// `.next` that names its owner (wrapper pid, `next build` pid, invocation nonce).
//
// Why not flock(2): Node has no binding for it, and `flock(1)` is not on every developer
// machine. The file is created atomically (hard link of a fully written temp file, so nobody
// reads a torn lock) and a second invocation WAITS up to a bounded time, then REFUSES (it never
// takes the lock from a live owner). A lock whose wrapper AND `next build` are both dead is
// taken over through a short-lived reaper guard, so a killed build does not block the package
// forever. Residual, stated: a reaper frozen for longer than REAPER_STALE_MS between two
// system calls; and a pid reused by an unrelated live process keeps the lock "held" (the wait
// times out and the build refuses, naming the file).
import { randomBytes } from 'node:crypto';
import { linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const LOCK_FILE = '.next.build-lock';
export const DEFAULT_WAIT_MS = 30 * 60 * 1000;
const POLL_MS = 200;
const REAPER_STALE_MS = 30_000;

/** @returns {boolean} whether a process with this pid exists */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLock(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return error?.code === 'ENOENT' ? { absent: true } : { unreadable: true };
  }
  try {
    const owner = JSON.parse(text);
    if (owner !== null && typeof owner === 'object' && typeof owner.nonce === 'string') {
      return { owner, text };
    }
  } catch {
    // falls through
  }
  return { unreadable: true };
}

/** Whether the lock names an owner that is gone: wrapper and `next build` both dead. */
function ownerGone(owner) {
  return !pidAlive(owner.pid) && (owner.childPid === undefined || !pidAlive(owner.childPid));
}

/** Atomic create-if-absent with complete content. */
function createExclusive(path, text) {
  const temp = `${path}.${randomBytes(6).toString('hex')}`;
  writeFileSync(temp, text);
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    unlinkSync(temp);
  }
}

/** Removes a lock whose owner is gone, under the reaper guard. */
function reapStale(path, staleText) {
  const guard = `${path}.reap`;
  if (!createExclusive(guard, '{}')) {
    try {
      if (Date.now() - statSync(guard).mtimeMs > REAPER_STALE_MS) unlinkSync(guard);
    } catch {
      // someone else removed it
    }
    return;
  }
  try {
    const again = readLock(path);
    if (again.text === staleText) unlinkSync(path);
  } catch {
    // already gone
  } finally {
    try {
      unlinkSync(guard);
    } catch {
      // already gone
    }
  }
}

/**
 * @param {string} webDir
 * @param {{ waitMs?: number }} [options]
 * @returns {Promise<{ ok: true, lock: BuildLock } | { ok: false, problem: string }>}
 */
export async function acquireBuildLock(webDir, options = {}) {
  const path = join(webDir, LOCK_FILE);
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const nonce = randomBytes(12).toString('hex');
  const mine = { pid: process.pid, nonce };
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (createExclusive(path, JSON.stringify(mine)))
      return { ok: true, lock: new BuildLock(path, mine) };
    const held = readLock(path);
    // An unreadable lock is not ours to judge: nobody writes it non-atomically.
    if (held.owner && ownerGone(held.owner)) reapStale(path, held.text);
    if (Date.now() >= deadline) {
      return {
        ok: false,
        problem: `build lock: another build of this package holds ${LOCK_FILE}; waited ${Math.round(waitMs / 1000)}s; refusing (nothing was changed)`,
      };
    }
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

export class BuildLock {
  constructor(path, owner) {
    this.path = path;
    this.owner = owner;
  }

  /** Records the `next build` pid so a dead wrapper with a live build still counts as held. */
  setChildPid(childPid) {
    this.assertHeld();
    this.owner = { ...this.owner, childPid };
    const temp = `${this.path}.${randomBytes(6).toString('hex')}`;
    writeFileSync(temp, JSON.stringify(this.owner));
    renameSync(temp, this.path);
  }

  /** Throws unless this invocation still owns the lock. */
  assertHeld() {
    const held = readLock(this.path);
    if (!held.owner || held.owner.nonce !== this.owner.nonce) {
      throw new Error('build lock: lost; refusing');
    }
  }

  release() {
    try {
      this.assertHeld();
      unlinkSync(this.path);
    } catch {
      // not ours any more, or already gone
    }
  }
}

/** For the checker: whether a live build owns the package right now. */
export function buildInProgress(webDir) {
  const held = readLock(join(webDir, LOCK_FILE));
  if (held.absent) return false;
  if (held.owner) return !ownerGone(held.owner);
  return true;
}
