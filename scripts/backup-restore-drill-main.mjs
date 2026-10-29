// The drill CLI proper, loaded by backup-restore-drill.mjs (the guarded entry). Imports needed
// only by a normal run (yaml, the URL reader, the service registry) are loaded where they are
// used, so `--cleanup-from` needs nothing but node: built-ins and the two drill modules.
// Stated residual (accepted by the project manager; details in backup-restore-drill-recovery.mjs):
// a SIGKILL between a child's spawn() and the synchronous write that names its process group (a
// report write for the run, a journal write for recovery; milliseconds) can leave that one group
// unrecorded. Reserving before the spawn is impossible: the group id is the child's pid.
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import {
  discoverSchemaServices,
  discoverEnvServices,
  checkEnvServiceCoverage,
  SCHEMA_DUMP_FLAGS,
  DUMP_RESTRICT_KEY,
  dumpSchema,
  dumpPath,
  collectSchemaReference,
  schemaDiffSummary,
  checkServiceCoverage,
  OBJECT_STATE_SQL,
  SEQUENCES_SQL,
  compareSnapshots,
  writeReportAtomically,
  createProcessRunner,
  finalizeCleanup,
  verifyResourceKinds,
  drillPassed,
  checkDatabaseCoverage,
  summarizeTables,
  DATABASE_STATE_SQL,
  DATABASES_SQL,
  EXCLUDED_DATABASES,
  ledgerPassed,
  INVENTORY_SQL,
  MIGRATIONS_SQL,
  LEDGER_SQL,
  FIXTURE_SQL,
} from './backup-restore-drill-lib.mjs';
import {
  LOCK_WAIT_MILLISECONDS,
  LockRefused,
  RECOVERY_ENV,
  RecoveryRefused,
  acquireDrillLock,
  assertOwnedCompose,
  loadRecoveryRecord,
  newRecoveryId,
  recoverProcessGroups,
  recoveryJournalPath,
  writeRecoveryJournal,
  writeRecoveryMarker,
} from './backup-restore-drill-recovery.mjs';

const ROOT = process.env.RASTA_DRILL_ROOT
  ? resolve(process.env.RASTA_DRILL_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
// --cleanup-from recovers what an earlier --report run recorded (a scheduled CI job's last
// step, after a cancelled or timed-out run). It starts nothing, writes no report and refuses
// (exit 2) any record it cannot prove: see backup-restore-drill-recovery.mjs.
const cleanupOnly = args.length === 2 && args[0] === '--cleanup-from';
if (!cleanupOnly && (args.length !== 2 || args[0] !== '--report')) {
  console.error(
    'Usage: scripts/backup-restore-drill --report /path/to/new-report.json\n' +
      '       scripts/backup-restore-drill --cleanup-from /path/to/that-report.json',
  );
  process.exit(2);
}
const reportPath = resolve(args[1]);
// One owner at a time: a run and a recovery of the same report hold this lock for their whole
// lifetime (released when the process exits; a killed owner leaves a claim that a later one takes
// over only after proving the owner gone). RASTA_DRILL_LOCK_WAIT_MS bounds the wait for a live
// owner (milliseconds; the tests shorten it).
const lockWait = /^\d{1,7}$/.test(process.env.RASTA_DRILL_LOCK_WAIT_MS ?? '')
  ? Number(process.env.RASTA_DRILL_LOCK_WAIT_MS)
  : LOCK_WAIT_MILLISECONDS;
let drillLock;
try {
  drillLock = await acquireDrillLock(reportPath, { waitMilliseconds: lockWait });
} catch (error) {
  // Fixed phrases only: never the path, a pid or anything read from a claim.
  console.error(
    `[backup-restore-drill] ${error instanceof LockRefused ? error.message : 'the lock next to the report could not be taken; nothing was done'}`,
  );
  process.exit(2);
}
process.on('exit', () => drillLock.release());
// Exclusive creation avoids overwriting an operator's file (including through a symlink).
// Later writes replace it atomically through a sibling file (see writeReportAtomically).
if (!cleanupOnly) {
  try {
    closeSync(openSync(reportPath, 'wx', 0o600));
  } catch {
    // Not the path, nor the error that quotes it (#385 r6).
    console.error(
      'the --report file cannot be created (it must not exist yet); its path is not repeated',
    );
    process.exit(2);
  }
}
let temporary;
let project;
let composeFile;
let services;
// Only explicit local Docker endpoint/context; HOME is retained for pnpm, not daemon selection.
// Every child carries the run's recovery id, so a process group the report names can later be
// proven to be this run's before anything signals it (see recoverProcessGroups).
const recoveryId = cleanupOnly ? undefined : newRecoveryId();
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  // pnpm keeps its store under PNPM_HOME when set. The install that built node_modules chose a
  // store with it; without it here, `pnpm exec` finds a different store, wants to purge
  // node_modules and aborts for lack of a TTY (the GitHub runner sets it, a laptop does not).
  ...(process.env.PNPM_HOME ? { PNPM_HOME: process.env.PNPM_HOME } : {}),
  ...(recoveryId ? { [RECOVERY_ENV]: recoveryId } : {}),
  DOCKER_CONTEXT: 'default',
  DOCKER_HOST: 'unix:///var/run/docker.sock',
  LANG: 'C.UTF-8',
  NODE_ENV: 'development',
  RASTA_ALLOW_DEMO_SEED: 'true',
};
let stage = 'preflight';
let interrupted = false;
let cleaning = false;
process.stderr.on('error', () => {});
let composeReady = false;
// Cleanup ownership serializes first: a torn or partial rewrite still names what to remove.
const report = {
  project: undefined,
  temporary: undefined,
  recoveryId: undefined,
  version: 5,
  signals: [],
  startedAt: new Date().toISOString(),
  passed: false,
  fixture: 'existing demo seeds plus synthetic 9007199254740993 IRR journal and wallet',
  databases: [],
  cleanup: { passed: false },
};

