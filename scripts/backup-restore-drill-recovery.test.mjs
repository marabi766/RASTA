import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECOVERY_ENV,
  RECOVERY_MARKER,
  RecoveryRefused,
  assertOwnedCompose,
  loadRecoveryRecord,
  newRecoveryId,
  recoverProcessGroups,
  validateComposeDefinition,
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
      refused: [300, 400, 500],
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
      { gone: [], reaped: [], refused: [], orphan: [200] },
    );
    const outcome = await recoverProcessGroups([200], id, {
      procRoot: join(root, 'no-proc-here'),
      alive: () => true,
      reap: async () => assert.fail('must not signal what it cannot list'),
    });
    assert.deepEqual(outcome.refused, [200]);
  }));
