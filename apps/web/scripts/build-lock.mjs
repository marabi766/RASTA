// One exclusive lock per package, held from the invalidation of the previous output until
// every process that could write that output is gone (build-run.mjs), and looked at by the
// checker.
//
// Without it two `pnpm build` invocations in the same directory share `.next`: one can hash
// the artifacts of the other and certify them with its own layout.
//
// What "held" means. The lock is the DIRECTORY `.next.build-lock`, holding exactly one entry,
// `owner-<nonce>`: the wrapper's pid, the invocation nonce and, once published, the process
// GROUP of `next build`. build-run.mjs starts a live supervisor as group leader
// (setsid), with Next as its child. Every supported child stays in that group
// (capture-next-config.cjs forces `detached: false`). The supervisor reserves the group
// through the final possible signal, and retires last, after all writers are gone. The lock is held while the wrapper OR any member
// of the group is alive; a pid that cannot be probed counts as alive.
//
// Why no flock(2): Node has no binding for it, `flock(1)` is not on macOS, and the holder that
// matters is the whole group, not one file descriptor (Node opens every descriptor close-on-exec,
// so the build's processes could not share one). The group is the kernel-held identity instead.
//
// Why a directory: it is created whole (a staging directory with its owner entry is renamed
// into place: rename(2) refuses a non-empty target), and removing a dead owner's lock touches
// only names that belong to that owner (`owner-<nonce>`, `pending-<nonce>-*`, never reused) and
// then rmdir(2), which fails on any lock that is held, because a held lock is never empty. So a
// reaper that paused for any length of time can never remove a lock someone else took since;
// nothing is decided by elapsed time.
//
// Receipt completion additionally needs a unique `.next.build-lock.receipt-<nonce>`
// marker to be removed after release. It blocks checking across recovery's empty-lock
// window if a refused wrapper could not unlink its receipt. A new owner creates its own
// marker before clearing old markers/invalidation; final unlink touches only its own name.
//
// The window between starting `next build` and publishing its group: the build's first process
// waits, before Next runs, until this lock names its own group (capture-next-config.cjs,
// handshake), and exits having written nothing if that never happens. So a wrapper killed in
// that window leaves a lock that may be taken over at once, behind a process that cannot write.
//
// Stated residuals: reused pids/pgids can conservatively keep an abandoned lock held.
// Cleanup never signals a retained number: only the live group leader signals itself
// through an IPC endpoint, retired permanently on loss/absence (build-group.mjs).
// Unexpected supervisor death refuses and retains ownership; recovery probes only.
// A process that leaves the group by itself (a non-Node program calling setsid) is not covered; an exited
// process nobody reaps (a zombie under an init that does not reap) still counts as alive.
import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const LOCK_DIR = '.next.build-lock';
export const DEFAULT_WAIT_MS = 30 * 60 * 1000;
const POLL_MS = 200;
const OWNER = /^owner-([0-9a-f]{24})$/;
const PENDING = /^pending-([0-9a-f]{24})-[0-9a-f]{12}$/;
const ownerName = (nonce) => `owner-${nonce}`;
const RECEIPT_PENDING = `${LOCK_DIR}.receipt-`;

/** Whether a probe of `target` (a pid, or a negative group id) finds something alive. */
function probe(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    // Only "no such process" is dead; anything else (EPERM, ...) cannot tell, so: alive.
    return error?.code !== 'ESRCH';
  }
}

/** @returns {boolean} whether a process with this pid may exist */
export function pidAlive(pid) {
  return Number.isInteger(pid) && pid > 0 && probe(pid);
}

/** @returns {boolean} whether any process of the group led by `group` may exist */
export function groupAlive(group) {
  return Number.isInteger(group) && group > 0 && probe(-group);
}

/** Whether the owner described is gone: its wrapper is dead and so is its group, if published. */
const ownerAlive = (owner) =>
  pidAlive(owner.pid) || (owner.group !== undefined && groupAlive(owner.group));

