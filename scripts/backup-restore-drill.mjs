#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
  ftruncateSync,
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
  collectSchemaReference,
  schemaDiffSummary,
  checkServiceCoverage,
  OBJECT_STATE_SQL,
  SEQUENCES_SQL,
  compareSnapshots,
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
// --cleanup-from tears down what an earlier --report run recorded (a scheduled CI job's
// last step, after a cancelled or timed-out run); it starts nothing and writes no report.
const cleanupOnly = args.length === 2 && args[0] === '--cleanup-from';
if (!cleanupOnly && (args.length !== 2 || args[0] !== '--report')) {
  console.error(
    'Usage: scripts/backup-restore-drill --report /path/to/new-report.json\n' +
      '       scripts/backup-restore-drill --cleanup-from /path/to/that-report.json',
  );
  process.exit(2);
}
// Exclusive creation avoids overwriting an operator's file (including through a symlink).
const reportPath = resolve(args[1]);
let reportFd;
if (!cleanupOnly) {
  try {
    reportFd = openSync(reportPath, 'wx', 0o600);
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
let active;
let composeReady = false;
const report = {
  version: 5,
  signals: [],
  startedAt: new Date().toISOString(),
  passed: false,
  fixture: 'existing demo seeds plus synthetic 9007199254740993 IRR journal and wallet',
  databases: [],
  cleanup: { passed: false },
};

function writeReport() {
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(reportFd, bytes, offset, bytes.length - offset, offset);
    if (!written) throw new Error('Could not write report');
    offset += written;
  }
  ftruncateSync(reportFd, bytes.length);
}

function commandError(options, exitCode, message) {
  const error = new Error(options.privateOutput ? 'Private schema command failed' : message);
  if (options.privateOutput)
    error.privateFailure = {
      stage: options.stage ?? stage,
      database: options.database ?? null,
      exitCode,
    };
  return error;
}

function stopActive() {
  if (active) {
    try {
      process.kill(-active.pid, 'SIGKILL');
    } catch {
      /* already stopped */
    }
  }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    interrupted = true;
    report.signals.push({ signal, duringCleanup: cleaning });
    if (!cleaning) stopActive();
    else process.stderr.write(`[backup-restore-drill] cleanup continues after ${signal}\n`);
  });
}

/** Bounded children; failure diagnostics retain the last 4 KB per stream.
 * Database URLs are redacted; synthetic seed payloads can appear in diagnostics. */
async function run(command, argv, options = {}) {
  if (interrupted && !options.cleanup) throw new Error('Interrupted');
  return new Promise((accept, reject) => {
    const child = spawn(command, argv, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? env,
      detached: true,
      stdio: [options.inputFd ?? 'pipe', options.outputFd ?? 'pipe', 'pipe'],
    });
    active = child;
    const output = [];
    let diagnostic = '';
    let bytes = 0;
    let overflow = false;
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }, options.timeout ?? 600_000);
    child.stdout?.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        overflow = true;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already stopped */
        }
      } else output.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4000);
    });
    child.stdin?.on('error', () => {});
    if (child.stdin) child.stdin.end(options.input);
    child.on('error', () => {
      clearTimeout(timer);
      active = undefined;
      reject(commandError(options, null, 'Could not start command'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      active = undefined;
      if (code !== 0 || overflow) {
        if (options.privateOutput) {
          reject(commandError(options, code, 'Private schema command failed'));
          return;
        }
        const detail =
          `${Buffer.concat(output).toString('utf8').slice(-4000)}\n${diagnostic}`.replace(
            /postgres(?:ql)?:\/\/[^\s"']+/gi,
            '[database URL redacted]',
          );
        reject(new Error(`Command failed (exit ${code}): ${detail}`));
      } else
        accept(options.raw ? Buffer.concat(output) : Buffer.concat(output).toString('utf8').trim());
    });
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
async function collectSchemaDump(container, database, label) {
  return dumpSchema(database, label, async () => {
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
  });
}

async function collectReference(container, database, sourceDump) {
  const suffix = project.slice('restore-drill-'.length);
  report.scratchDatabases = [`drill_ref_${suffix}`, `drill_fixed_${suffix}`];
  return collectSchemaReference({
    database,
    suffix,
    sourceDump,
    dump: (name, label) => collectSchemaDump(container, name, label),
    create: (name) =>
      psql(container, 'postgres', `CREATE DATABASE "${name}" TEMPLATE template0;`, {
        privateOutput: true,
        database: name,
      }),
    restore: async (name, path) => {
      const fd = openSync(path, 'r');
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

/** Never enumerates another project's resources: only this invocation's Compose label. */
async function ownedResourcesLeft() {
  const resources = await Promise.all(
    ['container', 'volume', 'network'].map((kind) =>
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
    ),
  );
  return resources.some(Boolean);
}

/** Removes this invocation's Compose project; true when no owned resource survived. */
async function teardown() {
  if (!composeReady) return true;
  await compose(['down', '--volumes', '--timeout', '15'], { cleanup: true, timeout: 60_000 });
  return !(await ownedResourcesLeft());
}

/** Exit status for --cleanup-from: 0 nothing owned is left, 1 something is, 2 the report is refused. */
async function cleanupRecorded() {
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    // Not even the provisional report exists: the run never allocated anything to remove.
    console.error('[backup-restore-drill] no readable report: nothing recorded to clean up');
    return 0;
  }
  project = recorded?.project;
  temporary = recorded?.temporary;
  if (project === undefined && temporary === undefined) {
    console.error('[backup-restore-drill] the report records no project: nothing to clean up');
    return 0;
  }
  // The report is only a pointer: act on nothing but a name and a directory this CLI makes.
  const base = tmpdir();
  if (
    typeof project !== 'string' ||
    !/^restore-drill-[0-9a-f]{16}$/.test(project) ||
    typeof temporary !== 'string' ||
    dirname(temporary) !== base ||
    !/^rasta-restore-drill-[A-Za-z0-9]{6}$/.test(temporary.slice(base.length + 1))
  ) {
    console.error('[backup-restore-drill] the report does not name a project this drill created');
    return 2;
  }
  composeFile = join(temporary, 'compose.json');
  // `down` needs the file; a missing one means teardown already finished, and labels still say.
  composeReady = existsSync(composeFile);
  cleaning = true;
  progress('cleanup owned containers, networks and volumes');
  try {
    const left = composeReady ? !(await teardown()) : await ownedResourcesLeft();
    if (left) throw new Error('owned resources survived');
    rmSync(temporary, { recursive: true, force: true });
    return 0;
  } catch {
    console.error('[backup-restore-drill] owned resources could not be removed');
    return 1;
  }
}

function progress(value) {
  stage = value;
  process.stderr.write(`[backup-restore-drill] ${stage}\n`);
}

if (cleanupOnly) process.exit(await cleanupRecorded());

try {
  temporary = mkdtempSync(join(tmpdir(), 'rasta-restore-drill-'));
  project = `restore-drill-${randomBytes(8).toString('hex')}`;
  report.project = project;
  report.temporary = temporary;
  // Persist cleanup ownership before any child can allocate resources (including SIGKILL).
  writeReport();
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
  try {
    if (await teardown()) {
      report.cleanup.passed = true;
      if (temporary) rmSync(temporary, { recursive: true, force: true });
    } else {
      report.cleanup = { passed: false, project, temporary };
      report.passed = false;
    }
  } catch {
    report.cleanup = { passed: false, project, temporary };
    report.passed = false;
  }
  report.finishedAt = new Date().toISOString();
  report.interrupted = interrupted;
  if (interrupted) report.passed = false;
  writeReport();
  closeSync(reportFd);
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
