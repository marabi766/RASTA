import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ForeignArtifact,
  atomicTempPath,
  identityAt,
  parseIdentity,
  serializeIdentity,
} from './backup-restore-drill-lib.mjs';
import {
  RECOVERY_ENV,
  RECOVERY_MARKER,
  ArtifactRefused,
  DirectoryRefused,
  LockRefused,
  acquireDrillLock,
  assertReportName,
  isDerivedArtifactName,
  reserveRunArtifacts,
  currentLockOwner,
  inspectLockOwner,
  recoveryJournalPath,
  RecoveryRefused,
  assertOwnedCompose,
  assertPrivateDirectory,
  inspectProcessGroup,
  loadRecoveryRecord,
  newRecoveryId,
  recoverProcessGroups,
  removeOwnedDirectory,
  resolveTemporaryRoot,
  validateComposeDefinition,
  writeRecoveryJournal,
  writeRecoveryMarker,
} from './backup-restore-drill-recovery.mjs';

const IMAGE = `postgis/postgis:16-3.4@sha256:${'a'.repeat(64)}`;
const projectName = () => `restore-drill-${newRecoveryId().slice(0, 16)}`;

/** The definition the CLI writes (same keys and shapes), for `project`. */
export function composeFor(project) {
  const service = (name, data) => ({
    image: IMAGE,
    restart: 'no',
    mem_limit: '512m',
    cpus: 1,
    environment: { POSTGRES_USER: 'rasta', POSTGRES_DB: 'postgres' },
    env_file: ['/repo/.env.migrator.example'],
    ports: ['127.0.0.1::5432'],
    volumes: [
      `${data}:/var/lib/postgresql/data`,
      '/repo/infrastructure/docker/postgres:/docker-entrypoint-initdb.d:ro',
    ],
    healthcheck: { test: ['CMD-SHELL', 'pg_isready'], interval: '2s', start_period: '180s' },
    container_name: `${project}-${name}`,
  });
  return {
    services: { source: service('source', 'data'), restored: service('restored', 'restored') },
    volumes: { data: {}, restored: {} },
  };
}