/**
 * What is at the lock path. `free`: nothing, or an empty directory (nobody's; acquiring
 * replaces it). `owner`: exactly one well-formed owner entry (plus that owner's own pending
 * update, if any). `unknown`: anything else (a file, two owners, a foreign entry, a torn
 * owner, an I/O error), which nobody may take over and the checker treats as a build.
 */
function inspect(path) {
  let entries;
  try {
    if (!lstatSync(path).isDirectory()) return { unknown: true };
    entries = readdirSync(path);
  } catch (error) {
    return error?.code === 'ENOENT' ? { free: true } : { unknown: true };
  }
  if (entries.length === 0) return { free: true };
  const owners = entries.filter((entry) => OWNER.test(entry));
  if (owners.length !== 1) return { unknown: true };
  const nonce = OWNER.exec(owners[0])[1];
  const pending = entries.filter((entry) => PENDING.exec(entry)?.[1] === nonce);
  if (owners.length + pending.length !== entries.length) return { unknown: true };
  const owner = readOwner(path, nonce);
  return owner ? { owner, pending } : { unknown: true };
}

function readOwner(path, nonce) {
  try {
    const owner = JSON.parse(readFileSync(join(path, ownerName(nonce)), 'utf8'));
    const valid =
      owner !== null &&
      typeof owner === 'object' &&
      owner.nonce === nonce &&
      Number.isInteger(owner.pid) &&
      (owner.group === undefined || Number.isInteger(owner.group));
    return valid ? owner : null;
  } catch {
    return null;
  }
}

/**
 * Removes the lock of an owner that is gone. Liveness is decided on the owner entry as read
 * AFTER its wrapper was seen dead (a dead wrapper cannot update it any more), and only names
 * belonging to that owner are removed, then the directory if (and only if) it is empty.
 * `pause(step)` is a test seam (here and in acquireBuildLock): a reaper stopped at any step
 * for any time must remain harmless.
 */
function reap(path, seen, pause) {
  const { nonce, pid } = seen.owner;
  if (pidAlive(pid)) return;
  const final = readOwner(path, nonce);
  if (final === null || final.pid !== pid || ownerAlive(final)) return;
  // The owner entry goes last: a lock is never left holding only a pending entry.
  const names = [...seen.pending, ownerName(nonce)];
  try {
    for (const name of names) {
      pause?.(`unlink ${name.startsWith('owner-') ? 'owner' : 'pending'}`);
      try {
        unlinkSync(join(path, name));
      } catch (error) {
        if (error?.code !== 'ENOENT') return;
      }
    }
    pause?.('rmdir');
    rmdirSync(path);
  } catch {
    // Not empty (someone else's lock now), or gone already: nothing of theirs was touched.
  }
}

/** Creates the lock whole, or reports that something is in the way. Other errors throw. */
function tryCreate(path, owner) {
  const staging = `${path}.staging-${owner.nonce}`;
  mkdirSync(staging);
  try {
    writeFileSync(join(staging, ownerName(owner.nonce)), JSON.stringify(owner));
    renameSync(staging, path);
    return true;
  } catch (error) {
    if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error?.code)) return false;
    throw error;
  } finally {
    try {
      unlinkSync(join(staging, ownerName(owner.nonce)));
      rmdirSync(staging);
    } catch {
      // renamed into place (nothing left here), or litter named after this invocation only
    }
  }
}

/**
 * @param {string} webDir
 * @param {{ waitMs?: number, pause?: (step: string) => void }} [options]
 * @returns {Promise<{ ok: true, lock: BuildLock } | { ok: false, problem: string }>}
 */
