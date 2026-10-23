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
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import YAML from 'yaml';
import { servicesFromLibrary } from './infra-preflight-lib.mjs';
import {
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--report') {
  console.error('Usage: scripts/backup-restore-drill --report /path/to/new-report.json');
  process.exit(2);
}
// Exclusive creation avoids overwriting an operator's file (including through a symlink).
const reportPath = resolve(args[1]);
const reportFd = openSync(reportPath, 'wx', 0o600);
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
let active;
let composeReady = false;
const report = {
  version: 2,
  startedAt: new Date().toISOString(),
  passed: false,
  fixture: 'existing demo seeds plus synthetic 9007199254740993 IRR journal and wallet',
  databases: [],
  cleanup: { passed: false },
};

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
    stopActive();
  });
}

/** One bounded child process group at a time; output never prints credentials or seeded payloads. */
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
      reject(new Error('Could not start command'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      active = undefined;
      if (code !== 0 || overflow) {
        const detail =
          `${Buffer.concat(output).toString('utf8').slice(-4000)}\n${diagnostic}`.replace(
            /postgres(?:ql)?:\/\/[^\s"']+/gi,
            '[database URL redacted]',
          );
        reject(new Error(`Command failed (exit ${code}): ${detail}`));
      } else accept(Buffer.concat(output).toString('utf8').trim());
    });
  });
}

const compose = (argv, options) =>
  run('docker', ['compose', '--project-name', project, '--file', composeFile, ...argv], options);
const psql = (container, database, input) =>
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
    { input },
  );

async function snapshot(container, service) {
  const database = `rasta_${service}`;
  const inventory = await psql(container, database, INVENTORY_SQL);
  const tables = Object.fromEntries(
    inventory.split('\n').map((line) => {
      const { name, ...table } = JSON.parse(line);
      return [name, table];
    }),
  );
  const databaseState = JSON.parse(await psql(container, database, DATABASE_STATE_SQL));
  const schema = service === 'audit' ? 'audit' : 'public';
  const migrations = JSON.parse(await psql(container, database, MIGRATIONS_SQL(schema)));
  return { tables, migrations, databaseState, summary: summarizeTables(tables) };
}

function progress(value) {
  stage = value;
  console.error(`[backup-restore-drill] ${stage}`);
}

try {
  temporary = mkdtempSync(join(tmpdir(), 'rasta-restore-drill-'));
  project = `restore-drill-${randomBytes(8).toString('hex')}`;
  report.project = project;
  composeFile = join(temporary, 'compose.json');
  services = servicesFromLibrary();
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
    const url = new URL(value);
    url.hostname = '127.0.0.1';
    url.port = port;
    dbEnv[key] = url.toString();
  }
  for (const service of services) {
    const cwd = join(ROOT, 'services', `${service}-service`);
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    progress(`migrate ${service}`);
    await run('pnpm', ['run', 'db:migrate'], { cwd, env: dbEnv });
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
    const fd = openSync(join(temporary, `${service}.dump`), 'wx', 0o600);
    try {
      await run(
        'docker',
        ['exec', source, 'pg_dump', '-U', 'rasta', '-Fc', '-d', `rasta_${service}`],
        { outputFd: fd },
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
        { inputFd: fd },
      );
    } finally {
      closeSync(fd);
    }
    const after = await snapshot(restored, service);
    const result = compareSnapshots(report.databases[index].before, after);
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
  report.error = { stage, message: error.message };
  report.passed = false;
} finally {
  progress('cleanup owned containers, networks and volumes');
  try {
    if (composeReady)
      await compose(['down', '--volumes', '--timeout', '15'], { cleanup: true, timeout: 60_000 });
    // Confirm no owned resources survived (never enumerate/remove another project's resources).
    const resources = project
      ? await Promise.all(
          ['container', 'volume', 'network'].map((kind) =>
            run(
              'docker',
              [kind, 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`],
              { cleanup: true, timeout: 15_000 },
            ),
          ),
        )
      : [];
    if (resources.some(Boolean)) {
      report.cleanup = { passed: false, project, temporary };
      report.passed = false;
    } else {
      report.cleanup.passed = true;
      if (temporary) rmSync(temporary, { recursive: true, force: true });
    }
  } catch {
    report.cleanup = { passed: false, project, temporary };
    report.passed = false;
  }
  report.finishedAt = new Date().toISOString();
  report.interrupted = interrupted;
  if (interrupted) report.passed = false;
  writeFileSync(reportFd, `${JSON.stringify(report, null, 2)}\n`);
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
