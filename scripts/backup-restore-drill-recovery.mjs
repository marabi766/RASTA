import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  InputFileError,
  MAX_REPORT_BYTES,
  groupAlive,
  readRegularFile,
  reapProcessGroup,
  writeReportAtomically,
} from './backup-restore-drill-lib.mjs';

// ---------------------------------------------------------------------------------------------
// Recovery (`--cleanup-from <report>`): the report a run left is only ever a CLAIM about what that
// run owns. Nothing is removed or signalled until the claim is proven against the machine:
//   * the record is a private regular file (opened without following a symlink) and names a
//     project, a temporary directory and a recovery id of the exact shapes the CLI creates;
//   * the directory is a real private directory of the right owner directly under the temp root
//     and holds a marker, written by the run before anything else, that says the SAME project and
//     id: a record of project A pointing at the directory of project B is refused;
//   * compose.json is a regular file (not a link) whose definition is constrained to what the CLI
//     writes for THAT project, before `docker compose` ever reads it;
//   * a recorded process group is signalled only when every live member carries the run's id in
//     its own environment (/proc), never because a name or a command line matched. A group is
//     GONE (kill(-pgid, 0) proves it), PROVEN (every member read and matched) or UNKNOWN (any
//     read error, malformed field, foreign member, or no member visible while it is alive):
//     UNKNOWN is never signalled and never counts as success;
//   * recovery's OWN children are recorded too, in a separate atomic journal NEXT TO THE REPORT
//     (outside the directory recovery deletes; the report stays immutable) for every invocation,
//     the directory-absent one included, and carry the same id: a later recovery reaps the
//     journal's groups first. The journal also holds the completion checkpoint ("recovered" before
//     the directory is removed, "removed" after), so a retry after any interruption finishes or
//     succeeds instead of refusing on what the removal already deleted.
//     The directory is deleted in ONE place (removeOwnedDirectory) for the end of a normal run, a
//     recovery and the resumption of an earlier recovery alike, and only after a durable
//     "recovered" checkpoint written afresh by that very invocation: a checkpoint merely read back
//     from disk may be one whose directory fsync failed, so it never licenses a removal by itself.
//   * ONE owner at a time: every run and every recovery of a report holds an exclusive lock
//     (acquireDrillLock) for its whole lifetime, so two recoveries, or a recovery and a live run,
//     can never both act on the same groups, journal or directory. A lock whose owner is not
//     PROVEN gone is never taken over.
//   * A journal or report write that fails is STICKY: the invocation can no longer report success,
//     whatever later writes do, and nothing is removed after it.
// RESIDUAL (stated, accepted by the project manager, not engineered around): between a child's
// spawn() and the synchronous journal/report write that names its process group (the same tick,
// the cost of one small write plus two fsyncs: milliseconds, longer on a slow disk) a SIGKILL of
// the parent leaves that one group unrecorded; the next recovery cannot find it by its id. A
// reservation BEFORE the spawn cannot close this: the group id is the child's pid, unknown until
// the child exists, so it could only say "a child may be starting", and finding it again would
// need a /proc sweep by environment alone, which signals on weaker proof than the per-group check
// and misses processes a hidepid mount hides.
// The same checks guard the normal teardown (`assertOwnedCompose`). Every refusal is a fixed
// phrase: it never quotes the record, a path or a name from it.
// ---------------------------------------------------------------------------------------------

export const RECOVERY_VERSION = 1;
/** Present in every child's environment: how a recorded process group proves it is ours. */
export const RECOVERY_ENV = 'RASTA_DRILL_RECOVERY_ID';
export const RECOVERY_MARKER = 'recovery.json';
/** The journal's suffix: it lives next to the report, never inside the directory it may delete. */
export const RECOVERY_JOURNAL = '.recovery-journal.json';
export const recoveryJournalPath = (reportPath) => `${reportPath}${RECOVERY_JOURNAL}`;
export const PROJECT_PATTERN = /^restore-drill-[0-9a-f]{16}$/;
export const DIRECTORY_PATTERN = /^rasta-restore-drill-[A-Za-z0-9]{6}$/;
export const RECOVERY_ID_PATTERN = /^[0-9a-f]{32}$/;