/** A complete, valid record under `root`: report, directory with marker and compose.json. */
export function makeRecord(root, overrides = {}) {
  const project = overrides.project ?? projectName();
  const id = overrides.id ?? newRecoveryId();
  const temporary = mkdtempSync(join(root, 'rasta-restore-drill-'));
  writeRecoveryMarker(temporary, { project, id });
  writeFileSync(join(temporary, 'compose.json'), JSON.stringify(composeFor(project)), {
    mode: 0o600,
  });
  const reportPath = join(root, `report-${id.slice(0, 6)}.json`);
  // What the run persists outside the tree (`legacy: true`: a report from before it did).
  const report = {
    project,
    temporary,
    recoveryId: id,
    ...(overrides.legacy ? {} : { temporaryIdentity: serializeIdentity(identityAt(temporary)) }),
    processGroups: [],
    cleanup: { passed: false },
    ...overrides.report,
  };
  writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600 });
  return {
    project,
    id,
    temporary,
    identity: identityAt(temporary),
    reportPath,
    report,
  };
}
const rewrite = (record, change) => {
  writeFileSync(record.reportPath, JSON.stringify({ ...record.report, ...change }), {
    mode: 0o600,
  });
};
async function withRoot(body) {
  const root = mkdtempSync(join(tmpdir(), 'drill-recovery-'));
  try {
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const refused = (action, reason) =>
  assert.throws(action, (error) => {
    assert.ok(error instanceof RecoveryRefused);
    assert.match(error.message, reason);
    return true;
  });

test('a record the run wrote is accepted, with its compose file and recorded groups', () =>
  withRoot((root) => {
    const record = makeRecord(root, {
      report: { processGroups: [4242], orphanProcessGroups: [4243] },
    });
    const loaded = loadRecoveryRecord(record.reportPath, { tmpRoot: root });
    assert.equal(loaded.project, record.project);
    assert.equal(loaded.id, record.id);
    assert.equal(loaded.temporary, record.temporary);
    assert.equal(loaded.composeFile, join(record.temporary, 'compose.json'));
    assert.deepEqual(loaded.processGroups, [4242, 4243]);
    assert.equal(loaded.directoryPresent, true);
  }));

test('missing, unreadable, empty and unknown-ownership records are refused, never treated as nothing to do', () =>
  withRoot((root) => {
    refused(() => loadRecoveryRecord(join(root, 'absent.json'), { tmpRoot: root }), /missing/);
    const path = join(root, 'r.json');
    for (const [text, reason] of [
      ['', /not valid JSON/],
      ['{"project": "restore-drill-0123456789abcdef", "tem', /not valid JSON/],
      ['[]', /not an object/],
      ['{}', /names no project/],
      [JSON.stringify({ project: 'restore-drill-0123456789abcdef' }), /no recovery id/],
      [
        JSON.stringify({ project: 'restore-drill-0123456789abcdef', recoveryId: 'a'.repeat(32) }),
        /names no directory/,
      ],
    ]) {
      writeFileSync(path, text, { mode: 0o600 });
      refused(() => loadRecoveryRecord(path, { tmpRoot: root }), reason);
    }
    // A report that is not private is not trusted either.
    writeFileSync(path, '{}', { mode: 0o600 });
    chmodSync(path, 0o644);
    refused(() => loadRecoveryRecord(path, { tmpRoot: root }), /not private/);
  }));

test('a project and a directory that do not have the shapes the CLI creates are refused', () =>
  withRoot((root) => {
    const record = makeRecord(root);
    for (const change of [
      { project: 'restore-drill-9007199254740993' },
      { project: `${record.project}x` },
      { project: '../../etc' },
      { recoveryId: 'not-hex' },
      { temporary: join(root, 'other-name') },
      { temporary: 'relative/rasta-restore-drill-abcdef' },
      { temporary: join(root, 'sub', 'rasta-restore-drill-abcdef') },
      { temporary: `${record.temporary}/../${record.temporary.split('/').at(-1)}x` },
      { processGroups: [1] },
      { processGroups: [0] },
      { processGroups: [-5] },
      { processGroups: ['12'] },
      { processGroups: 12 },
      { orphanProcessGroups: [2 ** 40] },
      { unconfirmedProcessGroups: [{ pgid: 'x' }] },
    ]) {
      rewrite(record, change);
      refused(() => loadRecoveryRecord(record.reportPath, { tmpRoot: root }), /refused/);
    }
  }));

test('a mixed record (project A with the directory of project B) is refused', () =>
  withRoot((root) => {
    // Older reports (no persisted identity): the marker is what tells the two apart.
    const a = makeRecord(root, { legacy: true });
    const b = makeRecord(root, { legacy: true });
    // Same id, other project; same project, other id; the other run's directory entirely.
    rewrite(a, { temporary: b.temporary });
    refused(
      () => loadRecoveryRecord(a.reportPath, { tmpRoot: root }),
      /does not match the directory/,
    );
    rewrite(a, { recoveryId: b.id });
    refused(
      () => loadRecoveryRecord(a.reportPath, { tmpRoot: root }),
      /does not match the directory/,
    );
    rewrite(a, { project: b.project });
    refused(
      () => loadRecoveryRecord(a.reportPath, { tmpRoot: root }),
      /does not match the directory/,
    );
    // The untouched pair is still fine.
    rewrite(a, {});
    assert.equal(loadRecoveryRecord(a.reportPath, { tmpRoot: root }).project, a.project);
  }));

test("a record that persisted its identity meets another run's directory as a foreign object", () =>
  withRoot((root) => {
    const a = makeRecord(root);
    const b = makeRecord(root);
    rewrite(a, { temporary: b.temporary });
    assert.throws(() => loadRecoveryRecord(a.reportPath, { tmpRoot: root }), ForeignArtifact);
    assert.equal(existsSync(join(b.temporary, RECOVERY_MARKER)), true);
  }));

test('a marker that is missing, altered or not private is refused', () =>
  withRoot((root) => {
    const record = makeRecord(root);
    const marker = join(record.temporary, RECOVERY_MARKER);
    const good = readFileSync(marker, 'utf8');
    writeFileSync(marker, good.replace('"version": 1', '"version": 2'), { mode: 0o600 });
    refused(() => loadRecoveryRecord(record.reportPath, { tmpRoot: root }), /does not match/);
    writeFileSync(marker, good, { mode: 0o600 });
    chmodSync(marker, 0o666);
    refused(() => loadRecoveryRecord(record.reportPath, { tmpRoot: root }), /not private/);
    rmSync(marker);
    refused(() => loadRecoveryRecord(record.reportPath, { tmpRoot: root }), /marker is missing/);
  }));

test('a symlinked temporary directory, marker or compose.json is refused', () =>
  withRoot((root) => {
    const record = makeRecord(root, { legacy: true });
    // The directory itself replaced by a link to a real one holding a valid marker.
    const real = join(root, 'elsewhere');
    renameSync(record.temporary, real);
    symlinkSync(real, record.temporary);
    refused(() => loadRecoveryRecord(record.reportPath, { tmpRoot: root }), /not a real directory/);
    rmSync(record.temporary);
    renameSync(real, record.temporary);

    const compose = join(record.temporary, 'compose.json');
    const target = join(root, 'other-compose.json');
    writeFileSync(target, JSON.stringify(composeFor(record.project)), { mode: 0o600 });
    rmSync(compose);
    symlinkSync(target, compose);
    refused(
      () => loadRecoveryRecord(record.reportPath, { tmpRoot: root }),
      /compose.json cannot be opened safely/,
    );
    refused(() => assertOwnedCompose(compose, record.project), /cannot be opened safely/);

    const marker = join(record.temporary, RECOVERY_MARKER);
    const copy = join(root, 'marker-copy.json');
    writeFileSync(copy, readFileSync(marker), { mode: 0o600 });
    rmSync(marker);
    symlinkSync(copy, marker);
    refused(
      () => loadRecoveryRecord(record.reportPath, { tmpRoot: root }),
      /marker cannot be opened safely/,
    );
  }));

test('a missing compose.json is accepted (teardown already ran); a directory that is gone only after a finished cleanup', () =>
  withRoot((root) => {
    const record = makeRecord(root);
    rmSync(join(record.temporary, 'compose.json'));
    assert.equal(loadRecoveryRecord(record.reportPath, { tmpRoot: root }).composeFile, null);

    rmSync(record.temporary, { recursive: true });
    refused(
      () => loadRecoveryRecord(record.reportPath, { tmpRoot: root }),
      /directory is gone but the report does not say cleanup finished/,
    );
    rewrite(record, { cleanup: { passed: true } });
    const loaded = loadRecoveryRecord(record.reportPath, { tmpRoot: root });
    assert.equal(loaded.directoryPresent, false);
    assert.equal(loaded.composeFile, null);
    rewrite(record, { cleanup: { passed: true }, processGroups: [4242] });
    refused(() => loadRecoveryRecord(record.reportPath, { tmpRoot: root }), /directory is gone/);
  }));

test('compose definitions: only the one the CLI writes for this project is accepted', () => {
  const project = projectName();
  validateComposeDefinition(composeFor(project), project);
  const mutate = (change) => {
    const definition = structuredClone(composeFor(project));
    change(definition);
    return definition;
  };
  const bad = {
    'another project': () => composeFor(projectName()),
    'a privileged service': mutate((d) => (d.services.source.privileged = true)),
    'host network': mutate((d) => (d.services.source.network_mode = 'host')),
    'a host bind of /': mutate((d) => (d.services.source.volumes[1] = '/:/mnt:rw')),
    'a bind next to the init mount': mutate((d) => d.services.source.volumes.push('/etc:/etc')),
    'the init mount writable': mutate(
      (d) => (d.services.source.volumes[1] = d.services.source.volumes[1].replace(':ro', '')),
    ),
    'swapped data volumes': mutate(
      (d) => (d.services.restored.volumes[0] = 'data:/var/lib/postgresql/data'),
    ),
    'an extra service': mutate((d) => (d.services.extra = d.services.source)),
    'a missing service': mutate((d) => delete d.services.restored),
    'an include': { ...composeFor(project), include: ['/tmp/other.yml'] },
    'extra top-level volumes': mutate((d) => (d.volumes.stolen = { external: true })),
    'a container named for another project': mutate(
      (d) => (d.services.source.container_name = 'host-db'),
    ),
    'a published port on all interfaces': mutate((d) => (d.services.source.ports = ['5432:5432'])),
    'an unpinned image': mutate((d) => (d.services.source.image = 'postgres:16')),
    'an interpolation': mutate((d) => (d.services.source.environment.X = '${HOME}')),
    'an extra healthcheck key': mutate((d) => (d.services.source.healthcheck.disable = false)),
    'an env_file elsewhere': mutate((d) => (d.services.source.env_file = ['/etc/shadow'])),
    'restart always': mutate((d) => (d.services.source.restart = 'always')),
    'a string': 'services',
    'an array': [],
    null: null,
  };
  for (const [name, definition] of Object.entries(bad))
    assert.throws(() => validateComposeDefinition(definition, project), RecoveryRefused, name);
});

test('assertOwnedCompose reads the file as a private regular file of that project', () =>
  withRoot((root) => {
    const project = projectName();
    const path = join(root, 'compose.json');
    writeFileSync(path, JSON.stringify(composeFor(project)), { mode: 0o600 });
    assertOwnedCompose(path, project);
    refused(() => assertOwnedCompose(path, projectName()), /not the one this drill writes/);
    writeFileSync(path, '{', { mode: 0o600 });
    refused(() => assertOwnedCompose(path, project), /not valid JSON/);
    writeFileSync(path, JSON.stringify(composeFor(project)), { mode: 0o600 });
    chmodSync(path, 0o644);
    refused(() => assertOwnedCompose(path, project), /not private/);
    chmodSync(path, 0o600);
    writeFileSync(path, ' '.repeat(70_000), { mode: 0o600 });
    refused(() => assertOwnedCompose(path, project), /too large/);
    mkdirSync(join(root, 'dir'));
    refused(() => assertOwnedCompose(join(root, 'dir'), project), /not a regular file|cannot be/);
  }));

// --- recoverProcessGroups against a fake /proc ----------------------------------------------
function fakeProc(root, processes) {
  const proc = join(root, 'proc');
  mkdirSync(proc);
  for (const { pid, pgrp, state = 'S', comm = 'x', environ = '' } of processes) {
    mkdirSync(join(proc, String(pid)));
    writeFileSync(
      join(proc, String(pid), 'stat'),
      `${pid} (${comm}) ${state} 1 ${pgrp} ${pgrp} 0\n`,
    );
    if (environ !== null) writeFileSync(join(proc, String(pid), 'environ'), environ);
  }
  writeFileSync(join(proc, 'cpuinfo'), '');
  return proc;
}
const owns = (id) => `PATH=/bin\0${RECOVERY_ENV}=${id}\0`;

test('process groups: only a group whose every live member carries the id is signalled', () =>
  withRoot(async (root) => {
    const id = newRecoveryId();
    const proc = fakeProc(root, [
      { pid: 200, pgrp: 200, environ: owns(id) },
      { pid: 201, pgrp: 200, comm: 'a (b) c', environ: owns(id) },
      { pid: 300, pgrp: 300, environ: owns(id) },
      { pid: 301, pgrp: 300, environ: 'PATH=/bin\0' },
      { pid: 400, pgrp: 400, environ: owns('f'.repeat(32)) },
      { pid: 500, pgrp: 500, environ: null },
      { pid: 600, pgrp: 600, state: 'Z', environ: '' },
      { pid: 601, pgrp: 600, state: 'Z', environ: '' },
    ]);
    const reaped = [];
    const outcome = await recoverProcessGroups([200, 300, 400, 500, 600, 700], id, {
      procRoot: proc,
      alive: (pgid) => pgid !== 700,
      reap: async (pgid) => {
        reaped.push(pgid);
        return pgid === 200 ? 'reaped' : 'orphan';
      },
    });
    assert.deepEqual(reaped, [200], 'nothing else was signalled');
    assert.deepEqual(outcome, {
      gone: [600, 700],
      reaped: [200],
      unknown: [300, 400, 500],
      orphan: [],
    });
  }));

test('process groups: a group that stays after the bounded wait is an orphan; no /proc proves nothing', () =>
  withRoot(async (root) => {
    const id = newRecoveryId();
    const proc = fakeProc(root, [{ pid: 200, pgrp: 200, environ: owns(id) }]);
    assert.deepEqual(
      await recoverProcessGroups([200], id, {
        procRoot: proc,
        alive: () => true,
        reap: async () => 'orphan',
      }),
      { gone: [], reaped: [], unknown: [], orphan: [200] },
    );
    const outcome = await recoverProcessGroups([200], id, {
      procRoot: join(root, 'no-proc-here'),
      alive: () => true,
      reap: async () => assert.fail('must not signal what it cannot list'),
    });
    assert.deepEqual(outcome.unknown, [200]);
  }));

// --- UNKNOWN is never GONE and never signalled (#478 r3 R2) ----------------------------------
// The /proc view is injected, so each failure is exactly the one named. `alive` stays true: the
// group exists, only the inspection fails.
const ID = 'a'.repeat(32);
const errno = (code) => Object.assign(new Error(code), { code });
const stat = (pid, pgrp, state = 'S', comm = 'x') =>
  `${pid} (${comm}) ${state} 1 ${pgrp} ${pgrp} 0\n`;
function procView(files, { listing } = {}) {
  return {
    readdir: () => {
      if (listing) throw listing;
      return Object.keys(files);
    },
    readFile: (path) => {
      const [, , pid, name] = path.split('/');
      let value = files[pid]?.[name];
      if (typeof value === 'function') value = value();
      if (value instanceof Error) throw value;
      if (value === undefined) throw errno('ENOENT');
      return value;
    },
  };
}
async function recoverWith(files, options = {}) {
  const signalled = [];
  const outcome = await recoverProcessGroups([50], ID, {
    procRoot: '/proc',
    alive: () => true,
    reap: async (pgid) => {
      signalled.push(pgid);
      return 'reaped';
    },
    ...procView(files, options),
  });
  return { outcome, signalled };
}

test('an incomplete /proc inspection is UNKNOWN: not gone, not success, nothing signalled', async () => {
  const cases = {
    'every read denied': {
      100: { stat: errno('EACCES'), environ: errno('EACCES') },
      101: { stat: errno('EACCES'), environ: errno('EACCES') },
    },
    'a malformed stat': { 100: { stat: 'garbage\n', environ: owns(ID) } },
    'a stat whose pid is not its directory': { 100: { stat: stat(999, 50), environ: owns(ID) } },
    'a proven member and one with a malformed stat': {
      100: { stat: stat(100, 50), environ: owns(ID) },
      101: { stat: 'garbage\n', environ: owns(ID) },
    },
    'a proven member and one whose stat names another pid': {
      100: { stat: stat(100, 50), environ: owns(ID) },
      101: { stat: stat(999, 50), environ: owns(ID) },
    },
    'a proven member and one with a non-numeric process group': {
      100: { stat: stat(100, 50), environ: owns(ID) },
      101: { stat: '101 (x) S 1 notanumber 50 0\n', environ: owns(ID) },
    },
    'a non-numeric process group': {
      100: { stat: '100 (x) S 1 notanumber 50 0\n', environ: owns(ID) },
    },
    'an empty view while the group is alive': {},
    'a view with only other groups while the group is alive': {
      100: { stat: stat(100, 77), environ: owns(ID) },
    },
    'one proven member and one whose stat cannot be read': {
      100: { stat: stat(100, 50), environ: owns(ID) },
      101: { stat: errno('EACCES'), environ: errno('EACCES') },
    },
    'one proven member and one whose environment cannot be read': {
      100: { stat: stat(100, 50), environ: owns(ID) },
      101: { stat: stat(101, 50), environ: errno('EACCES') },
    },
    'one proven member and one whose environment vanished while the process did not': {
      100: { stat: stat(100, 50), environ: owns(ID) },
      101: { stat: stat(101, 50) },
    },
    'one proven member and one without the id': {
      100: { stat: stat(100, 50), environ: owns(ID) },
      101: { stat: stat(101, 50), environ: 'PATH=/bin\0' },
    },
  };
  for (const [name, files] of Object.entries(cases)) {
    const { outcome, signalled } = await recoverWith(files);
    assert.deepEqual(outcome, { gone: [], reaped: [], unknown: [50], orphan: [] }, name);
    assert.deepEqual(signalled, [], `${name}: nothing was signalled`);
  }
  const listing = await recoverWith({}, { listing: errno('EACCES') });
  assert.deepEqual(listing.outcome.unknown, [50], 'a listing that fails');
  assert.deepEqual(listing.signalled, []);
});

test('an entry that vanishes between the listing and the read is not an inspection failure', async () => {
  const states = (files, alive = () => true) =>
    inspectProcessGroup(50, ID, { alive, ...procView(files) });
  // The proven member plus a sibling that exited (its stat is gone): the group is proven.
  assert.equal(
    states({
      100: { stat: stat(100, 50), environ: owns(ID) },
      101: { stat: errno('ENOENT') },
      // Readable at the listing, gone by the time its environment is read.
      102: {
        stat: (() => {
          let reads = 0;
          return () => {
            if (++reads > 1) throw errno('ENOENT');
            return stat(102, 50);
          };
        })(),
        environ: errno('ESRCH'),
      },
    }),
    'proven',
  );
  // The last member exited after the first check: gone, not unknown.
  let calls = 0;
  assert.equal(
    states({ 100: { stat: errno('ENOENT') } }, () => ++calls === 1),
    'gone',
  );
  // Zombies only: dead, nothing to signal.
  assert.equal(states({ 100: { stat: stat(100, 50, 'Z') } }), 'gone');
  assert.equal(inspectProcessGroup(50, ID, { alive: () => false }), 'gone');
});

test('the same boundary holds for every recorded list: report groups and journal groups alike', async () => {
  const outcome = await recoverProcessGroups([50, 60, 70], ID, {
    alive: () => true,
    reap: async () => assert.fail('nothing may be signalled'),
    ...procView({ 100: { stat: stat(100, 50), environ: errno('EACCES') } }),
  });
  assert.deepEqual(outcome.unknown, [50, 60, 70]);
});

// --- the recovery journal ---------------------------------------------------------------------
test('the journal is bound to the record, optional, and read like every other input', () =>
  withRoot((root) => {
    const record = makeRecord(root);
    const path = recoveryJournalPath(record.reportPath);
    const load = () => loadRecoveryRecord(record.reportPath, { tmpRoot: root });
    assert.deepEqual(load().journalGroups, [], 'no journal yet: nothing to carry');
    writeRecoveryJournal(path, {
      project: record.project,
      id: record.id,
      temporary: record.temporary,
      groups: [4242, 4242, 4243],
    });
    assert.deepEqual(load().journalGroups, [4242, 4243]);
    assert.equal(load().checkpoint, undefined);
    assert.ok(
      !readdirSync(record.temporary).some((name) => name.includes('journal')),
      'outside the tree',
    );
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const good = readFileSync(path, 'utf8');
    for (const [name, change, reason] of [
      ['another id', (j) => ({ ...j, id: 'b'.repeat(32) }), /does not match/],
      [
        'another project',
        (j) => ({ ...j, project: 'restore-drill-0123456789abcdef' }),
        /does not match/,
      ],
      [
        'another directory',
        (j) => ({ ...j, directory: 'rasta-restore-drill-AAAAAA' }),
        /does not match/,
      ],
      ['an unknown key', (j) => ({ ...j, extra: 1 }), /does not match/],
      ['an unknown checkpoint', (j) => ({ ...j, checkpoint: 'done' }), /does not match/],
      ['the old checkpoint flag', (j) => ({ ...j, recovered: true }), /does not match/],
      ['groups of the wrong shape', (j) => ({ ...j, groups: '4242' }), /does not match/],
      ['an invalid group', (j) => ({ ...j, groups: [1] }), /invalid process group/],
    ]) {
      writeFileSync(path, JSON.stringify(change(JSON.parse(good))), { mode: 0o600 });
      refused(load, reason);
      assert.ok(name);
    }
    writeFileSync(path, '{', { mode: 0o600 });
    refused(load, /not valid JSON/);
    writeFileSync(path, good, { mode: 0o666 });
    chmodSync(path, 0o666);
    refused(load, /not private/);
    rmSync(path);
    symlinkSync(join(root, 'elsewhere'), path);
    refused(load, /cannot be opened safely/);
  }));

const checkpointFor = (record, checkpoint, groups = [], identity = record.identity) =>
  writeRecoveryJournal(recoveryJournalPath(record.reportPath), {
    project: record.project,
    id: record.id,
    temporary: record.temporary,
    identity,
    groups,
    checkpoint,
  });

test('the checkpoint outlives what it authorizes deleting: it stands without the marker, and without the directory', () =>
  withRoot((root) => {
    const record = makeRecord(root);
    checkpointFor(record, 'recovered');
    rmSync(join(record.temporary, RECOVERY_MARKER));
    rmSync(join(record.temporary, 'compose.json'));
    let loaded = loadRecoveryRecord(record.reportPath, { tmpRoot: root });
    assert.equal(loaded.checkpoint, 'recovered');
    assert.equal(loaded.directoryPresent, true);
    assert.deepEqual([loaded.processGroups, loaded.journalGroups], [[], []]);
    // The removal finished and its exit was lost: the report still says cleanup failed.
    rmSync(record.temporary, { recursive: true });
    loaded = loadRecoveryRecord(record.reportPath, { tmpRoot: root });
    assert.equal(loaded.checkpoint, 'recovered');
    assert.equal(loaded.directoryPresent, false);
    checkpointFor(record, 'removed');
    assert.equal(loadRecoveryRecord(record.reportPath, { tmpRoot: root }).checkpoint, 'removed');
    // ... but only for a journal bound to THIS record,
    writeFileSync(
      recoveryJournalPath(record.reportPath),
      JSON.stringify({
        version: 1,
        id: 'c'.repeat(32),
        project: record.project,
        directory: record.temporary.split('/').at(-1),
        groups: [],
        checkpoint: 'recovered',
      }),
      { mode: 0o600 },
    );
    refused(() => loadRecoveryRecord(record.reportPath, { tmpRoot: root }), /recovery journal/);
  }));

test('a directory that is back after a "removed" checkpoint is refused; without a checkpoint a vanished directory still needs the report to say cleanup finished', () =>
  withRoot((root) => {
    const record = makeRecord(root);
    checkpointFor(record, 'removed');
    refused(
      () => loadRecoveryRecord(record.reportPath, { tmpRoot: root }),
      /reappeared after it was removed/,
    );
    rmSync(recoveryJournalPath(record.reportPath));
    rmSync(record.temporary, { recursive: true });
    refused(
      () => loadRecoveryRecord(record.reportPath, { tmpRoot: root }),
      /directory is gone but the report does not say cleanup finished/,
    );
  }));

test('a directory-absent record still hands over the groups its earlier recovery journaled', () =>
  withRoot((root) => {
    const record = makeRecord(root, { report: { cleanup: { passed: true } } });
    rmSync(record.temporary, { recursive: true });
    checkpointFor(record, undefined, [4242]);
    const loaded = loadRecoveryRecord(record.reportPath, { tmpRoot: root });
    assert.equal(loaded.directoryPresent, false);
    assert.deepEqual(loaded.journalGroups, [4242]);
    assert.equal(loaded.checkpoint, undefined);
  }));

test('a journal write is atomic: a failure leaves the previous complete journal', () =>
  withRoot((root) => {
    const record = makeRecord(root);
    const path = recoveryJournalPath(record.reportPath);
    const base = { project: record.project, id: record.id, temporary: record.temporary };
    writeRecoveryJournal(path, { ...base, groups: [4242] });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const before = readFileSync(path, 'utf8');
    const fs = {
      openSync,
      writeSync,
      fsyncSync,
      closeSync,
      unlinkSync,
      renameSync: () => {
        throw errno('EIO');
      },
    };
    assert.throws(() => writeRecoveryJournal(path, { ...base, groups: [9999] }, { fs }));
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.deepEqual(
      readdirSync(root).filter((name) => name.endsWith('.tmp')),
      [],
      'no sibling left behind',
    );
  }));

test('a journal write whose durability is not confirmed throws: file fsync and directory fsync alike', () =>
  withRoot((root) => {
    const record = makeRecord(root);
    const path = recoveryJournalPath(record.reportPath);
    const base = { project: record.project, id: record.id, temporary: record.temporary };
    const real = { openSync, writeSync, fsyncSync, closeSync, unlinkSync, renameSync };
    // The directory descriptor is the only one opened without 'wx'.
    const failing = (where) => {
      const directories = new Set();
      return {
        ...real,
        openSync: (target, flags, mode) => {
          const fd = openSync(target, flags, mode);
          if (flags === 'r') directories.add(fd);
          return fd;
        },
        fsyncSync: (fd) => {
          if (directories.has(fd) === (where === 'directory')) throw errno('EIO');
          return fsyncSync(fd);
        },
      };
    };
    assert.throws(
      () =>
        writeRecoveryJournal(
          path,
          { ...base, checkpoint: 'recovered' },
          { fs: failing('directory') },
        ),
      /could not be made durable/,
    );
    assert.throws(
      () =>
        writeRecoveryJournal(path, { ...base, checkpoint: 'recovered' }, { fs: failing('file') }),
      /Could not write report/,
    );
    writeRecoveryJournal(path, { ...base, checkpoint: 'recovered' }, { fs: real });
  }));

// --- one deletion boundary (#478 r5 F2) ---------------------------------------------------------
test('removeOwnedDirectory: the removal runs only between two durable checkpoints, written afresh every time', () =>
  withRoot((root) => {
    const ownerOf = (record) => ({
      journalPath: recoveryJournalPath(record.reportPath),
      project: record.project,
      id: record.id,
      temporary: record.temporary,
      identity: record.identity,
    });
    const checkpoint = (owner) => JSON.parse(readFileSync(owner.journalPath, 'utf8')).checkpoint;
    const real = { openSync, writeSync, fsyncSync, closeSync, unlinkSync, renameSync };
    // The directory descriptor is the only one opened without 'wx'.
    const brokenDirectory = () => {
      const directories = new Set();
      return {
        ...real,
        openSync: (target, flags, mode) => {
          const fd = openSync(target, flags, mode);
          if (flags === 'r') directories.add(fd);
          return fd;
        },
        fsyncSync: (fd) => {
          if (directories.has(fd)) throw errno('EIO');
          return fsyncSync(fd);
        },
      };
    };
    // Order: the durable "recovered" checkpoint stands when the removal starts.
    const first = ownerOf(makeRecord(root));
    const seen = [];
    removeOwnedDirectory({
      ...first,
      remove: () => {
        seen.push(checkpoint(first));
        rmSync(first.temporary, { recursive: true });
      },
    });
    assert.deepEqual(seen, ['recovered']);
    assert.equal(checkpoint(first), 'removed');
    assert.equal(existsSync(first.temporary), false);

    // A checkpoint whose directory fsync failed is on disk and readable, but proves nothing:
    // while the fault stays, a loaded one never licenses the removal (and the failure is told).
    const fresh = ownerOf(makeRecord(root));
    let failures = 0;
    for (let attempt = 0; attempt < 2; attempt++)
      assert.throws(() =>
        removeOwnedDirectory({
          ...fresh,
          fs: brokenDirectory(),
          remove: () => assert.fail('removed without a durable checkpoint'),
          onFailure: () => failures++,
        }),
      );
    assert.equal(failures, 2);
    assert.equal(checkpoint(fresh), 'recovered', 'the unconfirmed checkpoint is readable');
    assert.equal(existsSync(fresh.temporary), true);
    // The fault gone: the same call completes.
    removeOwnedDirectory(fresh);
    assert.equal(existsSync(fresh.temporary), false);
    assert.equal(checkpoint(fresh), 'removed');

    // A directory that is already gone is not removed again, and still ends at "removed".
    removeOwnedDirectory({
      ...fresh,
      directoryPresent: false,
      remove: () => assert.fail('nothing to remove'),
    });
    // A removal that throws part-way leaves the "recovered" checkpoint standing.
    const last = ownerOf(makeRecord(root));
    assert.throws(() =>
      removeOwnedDirectory({
        ...last,
        remove: () => {
          throw errno('EIO');
        },
      }),
    );
    assert.equal(checkpoint(last), 'recovered');
  }));

// --- special files never block an input (#478 r3 R3) -----------------------------------------
// Each case runs in a child with a deadline: a blocking open would hang it (and the test fails
// by the deadline) instead of hanging this process.
const recoveryModule = new URL('./backup-restore-drill-recovery.mjs', import.meta.url).href;
function inChild(source, args) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, '--', ...args], {
    timeout: 10_000,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
  });
  assert.equal(result.signal, null, 'the child blocked on a special file');
  return result;
}
const LOAD = `import { loadRecoveryRecord, assertOwnedCompose } from ${JSON.stringify(recoveryModule)};
try { const [mode, a, b, c] = process.argv.slice(1);
  if (mode === 'record') loadRecoveryRecord(a, { tmpRoot: b });
  else assertOwnedCompose(a, b);
  console.log('accepted'); } catch (e) { console.log(e.name + ': ' + e.message); }`;

