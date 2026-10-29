import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
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
//   * recovery's OWN children are recorded too, in a separate atomic journal in the same
//     directory (the report stays immutable) and carry the same id: a later recovery reaps the
//     journal's groups first, and the directory is removed only after a "recovered" checkpoint.
// The same checks guard the normal teardown (`assertOwnedCompose`). Every refusal is a fixed
// phrase: it never quotes the record, a path or a name from it.
// ---------------------------------------------------------------------------------------------

export const RECOVERY_VERSION = 1;
/** Present in every child's environment: how a recorded process group proves it is ours. */
export const RECOVERY_ENV = 'RASTA_DRILL_RECOVERY_ID';
export const RECOVERY_MARKER = 'recovery.json';
export const RECOVERY_JOURNAL = 'recovery-journal.json';
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
 * The recovery journal: what `--cleanup-from` itself started and has not seen end. A separate
 * file, written atomically (sibling + fsync + rename) in the run's private directory, because
 * the report is the immutable claim of the original run. `groups` are the process groups of
 * recovery's own children (and any group an earlier recovery could not settle); `recovered` is
 * the checkpoint that says every owned resource and process is gone and only the directory
 * remains. Bound to the same project, id and directory name as the marker.
 */
export function writeRecoveryJournal(
  temporary,
  { project, id, groups = [], recovered = false },
  { fs } = {},
) {
  writeReportAtomically(
    join(temporary, RECOVERY_JOURNAL),
    {
      version: RECOVERY_VERSION,
      id,
      project,
      directory: basename(temporary),
      groups: [...new Set(groups)],
      ...(recovered && { checkpoint: 'recovered' }),
    },
    { durable: recovered, ...(fs && { fs }) },
  );
}

function loadRecoveryJournal(temporary, { id, project, uid }) {
  const text = readPrivateFile(join(temporary, RECOVERY_JOURNAL), {
    maxBytes: MAX_JOURNAL_BYTES,
    what: 'the recovery journal',
    uid,
    allowMissing: true,
  });
  if (text === undefined) return { groups: [], recovered: false };
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
    (checkpoint !== undefined && checkpoint !== 'recovered') ||
    !Array.isArray(groups)
  )
    refuse('the recovery journal does not match the directory it is in');
  return { groups: validGroups(groups), recovered: checkpoint === 'recovered' };
}

/**
 * Proves what a report claims, or refuses (RecoveryRefused). Returns what recovery may act on:
 * `{ project, temporary, id, composeFile, processGroups, journalGroups, recovered,
 * directoryPresent }`; `composeFile` is null when the definition is gone (teardown already ran:
 * the project label alone is checked); `recovered` says an earlier recovery finished and only the
 * directory is left (its journal carries the checkpoint).
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

  if (inspectDirectory(temporary, uid) === 'absent') {
    // Nothing to bind the project to: acceptable only when the run itself finished its cleanup.
    if (record.cleanup?.passed !== true || processGroups.length)
      refuse('the temporary directory is gone but the report does not say cleanup finished');
    return {
      project,
      temporary,
      id,
      composeFile: null,
      processGroups,
      journalGroups: [],
      recovered: false,
      directoryPresent: false,
    };
  }
  const journal = loadRecoveryJournal(temporary, { id, project, uid });
  if (journal.recovered)
    // The checkpoint was written after everything owned was gone; the removal that followed may
    // have been cut short (the marker may be among what it already deleted).
    return {
      project,
      temporary,
      id,
      composeFile: null,
      processGroups: [],
      journalGroups: [],
      recovered: true,
      directoryPresent: true,
    };
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
    recovered: false,
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