const MAX_MARKER_BYTES = 4096;
const MAX_COMPOSE_BYTES = 64 * 1024;
const MAX_JOURNAL_BYTES = 1024 * 1024;
// Linux pid_max ceiling: anything above is not a process group of this host.
const MAX_PID = 2 ** 22;

export class RecoveryRefused extends Error {
  constructor(reason) {
    super(`recovery refused: ${reason}`);
    this.name = 'RecoveryRefused';
    this.reason = reason;
  }
}
const refuse = (reason) => {
  throw new RecoveryRefused(reason);
};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const newRecoveryId = () => randomBytes(16).toString('hex');

/** Written first in a new temporary directory, before the report names it. */
export function writeRecoveryMarker(temporary, { project, id }) {
  writeReportAtomically(join(temporary, RECOVERY_MARKER), {
    version: RECOVERY_VERSION,
    id,
    project,
    directory: basename(temporary),
  });
}

const READ_REFUSALS = {
  open: 'cannot be opened safely',
  'not-file': 'is not a regular file',
  'too-large': 'is too large',
  read: 'cannot be read',
};
/**
 * Reads a private regular file the way recovery may trust it (readRegularFile: never blocking,
 * never through a link, only a regular file, bounded), then checked on the descriptor for owner
 * and mode. Returns the text; throws RecoveryRefused. `undefined` is returned instead when asked
 * and the file is absent.
 */
function readPrivateFile(path, { maxBytes, what, uid, allowMissing = false }) {
  try {
    return readRegularFile(path, {
      maxBytes,
      noFollow: true,
      inspect: (stat) => {
        if (uid !== undefined && stat.uid !== uid) refuse(`${what} belongs to another user`);
        if ((stat.mode & 0o077) !== 0) refuse(`${what} is not private`);
      },
    });
  } catch (error) {
    if (error instanceof RecoveryRefused) throw error;
    if (error instanceof InputFileError) {
      if (error.kind === 'missing') {
        if (allowMissing) return undefined;
        return refuse(`${what} is missing`);
      }
      return refuse(`${what} ${READ_REFUSALS[error.kind] ?? 'cannot be read'}`);
    }
    return refuse(`${what} cannot be read`);
  }
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    return refuse(`${what} is not valid JSON`);
  }
}

/** 'absent', or 'private' for a real directory of this user nobody else can enter. */
function inspectDirectory(path, uid) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent';
    return refuse('the temporary directory cannot be inspected');
  }
  if (!stat.isDirectory()) refuse('the temporary directory is not a real directory');
  if (uid !== undefined && stat.uid !== uid)
    refuse('the temporary directory belongs to another user');
  if ((stat.mode & 0o077) !== 0) refuse('the temporary directory is not private');
  return 'private';
}

const HEALTHCHECK_KEYS = new Set([
  'test',
  'interval',
  'timeout',
  'retries',
  'start_period',
  'start_interval',
]);
const SERVICE_KEYS = new Set([
  'image',
  'restart',
  'mem_limit',
  'cpus',
  'environment',
  'env_file',
  'ports',
  'volumes',
  'healthcheck',
  'container_name',
]);
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;
const INITDB_MOUNT = /^\/[^:\n]*infrastructure\/docker\/postgres:\/docker-entrypoint-initdb\.d:ro$/;

/**
 * The only Compose definition `docker compose down` may be given: the two PostgreSQL services the
 * CLI writes, named after the project, with named data volumes, the loopback-only port and the
 * read-only init mount. Anything else (a privileged service, a host bind, an include, another
 * container name, a different volume set) is refused before Compose reads the file.
 */