test('a FIFO in place of the report, marker, journal or compose file is refused without blocking', () =>
  withRoot((root) => {
    const swapFifo = (path) => {
      rmSync(path, { force: true });
      execFileSync('mkfifo', [path]);
    };
    const expectRefusal = (record, reason) => {
      const result = inChild(LOAD, ['record', record.reportPath, root]);
      assert.match(result.stdout, reason, result.stdout);
    };
    let record = makeRecord(root);
    swapFifo(record.reportPath);
    expectRefusal(record, /RecoveryRefused: recovery refused: the report is not a regular file/);
    record = makeRecord(root);
    swapFifo(join(record.temporary, RECOVERY_MARKER));
    expectRefusal(record, /directory marker is not a regular file/);
    record = makeRecord(root);
    swapFifo(join(record.temporary, 'compose.json'));
    expectRefusal(record, /compose.json is not a regular file/);
    record = makeRecord(root);
    swapFifo(recoveryJournalPath(record.reportPath));
    expectRefusal(record, /recovery journal is not a regular file/);
    // The gate in front of `compose down` reads the same way.
    const fifo = join(root, 'gate-compose.json');
    execFileSync('mkfifo', [fifo]);
    const gate = inChild(LOAD, ['compose', fifo, 'restore-drill-0123456789abcdef']);
    assert.match(gate.stdout, /compose.json is not a regular file/);
  }));