// Persist cleanup ownership before any child can allocate resources (including SIGKILL).
// A failure keeps the previous complete report. Only `durable` writes fsync the directory:
// the others protect against the process being killed, not against power loss.
// Every report but the final one says `passed: false`: an unfinished run has not passed.
function writeReport({ durable = false, final = false } = {}) {
  // Recovery never rewrites the record (the original run's claim). What it starts is recorded in
  // its own journal instead, right after each spawn (the runner's persist hook).
  if (cleanupOnly) {
    writeJournal();
    return;
  }
  const synced = writeReportAtomically(reportPath, final ? report : { ...report, passed: false }, {
    durable,
  });
  if (durable && !synced)
    process.stderr.write(
      '[backup-restore-drill] the report directory could not be synced; the report is written but power-loss durability is not confirmed\n',
    );
}

// Recovery's own journal (see writeRecoveryJournal), next to the report. `journalOwner` is set
// once the record is proven, whether or not its directory is still there; `carried` are groups an
// earlier recovery (or the record) left that could not be settled and stay owned until a later
// recovery sees them gone. A write that fails is STICKY (`publicationFailed`): nothing that
// happens afterwards makes this invocation a success.
let journalOwner;
let carried = [];
let publicationFailed = false;
function writeJournal(extra = {}) {
  if (!journalOwner) return;
  const groups = [
    ...carried,
    ...(report.processGroups ?? []),
    ...(report.orphanProcessGroups ?? []),
    ...(report.unconfirmedProcessGroups ?? []).map((entry) => entry.pgid),
  ];
  try {
    writeRecoveryJournal(recoveryJournalPath(reportPath), { ...journalOwner, groups, ...extra });
  } catch (error) {
    publicationFailed = true;
    throw error;
  }
}

// The one process lifecycle boundary (createProcessRunner): every child leads its own group,
// whose id is written to the report before the child is awaited, so a SIGKILL of the drill
// leaves the operator the groups to stop. A group stays owned until it is confirmed gone.
// A report write that fails is recorded and makes the final result fail (see finally below).
const runner = createProcessRunner({
  report,
  persist: () => writeReport(),
  persistFailed: (stageName) => {
    (report.reportWriteFailures ??= []).push({ stage: stageName ?? stage });
    process.stderr.write(
      cleanupOnly
        ? '[backup-restore-drill] a journal write failed; an interruption now could leave a child unrecorded\n'
        : '[backup-restore-drill] a report write failed; the run cannot be reported as passed\n',
    );
  },
  isInterrupted: () => interrupted,
  currentStage: () => stage,
  cwd: ROOT,
  env,
});
const run = runner.run;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    interrupted = true;
    report.signals.push({ signal, duringCleanup: cleaning });
    if (!cleaning) runner.stopActive();
    else {
      // Cleanup commands are not killed, but a group that survived an earlier kill is retried.
      runner.killOrphans();
      process.stderr.write(`[backup-restore-drill] cleanup continues after ${signal}\n`);
    }
  });
}