export function validateComposeDefinition(definition, project) {
  const deny = () => refuse('the Compose definition is not the one this drill writes');
  if (!isObject(definition)) deny();
  if (!isDeepStrictEqual(Object.keys(definition).sort(), ['services', 'volumes'])) deny();
  if (!isDeepStrictEqual(definition.volumes, { data: {}, restored: {} })) deny();
  const { services } = definition;
  if (
    !isObject(services) ||
    !isDeepStrictEqual(Object.keys(services).sort(), ['restored', 'source'])
  )
    deny();
  for (const [name, service] of Object.entries(services)) {
    if (!isObject(service)) deny();
    if (!Object.keys(service).every((key) => SERVICE_KEYS.has(key))) deny();
    if (service.container_name !== `${project}-${name}`) deny();
    if (service.restart !== 'no') deny();
    if (typeof service.image !== 'string' || !IMAGE.test(service.image)) deny();
    if (!isDeepStrictEqual(service.ports, ['127.0.0.1::5432'])) deny();
    const data = name === 'source' ? 'data' : 'restored';
    if (
      !Array.isArray(service.volumes) ||
      service.volumes.length !== 2 ||
      service.volumes[0] !== `${data}:/var/lib/postgresql/data` ||
      typeof service.volumes[1] !== 'string' ||
      !INITDB_MOUNT.test(service.volumes[1])
    )
      deny();
    if (
      !Array.isArray(service.env_file) ||
      service.env_file.length !== 1 ||
      typeof service.env_file[0] !== 'string' ||
      !service.env_file[0].endsWith('/.env.migrator.example')
    )
      deny();
    if (
      !isObject(service.environment) ||
      !Object.values(service.environment).every(
        (value) => typeof value === 'string' || typeof value === 'number',
      )
    )
      deny();
    const health = service.healthcheck;
    if (!isObject(health) || !Object.keys(health).every((key) => HEALTHCHECK_KEYS.has(key))) deny();
  }
  // No interpolation survives into a file Compose evaluates with the caller's environment.
  if (JSON.stringify(definition).includes('${')) deny();
}

/**
 * The one gate before `docker compose down` (normal teardown and recovery alike): the file is a
 * private regular file, not a link, and its definition is the one this drill writes for `project`.
 */
export function assertOwnedCompose(path, project, { uid = process.getuid?.() } = {}) {
  const text = readPrivateFile(path, { maxBytes: MAX_COMPOSE_BYTES, what: 'compose.json', uid });
  validateComposeDefinition(parseJson(text, 'compose.json'), project);
}

const validGroups = (found) => {
  for (const pgid of found)
    if (!Number.isSafeInteger(pgid) || pgid <= 1 || pgid > MAX_PID)
      refuse('the record lists an invalid process group');
  return [...new Set(found)];
};

function recordedGroups(record) {
  const list = (value) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return refuse('the record lists process groups in an unknown shape');
    return value;
  };
  return validGroups([
    ...list(record.processGroups),
    ...list(record.orphanProcessGroups),
    ...list(record.unconfirmedProcessGroups).map((entry) => (isObject(entry) ? entry.pgid : NaN)),
  ]);
}

/**
 * The recovery journal: what `--cleanup-from` itself started and has not seen end, and how far the
 * recovery got. A separate file NEXT TO THE REPORT (the report is the immutable claim of the
 * original run; the directory is what recovery deletes, so nothing that must outlive the deletion
 * can live in it), written atomically (sibling + fsync + rename + directory fsync) with mode 0600.
 * `groups` are the process groups of recovery's own children (and any group an earlier recovery
 * could not settle). `checkpoint` is 'recovered' (every owned resource and process is gone; the
 * directory removal may start) or 'removed' (the directory is gone too). Bound to the same
 * project, id and directory name as the marker. EVERY write must be durable: when the file or the
 * directory could not be synced the write throws, and the caller treats that as a failure that
 * does not heal (a later successful write does not undo it).
 */
export function writeRecoveryJournal(
  journalPath,
  { project, id, temporary, groups = [], checkpoint },
  { fs } = {},
) {
  const synced = writeReportAtomically(
    journalPath,
    {
      version: RECOVERY_VERSION,
      id,
      project,
      directory: basename(temporary),
      groups: [...new Set(groups)],
      ...(checkpoint && { checkpoint }),
    },
    { durable: true, ...(fs && { fs }) },
  );
  if (!synced) throw new Error('the recovery journal could not be made durable');
}

/**
 * THE deletion boundary of the drill's temporary directory: the end of a normal run, a recovery
 * and the resumption of an earlier recovery's checkpoint all remove it here and nowhere else.
 * Nothing owned is left (the caller proved it) and the directory is only deleted once a DURABLE
 * "recovered" checkpoint exists outside it. That write is made afresh on EVERY call, also when
 * the journal already holds one: a checkpoint read back from disk may be a write that threw after
 * its rename but before the directory fsync, so it proves nothing about durability until this
 * invocation has written it again and the file and the directory are both confirmed. A failed
 * write stops before any removal (`onFailure` tells the caller, who must treat it as sticky).
 * Afterwards the "removed" checkpoint is written the same way. `remove` may throw part-way: the
 * checkpoint already stands, so the next invocation finishes the removal.
 */