// --- the lock: one owner at a time (#478 r4 F1) -----------------------------------------------
const BOOT = '0123456789abcdef0123456789abcdef-123'.slice(0, 36);
const claim = (overrides = {}) => ({
  version: 1,
  pid: 4242,
  start: '1000',
  boot: BOOT,
  ns: 'pid:[4026531836]',
  ...overrides,
});
/** A /proc stand-in for inspectLockOwner: `stat` is the text (or an errno) of /proc/<pid>/stat. */
function ownerView({ stat: statText, kill = () => {}, boot = BOOT, ns = 'pid:[4026531836]' } = {}) {
  const read = (path) => {
    if (path.endsWith('boot_id')) return `${boot}\n`;
    if (statText instanceof Error) throw statText;
    return statText;
  };
  return { procRoot: '/proc', kill, readFile: read, readlink: () => ns, self: 1 };
}
const statLine = (pid, state, start) =>
  `${pid} (a) b) ${state} 1 ${pid} ${pid} 0 -1 4194560 100 0 0 0 0 0 0 0 20 0 1 0 ${start} 1000 100 18446744073709551615`;

test('a lock owner is gone, alive or UNKNOWN, with the same strictness as a process group', () => {
  const inspect = (owner, view) => inspectLockOwner(owner, ownerView(view));
  const exists = { stat: statLine(4242, 'S', '1000') };
  assert.equal(inspect(claim(), exists), 'alive');
  assert.equal(inspect(claim(), { stat: statLine(4242, 'S', '1001') }), 'gone', 'pid reused');
  assert.equal(inspect(claim(), { stat: statLine(4242, 'Z', '1000') }), 'gone', 'zombie');
  assert.equal(inspect(claim(), { ...exists, boot: 'f'.repeat(36) }), 'gone', 'another boot');
  assert.equal(inspect(claim(), { stat: errno('ENOENT') }), 'gone', 'exited since the kill check');
  const noProcess = () => {
    throw errno('ESRCH');
  };
  assert.equal(inspect(claim(), { ...exists, kill: noProcess }), 'gone');
  const foreignUser = () => {
    throw errno('EPERM');
  };
  assert.equal(inspect(claim(), { ...exists, kill: foreignUser }), 'alive');
  assert.equal(inspect(claim({ start: null }), { kill: () => {}, stat: errno('EACCES') }), 'alive');
  // Everything else is UNKNOWN, never gone.
  assert.equal(inspect(claim(), { ...exists, ns: 'pid:[1]' }), 'unknown', 'another pid namespace');
  assert.equal(inspect(claim(), { stat: errno('EACCES') }), 'unknown', 'unreadable');
  assert.equal(inspect(claim(), { stat: 'garbage' }), 'unknown', 'malformed');
  assert.equal(inspect(claim(), { stat: statLine(4242, '9', 'x') }), 'unknown', 'malformed fields');
  const odd = () => {
    throw errno('EINVAL');
  };
  assert.equal(inspect(claim(), { ...exists, kill: odd }), 'unknown');
  const unreadableBoot = {
    ...ownerView(exists),
    readFile: () => {
      throw errno('EACCES');
    },
  };
  assert.equal(inspectLockOwner(claim(), unreadableBoot), 'unknown');
  // This very process is alive; a child that has exited is gone.
  assert.equal(inspectLockOwner(currentLockOwner()), 'alive');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  assert.equal(inspectLockOwner({ ...currentLockOwner(), pid: dead }), 'gone');
});

const lockFiles = (root) => readdirSync(root).filter((name) => name.includes('.lock.'));
const quick = { pollMilliseconds: 2 };