const compose = (argv, options) =>
  run('docker', ['compose', '--project-name', project, '--file', composeFile, ...argv], options);
const psql = (container, database, input, options = {}) =>
  run(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'rasta',
      '-d',
      database,
    ],
    { input, ...options },
  );

let dumpVersion;
let schemaDumpFlags;
async function collectSchemaDump(container, database, label, options) {
  return dumpSchema(
    database,
    label,
    async () => {
      const started = performance.now();
      const version = await run('docker', ['exec', container, 'pg_dump', '--version']);
      if (dumpVersion && version !== dumpVersion)
        throw new Error('Schema dump binary version mismatch');
      if (!dumpVersion) {
        dumpVersion = version;
        const help = await run('docker', ['exec', container, 'pg_dump', '--help']);
        schemaDumpFlags = [
          ...SCHEMA_DUMP_FLAGS,
          ...(help.includes('--restrict-key') ? [`--restrict-key=${DUMP_RESTRICT_KEY}`] : []),
        ];
      }
      const raw = await run(
        'docker',
        ['exec', container, 'pg_dump', ...schemaDumpFlags, '-U', 'rasta', '-d', database],
        { raw: true, privateOutput: true, database, timeout: 60_000 },
      );
      const path = join(temporary, `${database}-${label}.schema.sql`);
      writeFileSync(path, raw, { mode: 0o600 });
      return { path, raw, version, milliseconds: Math.round(performance.now() - started) };
    },
    options,
  );
}