export function removeOwnedDirectory({
  journalPath,
  project,
  id,
  temporary,
  directoryPresent = true,
  remove = () => rmSync(temporary, { recursive: true, force: true }),
  onFailure = () => {},
  fs,
}) {
  const publish = (checkpoint) => {
    try {
      writeRecoveryJournal(journalPath, { project, id, temporary, groups: [], checkpoint }, { fs });
    } catch (error) {
      onFailure(error);
      throw error;
    }
  };
  publish('recovered');
  if (directoryPresent) remove();
  publish('removed');
}

const CHECKPOINTS = new Set(['recovered', 'removed']);
function loadRecoveryJournal(journalPath, { id, project, temporary, uid }) {
  const text = readPrivateFile(journalPath, {
    maxBytes: MAX_JOURNAL_BYTES,
    what: 'the recovery journal',
    uid,
    allowMissing: true,
  });
  if (text === undefined) return { groups: [], checkpoint: undefined };
  const journal = parseJson(text, 'the recovery journal');
  if (!isObject(journal)) refuse('the recovery journal is not an object');
  const { groups, checkpoint, ...bound } = journal;
  if (
    !isDeepStrictEqual(bound, {
      version: RECOVERY_VERSION,
      id,
      project,
      directory: basename(temporary),
    }) ||
    (checkpoint !== undefined && !CHECKPOINTS.has(checkpoint)) ||
    !Array.isArray(groups)
  )
    refuse('the recovery journal does not match the directory it is for');
  return { groups: validGroups(groups), checkpoint };
}

/**
 * Proves what a report claims, or refuses (RecoveryRefused). Returns what recovery may act on:
 * `{ project, temporary, id, composeFile, processGroups, journalGroups, checkpoint,
 * directoryPresent }`; `composeFile` is null when the definition is gone (teardown already ran:
 * the project label alone is checked); `checkpoint` is what an earlier recovery's journal says
 * ('recovered': everything owned was gone and the directory removal had started; 'removed': it
 * finished), the evidence a retry needs when the removal took the marker, or the whole directory,
 * with it.
 */
export function loadRecoveryRecord(
  reportPath,
  { tmpRoot = tmpdir(), uid = process.getuid?.() } = {},
) {
  const record = parseJson(
    readPrivateFile(reportPath, { maxBytes: MAX_REPORT_BYTES, what: 'the report', uid }),
    'the report',
  );
  if (!isObject(record)) refuse('the report is not an object');
  const { project, temporary, recoveryId: id } = record;
  if (typeof project !== 'string' || !PROJECT_PATTERN.test(project))
    refuse('the report names no project this drill created');
  if (typeof id !== 'string' || !RECOVERY_ID_PATTERN.test(id))
    refuse('the report carries no recovery id');
  if (
    typeof temporary !== 'string' ||
    !isAbsolute(temporary) ||
    resolve(dirname(temporary)) !== resolve(tmpRoot) ||
    !DIRECTORY_PATTERN.test(basename(temporary))
  )
    refuse('the report names no directory this drill created');
  const processGroups = recordedGroups(record);
  const journal = loadRecoveryJournal(recoveryJournalPath(reportPath), {
    id,
    project,
    temporary,
    uid,
  });
  // A checkpoint was written after everything owned was gone: nothing is left to reap or ask
  // Docker; only the directory (if still there) remains.
  const finished = (directoryPresent) => ({
    project,
    temporary,
    id,
    composeFile: null,
    processGroups: [],
    journalGroups: [],
    checkpoint: journal.checkpoint,
    directoryPresent,
  });

  if (inspectDirectory(temporary, uid) === 'absent') {
    if (journal.checkpoint) return finished(false);
    // Nothing to bind the project to: acceptable only when the run itself finished its cleanup.
    if (record.cleanup?.passed !== true || processGroups.length)
      refuse('the temporary directory is gone but the report does not say cleanup finished');
    return {
      project,
      temporary,
      id,
      composeFile: null,
      processGroups,
      journalGroups: journal.groups,
      checkpoint: undefined,
      directoryPresent: false,
    };
  }
  // A removal cut short may have taken the marker with it: the checkpoint stands on its own.
  if (journal.checkpoint === 'recovered') return finished(true);
  if (journal.checkpoint === 'removed')
    refuse('the temporary directory reappeared after it was removed');
  const marker = parseJson(
    readPrivateFile(join(temporary, RECOVERY_MARKER), {
      maxBytes: MAX_MARKER_BYTES,
      what: 'the directory marker',
      uid,
    }),
    'the directory marker',
  );
  if (
    !isDeepStrictEqual(marker, {
      version: RECOVERY_VERSION,
      id,
      project,
      directory: basename(temporary),
    })
  )
    refuse('the report does not match the directory it names');
  const composeFile = join(temporary, 'compose.json');
  const text = readPrivateFile(composeFile, {
    maxBytes: MAX_COMPOSE_BYTES,
    what: 'compose.json',
    uid,
    allowMissing: true,
  });
  if (text !== undefined) validateComposeDefinition(parseJson(text, 'compose.json'), project);
  return {
    project,
    temporary,
    id,
    composeFile: text === undefined ? null : composeFile,
    processGroups,
    journalGroups: journal.groups,
    checkpoint: undefined,
    directoryPresent: true,
  };
}