test('two contenders, either order: the second is refused while the first holds, and released means free', () =>
  withRoot(async (root) => {
    const report = join(root, 'report.json');
    for (const [first, second] of [
      ['A', 'B'],
      ['B', 'A'],
    ]) {
      const one = await acquireDrillLock(report, {
        ...quick,
        owner: claim({ pid: first === 'A' ? 11 : 22 }),
        inspect: () => 'alive',
      });
      await assert.rejects(
        acquireDrillLock(report, {
          ...quick,
          waitMilliseconds: 30,
          owner: claim({ pid: second === 'A' ? 11 : 22 }),
          inspect: () => 'alive',
        }),
        (error) => error instanceof LockRefused && error.reason === 'busy',
      );
      assert.equal(lockFiles(root).length, 1, 'the refused contender left no claim');
      one.release();
      assert.deepEqual(lockFiles(root), []);
    }
  }));

test('many contenders at once: never two holders, every one gets its turn', () =>
  withRoot(async (root) => {
    const report = join(root, 'report.json');
    let holders = 0;
    let most = 0;
    const turn = async (pid) => {
      const lock = await acquireDrillLock(report, {
        ...quick,
        waitMilliseconds: 8000,
        owner: claim({ pid }),
        inspect: () => 'alive',
      });
      holders += 1;
      most = Math.max(most, holders);
      await new Promise((resolve) => setTimeout(resolve, 5));
      holders -= 1;
      lock.release();
    };
    await Promise.all(Array.from({ length: 8 }, (_, index) => turn(100 + index)));
    assert.equal(most, 1);
    assert.deepEqual(lockFiles(root), []);
  }));

test('a stale claim is taken over only when its owner is PROVEN gone; UNKNOWN refuses and leaves it alone', () =>
  withRoot(async (root) => {
    const report = join(root, 'report.json');
    const stale = join(root, 'report.json.lock.0123456789abcdef');
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(stale, JSON.stringify({ ...currentLockOwner(), pid: dead }), { mode: 0o600 });
    const lock = await acquireDrillLock(report, quick);
    assert.equal(lockFiles(root).length, 1, 'the stale claim was removed, ours is the only one');
    assert.ok(!lockFiles(root).includes('report.json.lock.0123456789abcdef'));
    lock.release();

    // Owner in another pid namespace: its pid means nothing here.
    writeFileSync(stale, JSON.stringify(claim({ ns: 'pid:[1]', boot: currentLockOwner().boot })), {
      mode: 0o600,
    });
    await assert.rejects(
      acquireDrillLock(report, { ...quick, waitMilliseconds: 0, owner: currentLockOwner() }),
      (error) =>
        error instanceof LockRefused && error.reason === 'owner' && !error.message.includes(root),
    );
    assert.deepEqual(lockFiles(root), ['report.json.lock.0123456789abcdef'], 'left untouched');
  }));

test('a file that is not a claim this drill wrote is refused, never taken over', () =>
  withRoot(async (root) => {
    const report = join(root, 'report.json');
    const path = join(root, 'report.json.lock.0123456789abcdef');
    const attempt = () => acquireDrillLock(report, { ...quick, waitMilliseconds: 0 });
    const cases = [
      ['not JSON', () => writeFileSync(path, '{', { mode: 0o600 })],
      [
        'unknown key',
        () => writeFileSync(path, JSON.stringify({ ...claim(), extra: 1 }), { mode: 0o600 }),
      ],
      [
        'wrong type',
        () => writeFileSync(path, JSON.stringify(claim({ pid: '4242' })), { mode: 0o600 }),
      ],
      [
        'not private',
        () => {
          writeFileSync(path, JSON.stringify(claim()));
          chmodSync(path, 0o644);
        },
      ],
      ['a link', () => symlinkSync(join(root, 'elsewhere'), path)],
      ['oversize', () => writeFileSync(path, 'x'.repeat(5000), { mode: 0o600 })],
    ];
    for (const [name, make] of cases) {
      rmSync(path, { force: true });
      make();
      await assert.rejects(
        attempt(),
        (error) => error instanceof LockRefused && error.reason === 'foreign',
        name,
      );
      assert.deepEqual(lockFiles(root), ['report.json.lock.0123456789abcdef'], name);
    }
  }));

// --- the report's artifact namespace is reserved before anything is allocated (#478 r6 F4) ----------

const artifactRefused = (action, reason) =>
  assert.throws(action, (error) => {
    assert.ok(error instanceof ArtifactRefused, String(error));
    assert.equal(error.reason, reason);
    return true;
  });

test('a report path may never be a name this drill derives from a report path: every artifact it writes is covered', () =>
  withRoot(async (root) => {
    const report = join(root, 'report.json');
    // The three families, taken from what the code really creates (not retyped here).
    const claims = [];
    const lock = await acquireDrillLock(report, { owner: claim({ pid: 11 }) });
    claims.push(...lockFiles(root));
    lock.release();
    const derived = [
      recoveryJournalPath(report),
      atomicTempPath(report),
      atomicTempPath(recoveryJournalPath(report)),
      ...claims.map((name) => join(root, name)),
      atomicTempPath(claims[0] ? join(root, claims[0]) : report),
    ];
    assert.ok(claims.length === 1, 'a lock claim was observed');
    for (const path of derived) {
      assert.ok(isDerivedArtifactName(path.slice(root.length + 1)), path);
      artifactRefused(() => assertReportName(path), 'name');
    }
    // Ordinary operator names, including look-alikes, are fine.
    for (const name of [
      'report.json',
      'report',
      'x.recovery-journal.json.bak',
      'x.lock.zzzzzzzzzzzzzzzz',
      'x.lock.0123456789abcde',
      'x.0123456789abcdef.tmp.old',
      'drill.tmp',
    ]) {
      assert.equal(isDerivedArtifactName(name), false, name);
      assertReportName(join(root, name));
    }
  }));

test('reserving: the report and a journal reservation exist, private, before anything else; the loader reads the reservation as "nothing recorded"', () =>
  withRoot((root) => {
    const record = makeRecord(root);
    const report = join(root, 'fresh.json');
    const id = newRecoveryId();
    reserveRunArtifacts(report, { id });
    assert.equal(readFileSync(report, 'utf8'), '');
    assert.equal(statSync(report).mode & 0o777, 0o600);
    const journal = recoveryJournalPath(report);
    assert.deepEqual(JSON.parse(readFileSync(journal, 'utf8')), {
      version: 1,
      id,
      reservation: true,
    });
    assert.equal(statSync(journal).mode & 0o777, 0o600);
    // The run's own record, with only the reservation beside it, loads exactly as with no journal.
    const mine = makeRecord(root, { id });
    writeFileSync(recoveryJournalPath(mine.reportPath), readFileSync(journal), { mode: 0o600 });
    const loaded = loadRecoveryRecord(mine.reportPath, { tmpRoot: root });
    assert.deepEqual([loaded.journalGroups, loaded.checkpoint], [[], undefined]);
    // Another run's reservation, or a reservation with anything added, proves nothing.
    writeFileSync(recoveryJournalPath(record.reportPath), readFileSync(journal), { mode: 0o600 });
    refused(() => loadRecoveryRecord(record.reportPath, { tmpRoot: root }), /does not match/);
    for (const extra of [
      { checkpoint: 'removed' },
      { groups: [4242] },
      { project: mine.project },
    ]) {
      writeFileSync(
        recoveryJournalPath(mine.reportPath),
        JSON.stringify({ version: 1, id, reservation: true, ...extra }),
        { mode: 0o600 },
      );
      refused(() => loadRecoveryRecord(mine.reportPath, { tmpRoot: root }), /does not match/);
    }
  }));

test('reserving refuses an existing journal of any kind and leaves it, and creates nothing', () =>
  withRoot((root) => {
    const report = join(root, 'report.json');
    const journal = recoveryJournalPath(report);
    const left = [
      ['a finished run’s journal', JSON.stringify({ version: 1, checkpoint: 'removed' })],
      ['an unreadable sidecar', '{'],
      ['an unrelated file', 'operator notes'],
      ['an empty file', ''],
    ];
    for (const [name, text] of left) {
      writeFileSync(journal, text, { mode: 0o600 });
      artifactRefused(() => reserveRunArtifacts(report, { id: newRecoveryId() }), 'journal');
      assert.equal(readFileSync(journal, 'utf8'), text, `${name} untouched`);
      assert.equal(existsSync(report), false, `${name}: no report created`);
      rmSync(journal);
    }
    // A dangling symlink is a name in use too, and is not followed.
    symlinkSync(join(root, 'elsewhere'), journal);
    artifactRefused(() => reserveRunArtifacts(report, { id: newRecoveryId() }), 'journal');
    assert.equal(existsSync(join(root, 'elsewhere')), false);
    assert.equal(existsSync(report), false);
    rmSync(journal);
    // An existing report is refused as before, and its journal is not created.
    writeFileSync(report, 'x');
    artifactRefused(() => reserveRunArtifacts(report, { id: newRecoveryId() }), 'report');
    assert.equal(existsSync(journal), false);
    assert.equal(readFileSync(report, 'utf8'), 'x');
    assert.deepEqual(readdirSync(root).sort(), ['report.json']);
  }));