async function collectReference(container, database, sourceDump) {
  const suffix = project.slice('restore-drill-'.length);
  report.scratchDatabases = [`drill_ref_${suffix}`, `drill_fixed_${suffix}`];
  return collectSchemaReference({
    database,
    suffix,
    sourceDump,
    dump: (name, label, options) => collectSchemaDump(container, name, label, options),
    create: (name) =>
      psql(container, 'postgres', `CREATE DATABASE "${name}" TEMPLATE template0;`, {
        privateOutput: true,
        database: name,
      }),
    restore: async (name, input) => {
      const fd = openSync(dumpPath(input), 'r');
      try {
        await run(
          'docker',
          [
            'exec',
            '-i',
            container,
            'psql',
            '-X',
            '-q',
            '-v',
            'ON_ERROR_STOP=1',
            '-U',
            'rasta',
            '-d',
            name,
          ],
          { inputFd: fd, privateOutput: true, database: name, timeout: 60_000 },
        );
      } finally {
        closeSync(fd);
      }
    },
    drop: (name) =>
      psql(container, 'postgres', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`, {
        privateOutput: true,
        database: name,
        stage: 'scratch drop',
      }),
    shouldDrop: () => !interrupted,
    scratchDropFailed: (name, error) => {
      (report.scratchDropFailed ??= []).push(
        error.privateFailure ?? {
          stage: 'scratch drop',
          database: name,
          exitCode: null,
        },
      );
    },
  });
}

async function snapshot(container, service) {
  const database = `rasta_${service}`;
  const { evidence: schemaDump } = await collectSchemaDump(
    container,
    database,
    container.endsWith('-source') ? 'source' : 'restored',
  );
  const inventory = await psql(container, database, INVENTORY_SQL);
  const tables = Object.fromEntries(
    inventory.split('\n').map((line) => {
      const { name, ...table } = JSON.parse(line);
      return [name, table];
    }),
  );
  const databaseState = JSON.parse(await psql(container, database, DATABASE_STATE_SQL));
  const objectState = JSON.parse(await psql(container, database, OBJECT_STATE_SQL));
  const sequenceRows = await psql(container, database, SEQUENCES_SQL);
  objectState.sequences = sequenceRows
    ? sequenceRows.split('\n').map((line) => JSON.parse(line))
    : [];
  const schema = service === 'audit' ? 'audit' : 'public';
  const migrations = JSON.parse(await psql(container, database, MIGRATIONS_SQL(schema)));
  return {
    schemaDump,
    tables,
    migrations,
    databaseState,
    objectState,
    summary: summarizeTables(tables),
  };
}

function progress(value) {
  stage = value;
  process.stderr.write(`[backup-restore-drill] ${stage}\n`);
}

/**
 * The one teardown, for the end of a run and for recovery: Compose is given its definition only
 * after assertOwnedCompose has proven the file is this project's; then every resource kind is
 * checked by this project's label (never another project's). With no definition left, recovery
 * still checks the labels.
 */
async function ownedTeardown() {
  if (!composeReady && !cleanupOnly) return {};
  if (composeReady) {
    assertOwnedCompose(composeFile, project);
    await compose(['down', '--volumes', '--timeout', '15'], { cleanup: true, timeout: 60_000 });
  }
  // Confirm no owned resources survived (never enumerate/remove another project's resources).
  return verifyResourceKinds(['container', 'volume', 'network'], (kind) =>
    run(
      'docker',
      [
        kind,
        'ls',
        ...(kind === 'container' ? ['-a'] : []),
        '--quiet',
        '--filter',
        `label=com.docker.compose.project=${project}`,
      ],
      { cleanup: true, timeout: 15_000 },
    ),
  );
}

/**
 * Exit status for --cleanup-from: 0 nothing owned is left, 1 something is (or could not be
 * checked or proven ours, or a journal write failed), 2 the record is refused. Everything started
 * here has settled and been reaped (finalizeCleanup's barriers) before the status is returned.
 * The lock (taken at startup) is held throughout. Order:
 *  1. the record and the journal are proven (loadRecoveryRecord); a journal checkpoint from an
 *     earlier recovery finishes (or confirms) the removal without asking Docker anything;
 *  2. every group either names (an earlier recovery's children first, then the run's) is
 *     inspected and, if PROVEN ours, reaped; an UNKNOWN group is never signalled and fails the run;
 *  3. finalizeCleanup: compose down + the three label checks, each child recorded in the journal
 *     right after its spawn and carrying the run's id (also when the directory is already gone);
 *  4. only when everything is gone AND no journal write ever failed, the "recovered" checkpoint is
 *     written (durably), then the directory is removed, then the "removed" checkpoint is written.
 */
async function recoverRecorded() {
  let record;
  try {
    record = loadRecoveryRecord(reportPath);
  } catch (error) {
    // A fixed phrase: never the record, a path or a name taken from it.
    console.error(
      `[backup-restore-drill] ${error instanceof RecoveryRefused ? error.message : 'recovery refused: the record could not be checked'}`,
    );
    return 2;
  }
  project = record.project;
  temporary = record.temporary;
  journalOwner = { temporary, project, id: record.id };
  if (record.checkpoint) return finishFromCheckpoint(record);
  composeFile = record.composeFile ?? undefined;
  composeReady = record.composeFile !== null;
  // Every child of this recovery carries the run's id, so a later recovery can prove its group.
  env[RECOVERY_ENV] = record.id;
  cleaning = true;
  progress('cleanup owned containers, networks and volumes');
  let failed = false;
  let groups = { unknown: [], orphan: [] };
  try {
    groups = await recoverProcessGroups(
      [...new Set([...record.journalGroups, ...record.processGroups])],
      record.id,
    );
  } catch {
    failed = true;
  }
  carried = [...groups.unknown, ...groups.orphan];
  const verdict = await finalizeCleanup({ runner, report, teardown: ownedTeardown });
  let removed = !failed && verdict.passed && !groups.unknown.length && !groups.orphan.length;
  if (removed && !publicationFailed) {
    try {
      writeJournal({ groups: [], checkpoint: 'recovered' });
      if (record.directoryPresent) rmSync(temporary, { recursive: true, force: true });
      writeJournal({ groups: [], checkpoint: 'removed' });
    } catch {
      removed = false;
    }
  }
  if (removed && !publicationFailed) return 0;
  // Kinds, counts and group ids only: no resource ids, names or paths.
  console.error(
    `[backup-restore-drill] owned resources could not all be removed (leftover: ${verdict.leftovers.join(',') || 'none'}; unverified: ${verdict.unverified.join(',') || 'none'}; still running: ${groups.orphan.length + (report.orphanProcessGroups?.length ?? 0)})`,
  );
  for (const pgid of groups.unknown.slice(0, 20))
    console.error(
      `[backup-restore-drill] process group ${pgid} is not proven to be ours (or could not be inspected completely) and was not signalled`,
    );
  if (groups.unknown.length > 20)
    console.error(`[backup-restore-drill] ${groups.unknown.length - 20} more such groups`);
  if (publicationFailed)
    console.error(
      '[backup-restore-drill] a journal write failed during this recovery; success is not reported and nothing more was removed',
    );
  return 1;
}

/**
 * An earlier recovery's journal says every owned resource and process was gone ('recovered') and
 * may say the directory was removed too ('removed'). Finish what is left of the removal, record
 * it, and succeed; ask Docker nothing.
 */
function finishFromCheckpoint(record) {
  if (record.checkpoint === 'removed') return 0;
  try {
    if (record.directoryPresent) rmSync(temporary, { recursive: true, force: true });
    writeJournal({ groups: [], checkpoint: 'removed' });
  } catch {
    console.error(
      '[backup-restore-drill] the removal an earlier recovery started could not be finished',
    );
    return 1;
  }
  return 0;
}

const failedCleanup = ({ leftovers = [], unverified = [] } = {}) => ({
  passed: false,
  project,
  temporary,
  // Resource kinds only (no ids): what still exists, and what could not be checked.
  ...(leftovers.length && { leftovers }),
  ...(unverified.length && { unverified }),
  ...(report.orphanProcessGroups?.length && { orphanProcessGroups: report.orphanProcessGroups }),
});

// Recovery's output goes to the CI job log, unlike a run's (private files): an unexpected
// failure there is one fixed line, never a stack trace with source paths.
if (cleanupOnly)
  process.exit(
    await recoverRecorded().catch(() => {
      console.error('[backup-restore-drill] recovery failed unexpectedly; nothing was reported');
      return 1;
    }),
  );

try {
  // Only a normal run needs these (a failure to load one is a failed run with a private report).
  const { default: YAML } = await import('yaml');
  const { readUrl } = await import('../packages/config/src/url-reader.js');
  const { servicesFromLibrary } = await import('./infra-preflight-lib.mjs');
  temporary = mkdtempSync(join(tmpdir(), 'rasta-restore-drill-'));
  project = `restore-drill-${randomBytes(8).toString('hex')}`;
  // The directory's own marker comes first, so a report that names it can be checked against it.
  writeRecoveryMarker(temporary, { project, id: recoveryId });
  report.project = project;
  report.temporary = temporary;
  report.recoveryId = recoveryId;
  writeReport({ durable: true });
  composeFile = join(temporary, 'compose.json');
  services = servicesFromLibrary(
    readFileSync(join(ROOT, 'infrastructure/docker/postgres/lib/role-passwords.bash'), 'utf8'),
  );
  report.schemaServices = discoverSchemaServices(ROOT);
  checkServiceCoverage(report.schemaServices, services);
  report.envServices = discoverEnvServices(readFileSync(join(ROOT, '.env.example'), 'utf8'));
  checkEnvServiceCoverage(report.schemaServices, report.envServices);
  for (const path of [
    join(ROOT, '.env'),
    join(ROOT, '.env.migrator'),
    ...services.flatMap((s) => [
      join(ROOT, 'services', `${s}-service`, '.env'),
      join(ROOT, 'services', `${s}-service`, 'prisma', '.env'),
    ]),
  ]) {
    if (existsSync(path)) throw new Error('Use a clean worktree without local env files');
  }
  // Extract just postgres from the existing stack. Resolve only committed development defaults;
  // never evaluate the whole stack or load its optional .env.migrator/Kafka credentials.
  const original = YAML.parse(readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8')).services
    .postgres;
  const defaults = (value) => String(value).replace(/\$\{[^}:]+:-([^}]*)\}/g, '$1');
  const definition = {
    image: original.image,
    restart: 'no',
    mem_limit: '512m',
    cpus: 1,
    environment: Object.fromEntries(
      Object.entries(original.environment).map(([k, v]) => [k, defaults(v)]),
    ),
    env_file: [join(ROOT, '.env.migrator.example')],
    ports: ['127.0.0.1::5432'],
    volumes: [
      'data:/var/lib/postgresql/data',
      `${join(ROOT, 'infrastructure/docker/postgres')}:/docker-entrypoint-initdb.d:ro`,
    ],
    healthcheck: {
      ...original.healthcheck,
      // The entrypoint's temporary bootstrap server accepts Unix sockets only.
      // Waiting for TCP prevents a false healthy result half way through init.
      test: ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U rasta -d postgres'],
      interval: '2s',
      // All 16 databases, role splits and PostGIS extensions initialize serially.
      start_period: '180s',
    },
  };
  if (JSON.stringify(definition).includes('${')) throw new Error('Unresolved Compose defaults');
  writeFileSync(
    composeFile,
    JSON.stringify({
      services: {
        source: { ...definition, container_name: `${project}-source` },
        restored: {
          ...definition,
          container_name: `${project}-restored`,
          volumes: ['restored:/var/lib/postgresql/data', definition.volumes[1]],
        },
      },
      volumes: { data: {}, restored: {} },
    }),
    { mode: 0o600 },
  );
  composeReady = true;
  progress('build seed dependencies serially');
  await run('pnpm', [
    'exec',
    'turbo',
    'run',
    'build',
    '--filter=@rasta/nest-common...',
    '--concurrency=1',
  ]);
  progress('start disposable source PostgreSQL');
  await compose(['up', '-d', '--wait', '--wait-timeout', '300', 'source']);
  const source = `${project}-source`;
  const restored = `${project}-restored`;
  const port = (await compose(['port', 'source', '5432'])).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error('PostgreSQL is not bound to loopback');
  const examples = {
    ...parseEnv(readFileSync(join(ROOT, '.env.example'), 'utf8')),
    ...parseEnv(readFileSync(join(ROOT, '.env.migrator.example'), 'utf8')),
  };
  // The only URLs passed to migration/seed children are rewritten published examples.
  const dbEnv = { ...env };
  for (const [key, value] of Object.entries(examples)) {
    if (!key.startsWith('DATABASE_URL_')) continue;
    const url = readUrl(value, { refusal: `${key} in the published examples is not a URL` });
    url.hostname = '127.0.0.1';
    url.port = port;
    dbEnv[key] = url.toString();
  }
  for (const service of services) {
    const cwd = join(ROOT, 'services', `${service}-service`);
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    progress(`migrate ${service}`);
    await run('pnpm', ['run', 'db:migrate'], {
      cwd,
      env: dbEnv,
      privateOutput: true,
      database: `rasta_${service}`,
    });
    if (pkg.scripts['db:seed']) {
      progress(`generate and demo seed ${service}`);
      await run('pnpm', ['exec', 'prisma', 'generate'], { cwd, env: dbEnv });
      // Keep migrator credentials out of the runtime seed's environment.
      const seedEnv = Object.fromEntries(
        Object.entries(dbEnv).filter(([key]) => !key.endsWith('_MIGRATOR')),
      );
      await run('pnpm', ['run', 'db:seed'], { cwd, env: seedEnv });
    }
  }
  progress('install synthetic postings fixture');
  await psql(source, 'rasta_economic', FIXTURE_SQL);
  report.sourceDatabases = JSON.parse(await psql(source, 'postgres', DATABASES_SQL));
  report.excludedDatabases = EXCLUDED_DATABASES;
  checkDatabaseCoverage(
    report.sourceDatabases,
    services.map((s) => `rasta_${s}`),
  );
  report.sourceLedger = JSON.parse(await psql(source, 'rasta_economic', LEDGER_SQL));
  if (!ledgerPassed(report.sourceLedger)) throw new Error('Source ledger invariant failed');
  // No running services or writers: all snapshots and dumps see this quiescent fixture.
  for (const service of services) {
    progress(`dump rasta_${service}`);
    const before = await snapshot(source, service);
    before.reference = await collectReference(source, `rasta_${service}`, before.schemaDump);
    process.stderr.write(
      `[backup-restore-drill] rasta_${service}: CHECK lines different ${before.reference.checkLinesDifferent}; reference + fixed point ${before.reference.milliseconds} ms\n`,
    );
    const fd = openSync(join(temporary, `${service}.dump`), 'wx', 0o600);
    try {
      await run(
        'docker',
        ['exec', source, 'pg_dump', '-U', 'rasta', '-Fc', '-d', `rasta_${service}`],
        { outputFd: fd, privateOutput: true, database: `rasta_${service}` },
      );
    } finally {
      closeSync(fd);
    }
    report.databases.push({ database: `rasta_${service}`, before });
  }
  // One PostgreSQL server at a time. Keep only the source's owned volume until final cleanup.
  await compose(['stop', '--timeout', '15', 'source']);
  progress('start fresh restore PostgreSQL');
  await compose(['up', '-d', '--wait', '--wait-timeout', '300', 'restored']);
  for (const [index, service] of services.entries()) {
    progress(`restore and compare rasta_${service}`);
    // Bootstrap supplies roles; --create restores database owner, ACL and database/role settings.
    // CREATE DATABASE cannot run inside --single-transaction. Every restore error still fails.
    await psql(restored, 'postgres', `DROP DATABASE "rasta_${service}";`);
    const fd = openSync(join(temporary, `${service}.dump`), 'r');
    try {
      await run(
        'docker',
        [
          'exec',
          '-i',
          restored,
          'pg_restore',
          '-U',
          'rasta',
          '--exit-on-error',
          '--create',
          '-d',
          'postgres',
        ],
        { inputFd: fd, privateOutput: true, database: `rasta_${service}` },
      );
    } finally {
      closeSync(fd);
    }
    const after = await snapshot(restored, service);
    const result = compareSnapshots(report.databases[index].before, after);
    if (!result.schemaDumpEqual) {
      const summary = schemaDiffSummary(
        report.databases[index].before.reference.reference,
        after.schemaDump,
      );
      report.databases[index].schemaDiff = summary;
      process.stderr.write(
        `[backup-restore-drill] ${after.database ?? `rasta_${service}`} ${summary.identity}: schema differs at byte ${summary.firstDifferentByte} (${summary.sourceBytes}/${summary.restoredBytes} bytes)\n`,
      );
    }
    Object.assign(report.databases[index], { after, ...result });
  }
  report.restoredLedger = JSON.parse(await psql(restored, 'rasta_economic', LEDGER_SQL));
  report.passed = drillPassed(
    report.databases,
    services.length,
    report.sourceLedger,
    report.restoredLedger,
  );
} catch (error) {
  // Command failures retain bounded diagnostics with database URLs redacted.
  report.error = error.privateFailure ?? { stage, message: error.message };
  report.passed = false;
} finally {
  cleaning = true;
  progress('cleanup owned containers, networks and volumes');
  // Unconditional finalization (barrier, teardown, barrier, orphan retry, verdict): a failing
  // step fails the cleanup but never skips the retry or lets the report out before every
  // command has settled.
  const verdict = await finalizeCleanup({
    runner,
    report,
    teardown: ownedTeardown,
  });
  let removed = verdict.passed;
  if (removed && temporary) {
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch {
      removed = false;
    }
  }
  if (removed) report.cleanup.passed = true;
  else {
    report.cleanup = failedCleanup(verdict);
    report.passed = false;
  }
  if (verdict.orphanRetry.retried.length) report.cleanup.orphanRetry = verdict.orphanRetry;
  report.finishedAt = new Date().toISOString();
  report.interrupted = interrupted;
  // A report write that failed at any point (cleanup included) is never forgotten.
  if (interrupted || report.reportWriteFailures?.length) report.passed = false;
  try {
    writeReport({ durable: true, final: true });
  } catch {
    // The provisional report stays: it still names the project, temporary directory and groups.
    // A complete cleanup is then reported only on stderr, never as a passing report.
    report.passed = false;
    process.stderr.write(
      '[backup-restore-drill] the final report could not be written; the previous report remains\n',
    );
  }
}
console.log(
  JSON.stringify({
    report: reportPath,
    passed: report.passed,
    databases: report.databases.length,
    tables: report.databases.reduce((total, db) => total + Object.keys(db.before.tables).length, 0),
    restoredLedger: report.restoredLedger,
    cleanup: report.cleanup,
  }),
);
process.exitCode = report.passed ? 0 : 1;