const VANISHED = new Set(['ENOENT', 'ESRCH']);
// "pid (comm) state ppid pgrp ...": comm may hold spaces and parentheses, so the LAST ") " counts.
const PROC_STAT = /^(\d+) \(.*\) ([A-Za-z]) (-?\d+) (-?\d+) /s;

/**
 * What /proc says about process group `pgid`, as one of three outcomes:
 *  - 'gone'    kill(-pgid, 0) fails (or every remaining member is a zombie): nothing can be signalled;
 *  - 'proven'  at least one live member, and EVERY member was read completely and carries `id`;
 *  - 'unknown' anything else: the listing or any member's stat/environ could not be read (an
 *              entry that merely vanished between the listing and the read is not an error),
 *              a field is malformed, a member does not carry the id, or the group is alive but
 *              no member is visible.
 * 'unknown' is neither signalled nor success: the caller refuses and says so.
 */
export function inspectProcessGroup(
  pgid,
  id,
  { procRoot = '/proc', alive = groupAlive, readdir = readdirSync, readFile = readFileSync } = {},
) {
  try {
    if (!alive(pgid)) return 'gone';
    const entries = readdir(procRoot);
    const vanished = (error) => VANISHED.has(error?.code);
    let live = 0;
    let dead = 0;
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      let text;
      try {
        text = readFile(join(procRoot, entry, 'stat'), 'utf8');
      } catch (error) {
        if (vanished(error)) continue; // exited between the listing and the read
        return 'unknown';
      }
      const fields = PROC_STAT.exec(String(text));
      if (fields === null || fields[1] !== entry) return 'unknown';
      if (Number(fields[4]) !== pgid) continue;
      if ('ZXx'.includes(fields[2])) {
        dead += 1; // a zombie is dead and cannot be signalled
        continue;
      }
      let environ;
      try {
        environ = readFile(join(procRoot, entry, 'environ'), 'utf8');
      } catch (error) {
        if (!vanished(error)) return 'unknown';
        try {
          readFile(join(procRoot, entry, 'stat'), 'utf8');
          return 'unknown'; // the process is there but its environment is not readable
        } catch (again) {
          if (vanished(again)) continue;
          return 'unknown';
        }
      }
      if (!String(environ).split('\0').includes(`${RECOVERY_ENV}=${id}`)) return 'unknown';
      live += 1;
    }
    if (live) return 'proven';
    if (dead) return 'gone';
    // The last member may have exited since the first check; otherwise nothing proves anything.
    return alive(pgid) ? 'unknown' : 'gone';
  } catch {
    return 'unknown';
  }
}

/**
 * Stops the recorded process groups that provably belong to this run. Per group:
 * 'gone' (nothing left), 'reaped' (killed and confirmed), 'orphan' (still there after the
 * bounded wait) or 'unknown' (not proven ours, or not fully inspectable: nothing is signalled).
 * Never matches on a name or command line. Journal groups and report groups go through here alike.
 */
