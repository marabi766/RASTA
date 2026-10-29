import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  closeSync,
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
  RECOVERY_ENV,
  RECOVERY_MARKER,
  LockRefused,
  acquireDrillLock,
  currentLockOwner,
  inspectLockOwner,
  recoveryJournalPath,
  RecoveryRefused,
  assertOwnedCompose,
  inspectProcessGroup,
  loadRecoveryRecord,
  newRecoveryId,
  recoverProcessGroups,
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
  const report = {
    project,
    temporary,
    recoveryId: id,
    processGroups: [],
    cleanup: { passed: false },
    ...overrides.report,
  };
  writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600 });
  return { project, id, temporary, reportPath, report };
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
    const a = makeRecord(root);
    const b = makeRecord(root);
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
    const record = makeRecord(root);
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

const checkpointFor = (record, checkpoint, groups = []) =>
  writeRecoveryJournal(recoveryJournalPath(record.reportPath), {
    project: record.project,
    id: record.id,
    temporary: record.temporary,
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
