#!/usr/bin/env node
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
import YAML from 'yaml';
import { readUrl } from '../packages/config/src/url-reader.js';
import { servicesFromLibrary } from './infra-preflight-lib.mjs';
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

const ROOT = process.env.RASTA_DRILL_ROOT
  ? resolve(process.env.RASTA_DRILL_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--report') {
  console.error('Usage: scripts/backup-restore-drill --report /path/to/new-report.json');
  process.exit(2);
}
// Exclusive creation avoids overwriting an operator's file (including through a symlink).
// Later writes replace it atomically through a sibling file (see writeReportAtomically).
const reportPath = resolve(args[1]);
try {
  closeSync(openSync(reportPath, 'wx', 0o600));
} catch {
  // Not the path, nor the error that quotes it (#385 r6).
  console.error(
    'the --report file cannot be created (it must not exist yet); its path is not repeated',
  );
  process.exit(2);
}
let temporary;
let project;
let composeFile;
let services;
// Only explicit local Docker endpoint/context; HOME is retained for pnpm, not daemon selection.
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
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
  const synced = writeReportAtomically(reportPath, final ? report : { ...report, passed: false }, {
    durable,
  });
  if (durable && !synced)
    process.stderr.write(
      '[backup-restore-drill] the report directory could not be synced; the report is written but power-loss durability is not confirmed\n',
    );
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
      '[backup-restore-drill] a report write failed; the run cannot be reported as passed\n',
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

const failedCleanup = ({ leftovers = [], unverified = [] } = {}) => ({
  passed: false,
  project,
  temporary,
  // Resource kinds only (no ids): what still exists, and what could not be checked.
  ...(leftovers.length && { leftovers }),
  ...(unverified.length && { unverified }),
  ...(report.orphanProcessGroups?.length && { orphanProcessGroups: report.orphanProcessGroups }),
});

try {
  temporary = mkdtempSync(join(tmpdir(), 'rasta-restore-drill-'));
  project = `restore-drill-${randomBytes(8).toString('hex')}`;
  report.project = project;
  report.temporary = temporary;
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
    teardown: async () => {
      if (!composeReady) return {};
      await compose(['down', '--volumes', '--timeout', '15'], { cleanup: true, timeout: 60_000 });
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
    },
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