export async function recoverProcessGroups(
  pgids,
  id,
  { reap = reapProcessGroup, ...inspect } = {},
) {
  const outcome = { gone: [], reaped: [], unknown: [], orphan: [] };
  for (const pgid of pgids) {
    const state = inspectProcessGroup(pgid, id, inspect);
    if (state === 'gone') outcome.gone.push(pgid);
    else if (state === 'unknown') outcome.unknown.push(pgid);
    else {
      const result = await reap(pgid);
      outcome[result === 'orphan' ? 'orphan' : result === 'gone' ? 'gone' : 'reaped'].push(pgid);
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// The lock: one run or recovery at a time per report (the drill's identity). A contender writes
// its own claim file `<report>.lock.<hex>` (atomic: complete or absent), then lists every claim
// beside the report; it holds the lock only when no other claim has an owner that is not PROVEN
// gone. A contender that finds another live claim removes its own and tries again after a
// jittered pause, so two contenders never both pass (each wrote before it listed: the later
// listing sees the earlier write), and a claim is never removed by anyone but its owner, or by a
// holder that has proven the owner gone. Unique names, no unlink of a name somebody else may have
// just re-created: a stale claim needs no takeover race.
// ---------------------------------------------------------------------------------------------

export const LOCK_WAIT_MILLISECONDS = 30_000;
const MAX_LOCK_BYTES = 4096;
const LOCK_NAME = /^[0-9a-f]{16}$/;
const BOOT_ID = /^[0-9a-f-]{36}$/;
const PID_NAMESPACE = /^pid:\[\d+\]$/;

const LOCK_REASONS = {
  busy: 'another run or recovery of this drill is in progress',
  owner: 'a lock left next to the report cannot be proven stale',
  foreign: 'a lock file next to the report is not one this drill wrote',
  create: 'the lock next to the report cannot be created',
};
/** Refused before anything was touched; the phrase is fixed (no path, pid or name). */
export class LockRefused extends Error {
  constructor(reason) {
    super(`${LOCK_REASONS[reason]}; nothing was done`);
    this.name = 'LockRefused';
    this.reason = reason;
  }
}

const orNull = (read) => {
  try {
    return read();
  } catch {
    return null;
  }
};
/** "pid (comm) state ..." -> { state, start }; comm may hold ") ", so the LAST one counts. */
function parseStat(text) {
  const rest = String(text)
    .slice(String(text).lastIndexOf(') ') + 2)
    .split(' ');
  // Field 3 is the state, field 22 the start time in clock ticks since boot.
  if (!/^[A-Za-z]$/.test(rest[0] ?? '') || !/^\d+$/.test(rest[19] ?? '')) throw new Error('stat');
  return { state: rest[0], start: rest[19] };
}

/** Who a lock claim names: enough to prove later that exactly this process is gone. */
export function currentLockOwner({
  pid = process.pid,
  procRoot = '/proc',
  readFile = readFileSync,
  readlink = readlinkSync,
} = {}) {
  return {
    version: 1,
    pid,
    start: orNull(() => parseStat(readFile(join(procRoot, String(pid), 'stat'), 'utf8')).start),
    boot: orNull(() => readFile(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim()),
    ns: orNull(() => readlink(join(procRoot, String(pid), 'ns/pid'))),
  };
}

/**
 * The same three outcomes as inspectProcessGroup, for the process that owns a claim:
 *  - 'gone'    another boot, or kill(pid, 0) says no such process, or the pid now belongs to a
 *              process that started at another time (or is a zombie);
 *  - 'alive'   the process is there (and, when the start time was recorded, is the same one);
 *  - 'unknown' anything else: another pid namespace (the pid means nothing here), a read error,
 *              a malformed field. 'unknown' is never taken over: the caller refuses.
 * Without a /proc start time a live pid cannot be told from a reused one, so it counts as alive.
 */
export function inspectLockOwner(
  owner,
  {
    procRoot = '/proc',
    kill = (pid, signal) => process.kill(pid, signal),
    readFile = readFileSync,
    readlink = readlinkSync,
    self = process.pid,
  } = {},
) {
  try {
    if (owner.boot !== null) {
      const boot = readFile(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim();
      if (boot !== owner.boot) return 'gone';
    }
    if (owner.ns !== orNull(() => readlink(join(procRoot, String(self), 'ns/pid'))))
      return 'unknown';
    try {
      kill(owner.pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return 'gone';
      if (error?.code !== 'EPERM') return 'unknown';
    }
    if (owner.start === null) return 'alive';
    let text;
    try {
      text = readFile(join(procRoot, String(owner.pid), 'stat'), 'utf8');
    } catch (error) {
      return VANISHED.has(error?.code) ? 'gone' : 'unknown';
    }
    const { state, start } = parseStat(text);
    if ('ZXx'.includes(state)) return 'gone';
    return start === owner.start ? 'alive' : 'gone';
  } catch {
    return 'unknown';
  }
}

function readClaim(path, uid) {
  let text;
  try {
    text = readRegularFile(path, {
      maxBytes: MAX_LOCK_BYTES,
      noFollow: true,
      inspect: (stat) => {
        if (uid !== undefined && stat.uid !== uid) throw new LockRefused('foreign');
        if ((stat.mode & 0o077) !== 0) throw new LockRefused('foreign');
      },
    });
  } catch (error) {
    if (error instanceof LockRefused) throw error;
    if (error instanceof InputFileError && error.kind === 'missing') return null; // released
    throw new LockRefused('foreign');
  }
  let claim;
  try {
    claim = JSON.parse(text);
  } catch {
    throw new LockRefused('foreign');
  }
  const shaped =
    isObject(claim) &&
    isDeepStrictEqual(Object.keys(claim).sort(), ['boot', 'ns', 'pid', 'start', 'version']) &&
    claim.version === 1 &&
    Number.isSafeInteger(claim.pid) &&
    claim.pid > 0 &&
    claim.pid <= MAX_PID &&
    (claim.start === null || (typeof claim.start === 'string' && /^\d{1,20}$/.test(claim.start))) &&
    (claim.boot === null || (typeof claim.boot === 'string' && BOOT_ID.test(claim.boot))) &&
    (claim.ns === null || (typeof claim.ns === 'string' && PID_NAMESPACE.test(claim.ns)));
  if (!shaped) throw new LockRefused('foreign');
  return claim;
}

/**
 * Takes the lock for `reportPath` (the drill's identity), waiting at most `waitMilliseconds` for a
 * live owner, and returns `{ release }`. Throws LockRefused: 'busy' (a live owner after the wait),
 * 'owner' (a claim whose owner is neither provably alive nor provably gone), 'foreign' (a file
 * that is not a claim this drill wrote), 'create'. Claims of owners proven gone are removed.
 */
export async function acquireDrillLock(
  reportPath,
  {
    waitMilliseconds = LOCK_WAIT_MILLISECONDS,
    pollMilliseconds = 100,
    // Monotonic: a wall-clock step must not stretch or cut the bounded wait.
    now = () => performance.now(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    random = Math.random,
    owner = currentLockOwner(),
    inspect = inspectLockOwner,
    uid = process.getuid?.(),
  } = {},
) {
  const directory = dirname(reportPath);
  const prefix = `${basename(reportPath)}.lock.`;
  const deadline = now() + waitMilliseconds;
  const remove = (path) => {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
  for (;;) {
    const mine = `${reportPath}.lock.${randomBytes(8).toString('hex')}`;
    try {
      writeReportAtomically(mine, owner);
    } catch {
      throw new LockRefused('create');
    }
    let busy = false;
    const stale = [];
    try {
      let names;
      try {
        names = readdirSync(directory);
      } catch {
        throw new LockRefused('create');
      }
      for (const name of names) {
        if (!name.startsWith(prefix) || !LOCK_NAME.test(name.slice(prefix.length))) continue;
        const path = join(directory, name);
        if (path === mine) continue;
        const claim = readClaim(path, uid);
        if (claim === null) continue;
        const state = inspect(claim);
        if (state === 'gone') stale.push(path);
        else if (state === 'alive') busy = true;
        else throw new LockRefused('owner');
      }
    } catch (error) {
      remove(mine);
      throw error;
    }
    if (!busy) {
      stale.forEach(remove);
      return { release: () => remove(mine) };
    }
    remove(mine);
    if (now() >= deadline) throw new LockRefused('busy');
    await sleep(pollMilliseconds + Math.floor(random() * pollMilliseconds));
  }
}