test('reserving: two contenders for one journal path, whoever is second is refused and the first’s files stand', () =>
  withRoot((root) => {
    // The journal appears between the check and the exclusive creation (another report claims the
    // name): the exclusive creation is the arbiter, and the report this call made is taken back.
    const report = join(root, 'report.json');
    const journal = recoveryJournalPath(report);
    const open = (path, flags, mode) => {
      if (path === journal) writeFileSync(journal, 'theirs', { mode: 0o600 });
      return openSync(path, flags, mode);
    };
    artifactRefused(
      () => reserveRunArtifacts(report, { id: newRecoveryId() }, { fs: { open } }),
      'journal',
    );
    assert.equal(readFileSync(journal, 'utf8'), 'theirs', 'their journal is not removed');
    assert.equal(existsSync(report), false, 'our report is taken back');
    rmSync(journal);
    // A write that fails after the journal was created removes what this call created.
    artifactRefused(
      () =>
        reserveRunArtifacts(
          report,
          { id: newRecoveryId() },
          {
            fs: {
              write: () => {
                throw new Error('disk full');
              },
            },
          },
        ),
      'journal',
    );
    assert.deepEqual(readdirSync(root), []);
  }));

// Descriptors the reservation opens: the real calls, recorded, so a test can fail any one close
// (after really releasing the descriptor, as the kernel does on EIO) and prove none is left open
// and none is closed twice.
function trackedReservationFs({ failClose = () => false } = {}) {
  const held = new Map();
  const closes = [];
  return {
    closes,
    held,
    fs: {
      open: (path, flags, mode) => {
        const fd = openSync(path, flags, mode);
        held.set(fd, path);
        return fd;
      },
      close: (fd) => {
        const path = held.get(fd);
        closes.push(path);
        held.delete(fd);
        closeSync(fd);
        if (failClose(path)) throw Object.assign(new Error('close failed'), { code: 'EIO' });
      },
    },
  };
}

test('reserving: a failed close of the report or the journal rolls back what this call created, and the next run starts', () =>
  withRoot((root) => {
    const report = join(root, 'report.json');
    const journal = recoveryJournalPath(report);
    for (const [failing, reason] of [
      [report, 'report'],
      [journal, 'journal'],
    ]) {
      const tracked = trackedReservationFs({ failClose: (path) => path === failing });
      artifactRefused(
        () => reserveRunArtifacts(report, { id: newRecoveryId() }, { fs: tracked.fs }),
        reason,
      );
      assert.deepEqual(readdirSync(root), [], `${reason}: neither artifact is left`);
      assert.equal(tracked.held.size, 0, `${reason}: no descriptor left open`);
      assert.deepEqual(
        tracked.closes,
        reason === 'report' ? [report] : [report, journal],
        `${reason}: each descriptor closed exactly once`,
      );
      // The next normal run is not blocked by a leftover.
      reserveRunArtifacts(report, { id: newRecoveryId() });
      assert.deepEqual(readdirSync(root).sort(), [
        'report.json',
        'report.json.recovery-journal.json',
      ]);
      rmSync(report);
      rmSync(journal);
    }
  }));

test('reserving: a failure before the close also closes once and removes only what this call created', () =>
  withRoot((root) => {
    const report = join(root, 'report.json');
    const journal = recoveryJournalPath(report);
    for (const step of ['write', 'sync']) {
      const tracked = trackedReservationFs();
      const broken = () => {
        throw new Error(`${step} failed`);
      };
      artifactRefused(
        () =>
          reserveRunArtifacts(
            report,
            { id: newRecoveryId() },
            { fs: { ...tracked.fs, [step]: broken } },
          ),
        'journal',
      );
      assert.deepEqual(readdirSync(root), [], step);
      assert.equal(tracked.held.size, 0, `${step}: no descriptor left open`);
      assert.deepEqual(tracked.closes, [report, journal], `${step}: each closed exactly once`);
    }
  }));

test('reserving: a close failure never removes an artifact that was already there', () =>
  withRoot((root) => {
    const report = join(root, 'report.json');
    const journal = recoveryJournalPath(report);
    const alwaysFail = () => true;
    // A report that exists: the exclusive open refuses it, nothing of ours exists, nothing is removed.
    writeFileSync(report, 'x');
    let tracked = trackedReservationFs({ failClose: alwaysFail });
    artifactRefused(
      () => reserveRunArtifacts(report, { id: newRecoveryId() }, { fs: tracked.fs }),
      'report',
    );
    assert.deepEqual([readFileSync(report, 'utf8'), existsSync(journal)], ['x', false]);
    assert.deepEqual(tracked.closes, [], 'no descriptor was opened');
    rmSync(report);
    // A journal that exists (any kind) is refused before the report is even created.
    writeFileSync(journal, 'theirs', { mode: 0o600 });
    tracked = trackedReservationFs({ failClose: alwaysFail });
    artifactRefused(
      () => reserveRunArtifacts(report, { id: newRecoveryId() }, { fs: tracked.fs }),
      'journal',
    );
    assert.deepEqual([readFileSync(journal, 'utf8'), existsSync(report)], ['theirs', false]);
    assert.deepEqual(tracked.closes, []);
    rmSync(journal);
    // A journal that appears between the check and our exclusive open (the race): ours is the
    // report, whose close succeeds here; theirs is left, ours is taken back.
    tracked = trackedReservationFs();
    const open = (path, flags, mode) => {
      if (path === journal) writeFileSync(journal, 'theirs', { mode: 0o600 });
      return tracked.fs.open(path, flags, mode);
    };
    artifactRefused(
      () => reserveRunArtifacts(report, { id: newRecoveryId() }, { fs: { ...tracked.fs, open } }),
      'journal',
    );
    assert.deepEqual([readFileSync(journal, 'utf8'), existsSync(report)], ['theirs', false]);
    assert.equal(tracked.held.size, 0);
  }));

// --- the trust boundary is the directory (#512 r1 F1) --------------------------------------------
// The kernel stamps inodes with a coarse clock (a few milliseconds): a replacement made within the
// same tick as the original, with a recycled inode number, would carry the same birth time. A real
// replacement happens later; the tests wait that long so they model one.
const tick = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
const uid = process.getuid();
const mode = (path, bits) => {
  chmodSync(path, bits);
  return path;
};
const directoryRefused = (action) =>
  assert.throws(action, (error) => {
    assert.ok(error instanceof DirectoryRefused, String(error));
    assert.doesNotMatch(error.message, /\/tmp|drill-recovery/, 'a fixed phrase, no path');
    return true;
  });

test('assertPrivateDirectory: only a real directory of this user (or root) that group and others cannot write', () =>
  withRoot((root) => {
    const dir = (name, bits) => {
      const path = join(root, name);
      mkdirSync(path);
      return mode(path, bits);
    };
    for (const bits of [0o700, 0o750, 0o755, 0o500])
      assert.equal(
        assertPrivateDirectory(dir(`ok-${bits}`, bits), { what: 'report' }),
        join(root, `ok-${bits}`),
      );
    for (const bits of [0o770, 0o720, 0o707, 0o702, 0o777, 0o1777, 0o1770, 0o2775])
      directoryRefused(() => assertPrivateDirectory(dir(`bad-${bits}`, bits), { what: 'report' }));
    // Not a directory, missing, or a link to a directory somebody else can write.
    const file = join(root, 'file');
    writeFileSync(file, 'x');
    directoryRefused(() => assertPrivateDirectory(file, { what: 'report' }));
    directoryRefused(() => assertPrivateDirectory(join(root, 'absent'), { what: 'report' }));
    const shared = dir('shared', 0o777);
    symlinkSync(shared, join(root, 'link-to-shared'));
    directoryRefused(() =>
      assertPrivateDirectory(join(root, 'link-to-shared'), { what: 'report' }),
    );
    // A link to a private directory is resolved: the caller works on the real name.
    const own = dir('own', 0o700);
    symlinkSync(own, join(root, 'link-to-own'));
    assert.equal(assertPrivateDirectory(join(root, 'link-to-own'), { what: 'report' }), own);
    // Another owner is refused (root excepted: it can do anything anyway);
    directoryRefused(() => assertPrivateDirectory(own, { what: 'report', uid: uid + 1 }));
    assert.equal(assertPrivateDirectory('/', { what: 'report', uid: uid + 1 }), '/');
  }));

test('resolveTemporaryRoot: a private root is used as is; a sticky shared one gets a private subdirectory; anything else is refused', () =>
  withRoot((root) => {
    const fresh = (name, bits) => {
      const path = join(root, name);
      mkdirSync(path);
      return mode(path, bits);
    };
    const privateRoot = fresh('private', 0o700);
    assert.equal(resolveTemporaryRoot({ tmpRoot: privateRoot, create: true }), privateRoot);
    assert.deepEqual(readdirSync(privateRoot), [], 'nothing was created in a private root');

    const sticky = fresh('sticky', 0o1777);
    const own = join(sticky, `rasta-restore-drill-root-${uid}`);
    // A recovery starts nothing: with no subdirectory yet it only says where it would be.
    assert.equal(resolveTemporaryRoot({ tmpRoot: sticky }), own);
    assert.deepEqual(readdirSync(sticky), []);
    assert.equal(resolveTemporaryRoot({ tmpRoot: sticky, create: true }), own);
    assert.equal(statSync(own).mode & 0o777, 0o700);
    assert.equal(resolveTemporaryRoot({ tmpRoot: sticky, create: true }), own, 'reused');
    assert.equal(resolveTemporaryRoot({ tmpRoot: sticky }), own);

    // Somebody made the name first (wrong mode, a link, not a directory): refused, never adopted.
    for (const [name, make] of [
      ['wide', (path) => mode(path, 0o755)],
      ['link', (path) => symlinkSync(join(root, 'private'), path)],
      ['file', (path) => writeFileSync(path, 'x')],
    ]) {
      const other = fresh(`sticky-${name}`, 0o1777);
      const path = join(other, `rasta-restore-drill-root-${uid}`);
      if (name === 'wide') mkdirSync(path);
      make(path);
      for (const create of [true, false])
        directoryRefused(() => resolveTemporaryRoot({ tmpRoot: other, create }));
    }
    // Shared but not sticky (others could rename our subdirectory away), unwritable owner, missing.
    directoryRefused(() => resolveTemporaryRoot({ tmpRoot: fresh('open', 0o777), create: true }));
    directoryRefused(() => resolveTemporaryRoot({ tmpRoot: fresh('group', 0o770), create: true }));
    directoryRefused(() =>
      resolveTemporaryRoot({ tmpRoot: privateRoot, uid: uid + 1, create: true }),
    );
    directoryRefused(() => resolveTemporaryRoot({ tmpRoot: join(root, 'absent'), create: true }));
    assert.deepEqual(readdirSync(join(root, 'open')), [], 'nothing was created in a refused root');
  }));