export async function acquireBuildLock(webDir, options = {}) {
  const path = join(webDir, LOCK_DIR);
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const owner = { pid: process.pid, nonce: randomBytes(12).toString('hex') };
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      if (tryCreate(path, owner)) return { ok: true, lock: new BuildLock(path, owner) };
    } catch {
      return {
        ok: false,
        problem: `build lock: ${LOCK_DIR} could not be created (details withheld); refusing (nothing was changed)`,
      };
    }
    const seen = inspect(path);
    options.pause?.('inspected');
    if (seen.owner && !ownerAlive(seen.owner)) reap(path, seen, options.pause);
    if (Date.now() >= deadline) {
      return {
        ok: false,
        problem: `build lock: another build of this package holds ${LOCK_DIR} (or it is not understood); waited ${Math.round(waitMs / 1000)}s; refusing (nothing was changed)`,
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

  /** The file the build's first process reads to confirm it owns the package (handshake). */
  get ownerFile() {
    return join(this.path, ownerName(this.owner.nonce));
  }

  /**
   * Cover the receipt through successful release, including recovery's gap between
   * dead-owner removal and the next acquisition. Unique names mean an old wrapper's
   * final unlink can never remove a new wrapper's marker. Only a NEW exclusive owner
   * may discard old markers; its own marker already blocks checking before it does.
   */
  beginOutput() {
    this.assertHeld();
    const webDir = join(this.path, '..');
    const ownName = `${RECEIPT_PENDING}${this.owner.nonce}`;
    const marker = join(webDir, ownName);
    writeFileSync(marker, '', { flag: 'wx' });
    this.receiptPending = marker;
    for (const name of readdirSync(webDir)) {
      if (name.startsWith(RECEIPT_PENDING) && name !== ownName) unlinkSync(join(webDir, name));
    }
  }

  /** Names the process group of `next build`; from now on the lock lives as long as it does. */
  publishGroup(group) {
    this.assertHeld();
    const next = { ...this.owner, group };
    const pending = join(
      this.path,
      `pending-${this.owner.nonce}-${randomBytes(6).toString('hex')}`,
    );
    try {
      writeFileSync(pending, JSON.stringify(next));
      renameSync(pending, this.ownerFile);
    } catch (error) {
      try {
        unlinkSync(pending);
      } catch {
        // never written, or left for release() / a reaper (it carries this owner's nonce)
      }
      throw error;
    }
    this.owner = next;
  }

  /** Throws unless this invocation still owns the lock. */
  assertHeld() {
    const seen = inspect(this.path);
    if (!seen.owner || seen.owner.nonce !== this.owner.nonce) {
      throw new Error('build lock: lost; refusing');
    }
  }

  /**
   * Gives the package up. Call only once no process of the build is alive.
   * @returns {boolean} false when the lock could not be removed (it is then kept, and its
   *   owner being dead makes it free for the next invocation, which takes it over)
   */
  release() {
    try {
      const seen = inspect(this.path);
      if (!seen.owner || seen.owner.nonce !== this.owner.nonce) return false;
      // Own pending entries first, the owner entry last (see reap).
      for (const name of seen.pending) unlinkSync(join(this.path, name));
      unlinkSync(this.ownerFile);
    } catch {
      return false;
    }
    try {
      rmdirSync(this.path);
    } catch {
      // someone created their lock in the emptied directory already; it is theirs
    }
    this.ownerReleased = true;
    try {
      if (this.receiptPending) unlinkSync(this.receiptPending);
    } catch (error) {
      // A new exclusive owner may already have removed this old marker. It created
      // its own marker FIRST, so checking was gated throughout that handoff.
      if (error?.code === 'ENOENT') return true;
      // Keep the marker: a receipt whose release cannot be completed must refuse.
      return false;
    }
    return true;
  }
}

/** Whether a writer may still own the package (used by recovery; unsure: yes). */
export function buildInProgress(webDir) {
  const seen = inspect(join(webDir, LOCK_DIR));
  if (seen.free) return false;
  if (seen.owner) return ownerAlive(seen.owner);
  return true;
}

/**
 * A receipt needs a COMPLETED release, not merely a dead owner. A refused wrapper may
 * have left a published receipt it could not unlink. Recovery can reap the dead lock,
 * but must invalidate that output before another receipt can be accepted.
 */
export function receiptBlockedByLock(webDir) {
  try {
    if (readdirSync(webDir).some((name) => name.startsWith(RECEIPT_PENDING))) return true;
    return !inspect(join(webDir, LOCK_DIR)).free;
  } catch {
    return true;
  }
}