test('a record is bound to the temporary root the caller resolved: there is no unchecked default', () =>
  withRoot((root) => {
    const record = makeRecord(root);
    refused(() => loadRecoveryRecord(record.reportPath), /no temporary root/);
    const loaded = loadRecoveryRecord(record.reportPath, { tmpRoot: root });
    assert.deepEqual(
      loaded.directoryIdentity,
      record.identity,
      'the identity of the directory proven',
    );
  }));

// --- replacement before every unlink / rm (#512 r1 F1) --------------------------------------------
/** What another actor with write access to the directory does to a path: delete it, put theirs. */
const swap = (path, text = 'theirs') => {
  tick();
  rmSync(path, { recursive: true, force: true });
  writeFileSync(path, text, { mode: 0o600 });
};
const foreign = (action, what) =>
  assert.rejects(Promise.resolve().then(action), (error) => {
    assert.ok(error instanceof ForeignArtifact, String(error));
    assert.match(error.message, what);
    assert.doesNotMatch(error.message, /\/tmp|drill-recovery/, 'a fixed phrase, no path');
    return true;
  });

test('lock: a claim replaced before release, backoff, an error exit or a stale takeover is left alone and reported', () =>
  withRoot(async (root) => {
    const report = join(root, 'report.json');
    const mineOf = (holder) => lockFiles(root).filter((name) => name !== holder);
    const path = (name) => join(root, name);

    // release()
    let lock = await acquireDrillLock(report, quick);
    const [released] = lockFiles(root);
    swap(path(released));
    await foreign(() => lock.release(), /lock file .* replaced/);
    assert.equal(readFileSync(path(released), 'utf8'), 'theirs', 'release');
    rmSync(path(released));

    // The backoff of a contender that finds a live holder.
    lock = await acquireDrillLock(report, {
      ...quick,
      owner: claim({ pid: 11 }),
      inspect: () => 'alive',
    });
    const [holder] = lockFiles(root);
    let theirs;
    await foreign(
      () =>
        acquireDrillLock(report, {
          ...quick,
          waitMilliseconds: 1000,
          owner: claim({ pid: 22 }),
          inspect: () => {
            [theirs] = mineOf(holder);
            swap(path(theirs));
            return 'alive';
          },
        }),
      /lock file .* replaced/,
    );
    assert.equal(readFileSync(path(theirs), 'utf8'), 'theirs', 'backoff');
    lock.release();
    rmSync(path(theirs));
    assert.deepEqual(lockFiles(root), []);

    // The error exit (an owner that cannot be proven) is the foreign file, not a plain refusal.
    lock = await acquireDrillLock(report, {
      ...quick,
      owner: claim({ pid: 11 }),
      inspect: () => 'alive',
    });
    const [other] = lockFiles(root);
    await foreign(
      () =>
        acquireDrillLock(report, {
          ...quick,
          owner: claim({ pid: 22 }),
          inspect: () => {
            [theirs] = mineOf(other);
            swap(path(theirs));
            return 'unknown';
          },
        }),
      /lock file .* replaced/,
    );
    assert.equal(readFileSync(path(theirs), 'utf8'), 'theirs', 'error exit');
    lock.release();
    rmSync(path(theirs));

    // A stale claim replaced between the read that proved its owner gone and the removal.
    const stale = join(root, 'report.json.lock.0123456789abcdef');
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(stale, JSON.stringify({ ...currentLockOwner(), pid: dead }), { mode: 0o600 });
    await foreign(
      () =>
        acquireDrillLock(report, {
          ...quick,
          inspect: () => {
            swap(stale);
            return 'gone';
          },
        }),
      /lock file .* replaced/,
    );
    assert.deepEqual(
      lockFiles(root),
      ['report.json.lock.0123456789abcdef'],
      'our own claim is released',
    );
    assert.equal(readFileSync(stale, 'utf8'), 'theirs', 'stale takeover');
  }));

test('lock: an unreplaced claim is still released and a claim already gone is no error', () =>
  withRoot(async (root) => {
    const report = join(root, 'report.json');
    const lock = await acquireDrillLock(report, quick);
    rmSync(join(root, lockFiles(root)[0]));
    lock.release();
    const again = await acquireDrillLock(report, quick);
    again.release();
    assert.deepEqual(lockFiles(root), []);
  }));

test('lock: release happens once; a second one (the exit hook after the explicit release) looks at nothing', () =>
  withRoot(async (root) => {
    const lock = await acquireDrillLock(join(root, 'report.json'), quick);
    const [name] = lockFiles(root);
    lock.release();
    assert.deepEqual(lockFiles(root), []);
    // Another actor now holds the claim's name: the second release neither fails nor touches it.
    writeFileSync(join(root, name), 'theirs\n');
    lock.release();
    assert.equal(readFileSync(join(root, name), 'utf8'), 'theirs\n');
  }));

test('reserving: an artifact replaced before its rollback is left alone and the refusal is foreign', () =>
  withRoot((root) => {
    const report = join(root, 'report.json');
    const journal = recoveryJournalPath(report);
    const closeThenSwap = (path) => (fd) => {
      closeSync(fd);
      swap(path);
      throw errno('EIO');
    };
    // The report's own rollback (the close reports EIO after the path was replaced).
    const pathOf = new Map();
    const tracking = (extra) => ({
      open: (path, flags, mode) => {
        const fd = openSync(path, flags, mode);
        pathOf.set(fd, path);
        return fd;
      },
      ...extra,
    });
    artifactRefused(
      () =>
        reserveRunArtifacts(
          report,
          { id: newRecoveryId() },
          { fs: tracking({ close: (fd) => closeThenSwap(pathOf.get(fd))(fd) }) },
        ),
      'foreign',
    );
    assert.equal(readFileSync(report, 'utf8'), 'theirs', 'report');
    assert.equal(existsSync(journal), false);
    rmSync(report);

    // The journal's rollback: theirs survives, our report is taken back.
    artifactRefused(
      () =>
        reserveRunArtifacts(
          report,
          { id: newRecoveryId() },
          {
            fs: tracking({
              close: (fd) =>
                pathOf.get(fd) === journal ? closeThenSwap(journal)(fd) : closeSync(fd),
            }),
          },
        ),
      'foreign',
    );
    assert.equal(readFileSync(journal, 'utf8'), 'theirs', 'journal');
    assert.equal(existsSync(report), false, 'our report is taken back');
    rmSync(journal);

    // The outer handler: the journal fails for another reason after the report was replaced.
    artifactRefused(
      () =>
        reserveRunArtifacts(
          report,
          { id: newRecoveryId() },
          {
            fs: tracking({
              write: () => {
                swap(report);
                throw errno('ENOSPC');
              },
            }),
          },
        ),
      'foreign',
    );
    assert.equal(readFileSync(report, 'utf8'), 'theirs', 'outer handler');
    assert.equal(existsSync(journal), false, 'our journal is taken back');
  }));

test('removeOwnedDirectory: a directory replaced after it was proven is never removed, at either boundary', () =>
  withRoot((root) => {
    const ownerOf = (record) => ({
      journalPath: recoveryJournalPath(record.reportPath),
      project: record.project,
      id: record.id,
      temporary: record.temporary,
      identity: record.identity,
    });
    const replace = (temporary) => {
      tick();
      rmSync(temporary, { recursive: true });
      mkdirSync(temporary, { mode: 0o700 });
      writeFileSync(join(temporary, 'theirs'), 'precious');
    };
    const survives = (record) =>
      assert.equal(readFileSync(join(record.temporary, 'theirs'), 'utf8'), 'precious');

    // Before the first checkpoint: nothing is published either.
    let record = makeRecord(root);
    replace(record.temporary);
    assert.throws(
      () => removeOwnedDirectory({ ...ownerOf(record), remove: () => assert.fail('removed') }),
      (error) => error instanceof ForeignArtifact && /replaced/.test(error.message),
    );
    survives(record);
    assert.equal(existsSync(recoveryJournalPath(record.reportPath)), false);

    // During the checkpoint publication (its rename): the check right before the removal catches it.
    record = makeRecord(root);
    let swapped = false;
    const fs = {
      renameSync: (from, to) => {
        renameSync(from, to);
        if (!swapped) replace(record.temporary);
        swapped = true;
      },
    };
    assert.throws(
      () => removeOwnedDirectory({ ...ownerOf(record), fs, remove: () => assert.fail('removed') }),
      ForeignArtifact,
    );
    assert.equal(swapped, true);
    survives(record);

    // The default removal itself, with the real rmSync, on a replaced directory.
    record = makeRecord(root);
    replace(record.temporary);
    assert.throws(() => removeOwnedDirectory(ownerOf(record)), ForeignArtifact);
    survives(record);

    // No identity, no proof: nothing is removed.
    record = makeRecord(root);
    assert.throws(
      () => removeOwnedDirectory({ ...ownerOf(record), identity: undefined }),
      ForeignArtifact,
    );
    assert.equal(existsSync(join(record.temporary, RECOVERY_MARKER)), true);

    // A symlink put in the directory's place is not the directory either.
    record = makeRecord(root);
    const target = mkdtempSync(join(root, 'target-'));
    writeFileSync(join(target, 'theirs'), 'precious');
    rmSync(record.temporary, { recursive: true });
    symlinkSync(target, record.temporary);
    assert.throws(() => removeOwnedDirectory(ownerOf(record)), ForeignArtifact);
    assert.equal(readFileSync(join(target, 'theirs'), 'utf8'), 'precious');
  }));

// --- ownership survives a retry (#512 r3 F1) --------------------------------------------------------
// The identity the run proved is persisted outside the tree (the report, and every journal write)
// and every recovery holds the directory to it: what occupies a checkpointed name never decides.
const identityEncoding = {
  dev: '2049',
  ino: '12345',
  kind: 'directory',
  birth: '1761852000123456789',
};

test('a persisted identity round-trips exactly and anything else is malformed', () => {
  const identity = identityAt(mkdtempSync(join(tmpdir(), 'drill-identity-')));
  assert.deepEqual(parseIdentity(serializeIdentity(identity)), identity);
  assert.deepEqual(parseIdentity(identityEncoding), {
    dev: 2049n,
    ino: 12345n,
    kind: 'directory',
    birth: 1761852000123456789n,
  });
  for (const bad of [
    null,
    '1',
    [],
    {},
    { ...identityEncoding, extra: '1' },
    { dev: '1', ino: '2', kind: 'directory' },
    { ...identityEncoding, kind: 'socket' },
    { ...identityEncoding, ino: 12345 },
    { ...identityEncoding, birth: '-1' },
    { ...identityEncoding, dev: '1e3' },
    { ...identityEncoding, ino: '1'.repeat(21) },
  ])
    assert.equal(parseIdentity(bad), null, JSON.stringify(bad));
});

/** Another actor puts its own object under the directory's name (the original is moved aside). */
const REPLACEMENTS = {
  'a directory with a forged marker and compose.json': (record) => {
    mkdirSync(record.temporary, { mode: 0o700 });
    writeRecoveryMarker(record.temporary, { project: record.project, id: record.id });
    writeFileSync(
      join(record.temporary, 'compose.json'),
      JSON.stringify(composeFor(record.project)),
      {
        mode: 0o600,
      },
    );
    writeFileSync(join(record.temporary, 'theirs'), 'precious');
  },
  'an empty private directory': (record) => {
    mkdirSync(record.temporary, { mode: 0o700 });
    writeFileSync(join(record.temporary, 'theirs'), 'precious');
  },
  'a regular file': (record) => writeFileSync(record.temporary, 'precious', { mode: 0o600 }),
  'a link to the original': (record) => symlinkSync(`${record.temporary}.moved`, record.temporary),
};
const replaceWith = (record, how) => {
  tick();
  renameSync(record.temporary, `${record.temporary}.moved`);
  REPLACEMENTS[how](record);
};
const untouched = (record, how) => {
  if (how.includes('file')) assert.equal(readFileSync(record.temporary, 'utf8'), 'precious');
  else if (!how.includes('link'))
    assert.equal(readFileSync(join(record.temporary, 'theirs'), 'utf8'), 'precious');
  assert.equal(existsSync(`${record.temporary}.moved`), true, 'the original was not touched');
};

test('a replacement under the name is never adopted, whatever an earlier invocation left (no checkpoint, "recovered", "removed", group-only journal)', () =>
  withRoot((root) => {
    const states = {
      'the run reserved only a journal': () => {},
      'a journal of recovery children, no checkpoint': (record) =>
        checkpointFor(record, undefined, [4242]),
      'the "recovered" checkpoint': (record) => checkpointFor(record, 'recovered'),
      'the "recovered" checkpoint, report of an older run (journal-only identity)': (record) =>
        checkpointFor(record, 'recovered'),
      'the "removed" checkpoint': (record) => checkpointFor(record, 'removed'),
    };
    for (const [state, prepare] of Object.entries(states)) {
      for (const how of Object.keys(REPLACEMENTS)) {
        const record = makeRecord(root, { legacy: state.includes('older run') });
        prepare(record);
        const path = recoveryJournalPath(record.reportPath);
        const before = existsSync(path) ? readFileSync(path) : null;
        // The directory was cleaned and removed, or half removed: either way it was ours once.
        if (state.includes('"recovered"')) rmSync(join(record.temporary, RECOVERY_MARKER));
        replaceWith(record, how);
        const label = `${state}: ${how}`;
        assert.throws(
          () => loadRecoveryRecord(record.reportPath, { tmpRoot: root }),
          (error) =>
            error instanceof ForeignArtifact && /replaced by another actor/.test(error.message),
          label,
        );
        untouched(record, how);
        assert.deepEqual(
          existsSync(path) ? readFileSync(path) : null,
          before,
          `${label}: no write`,
        );
      }
    }
  }));

test('a directory that is gone is no foreign object; the same name re-made later is', () =>
  withRoot((root) => {
    const record = makeRecord(root, { report: { cleanup: { passed: true } } });
    checkpointFor(record, 'removed');
    rmSync(record.temporary, { recursive: true });
    assert.equal(loadRecoveryRecord(record.reportPath, { tmpRoot: root }).directoryPresent, false);
    tick();
    mkdirSync(record.temporary, { mode: 0o700 });
    assert.throws(() => loadRecoveryRecord(record.reportPath, { tmpRoot: root }), ForeignArtifact);
  }));

test('the very object the run proved is accepted on every retry, and carries its identity on', () =>
  withRoot((root) => {
    const record = makeRecord(root);
    const load = () => loadRecoveryRecord(record.reportPath, { tmpRoot: root });
    assert.deepEqual(load().identity, record.identity);
    assert.equal(load().identityAdopted, false);
    checkpointFor(record, 'recovered');
    rmSync(join(record.temporary, RECOVERY_MARKER));
    const loaded = load();
    assert.deepEqual([loaded.checkpoint, loaded.identity], ['recovered', record.identity]);
    assert.deepEqual(loaded.directoryIdentity, record.identity);
  }));

test('without a durable identity only the marker can speak for a directory, and never for a checkpoint', () =>
  withRoot((root) => {
    // An older run's report: no identity anywhere. The marker proves project, id and name.
    let record = makeRecord(root, { legacy: true });
    let loaded = loadRecoveryRecord(record.reportPath, { tmpRoot: root });
    assert.deepEqual([loaded.identity, loaded.identityAdopted], [record.identity, true]);
    // The marker gone: nothing proves the directory ours (and a checkpoint cannot, either).
    rmSync(join(record.temporary, RECOVERY_MARKER));
    refused(() => loadRecoveryRecord(record.reportPath, { tmpRoot: root }), /directory marker/);
    checkpointFor(record, 'recovered', [], null);
    refused(
      () => loadRecoveryRecord(record.reportPath, { tmpRoot: root }),
      /no directory identity to hold the directory to/,
    );
    // A checkpoint with the directory gone asks nothing of it.
    rmSync(record.temporary, { recursive: true });
    assert.equal(loadRecoveryRecord(record.reportPath, { tmpRoot: root }).directoryPresent, false);
    // The journal alone may carry the identity (the report predates it).
    record = makeRecord(root, { legacy: true });
    checkpointFor(record, 'recovered');
    rmSync(join(record.temporary, RECOVERY_MARKER));
    loaded = loadRecoveryRecord(record.reportPath, { tmpRoot: root });
    assert.deepEqual([loaded.identity, loaded.identityAdopted], [record.identity, false]);
  }));

test('two copies of the identity that disagree, or one that is malformed, prove nothing', () =>
  withRoot((root) => {
    const record = makeRecord(root);
    const load = () => loadRecoveryRecord(record.reportPath, { tmpRoot: root });
    const other = makeRecord(root);
    checkpointFor(record, undefined, [], other.identity);
    refused(load, /recovery journal does not match/);
    rmSync(recoveryJournalPath(record.reportPath));
    for (const bad of [
      'x',
      { ...identityEncoding, extra: 1 },
      { ...identityEncoding, ino: 5 },
      { dev: '1', ino: '2' },
    ]) {
      rewrite(record, { temporaryIdentity: bad });
      refused(load, /malformed directory identity/);
    }
    rewrite(record, {});
    const path = recoveryJournalPath(record.reportPath);
    checkpointFor(record, 'recovered');
    const good = JSON.parse(readFileSync(path, 'utf8'));
    for (const bad of ['x', { ...identityEncoding, extra: 1 }, { dev: '1', ino: '2' }]) {
      writeFileSync(path, JSON.stringify({ ...good, identity: bad }), { mode: 0o600 });
      refused(load, /recovery journal does not match/);
    }
  }));

test('every journal write carries the identity it was given, checkpoints included', () =>
  withRoot((root) => {
    const record = makeRecord(root);
    const path = recoveryJournalPath(record.reportPath);
    const identityOnDisk = () => JSON.parse(readFileSync(path, 'utf8')).identity;
    const expected = serializeIdentity(record.identity);
    checkpointFor(record, undefined, [4242]);
    assert.deepEqual(identityOnDisk(), expected);
    const seen = [];
    removeOwnedDirectory({
      journalPath: path,
      project: record.project,
      id: record.id,
      temporary: record.temporary,
      identity: record.identity,
      remove: () => seen.push(identityOnDisk()),
    });
    assert.deepEqual(seen, [expected], 'the "recovered" write');
    assert.deepEqual(identityOnDisk(), expected, 'the "removed" write');
  }));
