#!/usr/bin/env node
/**
 * Collects native-Linux evidence for identity-service's aggregation stress
 * proof and writes one short aggregate report.
 *
 *   node scripts/aggregation-evidence.mjs <report-path>
 *
 * Needs a migrated identity database (`DATABASE_URL_IDENTITY`), libpq
 * variables for a superuser session on the same server (`PGHOST`, `PGPORT`,
 * `PGUSER`, `PGPASSWORD`, `PGDATABASE`) and Docker, which runs `pgbench` and
 * `psql` from the server's own image (`EVIDENCE_PG_IMAGE`) on the host
 * network. The plan and every judgement live in `aggregation-evidence-lib.mjs`.
 *
 * Every step runs; a failing one never stops the rest or is retried. The exit
 * code is non-zero when any step failed, any probe was invalid, or the report
 * could not be written. Only aggregates are printed or written.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STRESS,
  formatReport,
  parsePgbenchOutput,
  parseWalSamples,
  parseWalStat,
  pgbenchArgs,
  planEvidenceRun,
  redact,
  summarizeBurst,
  summarizeJestReport,
  summarizeProbe,
  validateEvidenceContract,
} from './aggregation-evidence-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(root, STRESS.packageDir);
const image = process.env.EVIDENCE_PG_IMAGE ?? 'postgis/postgis:16-3.4';
const PG_ENV = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'];
const MINUTE = 60_000;

const out = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const children = new Set();
const containers = new Set();
let workDir;

function cleanup() {
  for (const child of children) child.kill('SIGKILL');
  for (const name of containers) spawn('docker', ['rm', '-f', name], { stdio: 'ignore' });
  if (workDir) rmSync(workDir, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    out(`[evidence] ${signal} received; stopping children and removing temporary files`);
    cleanup();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

/**
 * Runs one process with a hard bound, keeping only the tail of its output in
 * memory. Never throws: a process that cannot start reports exit 127.
 */
function runBounded(command, args, { cwd = root, env = process.env, timeoutMs, input } = {}) {
  return new Promise((done) => {
    const startedAt = new Date();
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === 'win32' && command === 'pnpm',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(child);
    let output = '';
    const keep = (chunk) => {
      output = (output + chunk.toString()).slice(-2_000_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (exitCode) => {
      clearTimeout(timer);
      children.delete(child);
      const endedAt = new Date();
      done({ exitCode, timedOut, output, startedAt, endedAt });
    };
    child.on('error', () => finish(127));
    child.on('close', (code) => finish(code ?? 1));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const dockerPg = (extra, command) => [
  'run',
  '--rm',
  '--network',
  'host',
  ...PG_ENV.flatMap((name) => ['-e', name]),
  ...extra,
  image,
  ...command,
];

async function psql(sql) {
  const result = await runBounded(
    'docker',
    dockerPg([], ['psql', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql]),
    { timeoutMs: 2 * MINUTE },
  );
  if (result.exitCode !== 0) {
    throw new Error(`psql exited ${result.exitCode}: ${redact(result.output.slice(-600))}`);
  }
  return result.output;
}

const readWal = async () =>
  parseWalStat(
    await psql(
      "SELECT concat_ws('|', wal_records, wal_sync, wal_write, wal_bytes) FROM pg_stat_wal",
    ),
  );

async function topology() {
  const settings = [
    'server_version',
    'fsync',
    'synchronous_commit',
    'wal_level',
    'wal_sync_method',
    'full_page_writes',
    'shared_buffers',
    'max_connections',
    'max_wal_size',
    'checkpoint_timeout',
  ];
  const row = (
    await psql(
      `SELECT concat_ws('|', ${settings.map((name) => `current_setting('${name}')`).join(', ')})`,
    )
  )
    .trim()
    .split('|');
  const osName = existsSync('/etc/os-release')
    ? (readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ??
      'unknown')
    : process.platform;
  const driver = await runBounded('docker', ['info', '--format', '{{.Driver}}'], {
    timeoutMs: MINUTE,
  });
  return {
    runner_os: JSON.stringify(osName),
    runner_image:
      process.env.ImageOS && process.env.ImageVersion
        ? `${process.env.ImageOS}/${process.env.ImageVersion}`
        : 'unknown',
    kernel: release(),
    cpus: cpus().length,
    memory_gib: (totalmem() / 2 ** 30).toFixed(1),
    docker_storage_driver: driver.exitCode === 0 ? driver.output.trim() : 'unknown',
    postgres_image: image,
    ...Object.fromEntries(settings.map((name, index) => [name, row[index] ?? 'unknown'])),
  };
}

async function runProbe(step) {
  const scriptPath = join(workDir, `${step.id}.sql`);
  writeFileSync(scriptPath, `${step.sql}\n`);
  let before;
  let after;
  let bench;
  try {
    before = await readWal();
    bench = await runBounded(
      'docker',
      dockerPg(
        ['-v', `${workDir}:/probe:ro`],
        ['pgbench', ...pgbenchArgs({ seconds: step.seconds, scriptPath: `/probe/${step.id}.sql` })],
      ),
      { timeoutMs: step.seconds * 1000 + 2 * MINUTE },
    );
    // A backend flushes its WAL counters when it exits; give that a moment.
    await sleep(1500);
    after = await readWal();
  } catch (error) {
    const probe = { valid: false, problems: [redact(error.message)] };
    return { id: step.id, passed: false, probe: emptyProbe(step, probe) };
  }
  const probe = summarizeProbe({
    pgbench: parsePgbenchOutput(bench.output),
    before,
    after,
    seconds: step.seconds,
    control: step.control === true,
  });
  if (bench.exitCode !== 0 || bench.timedOut) {
    probe.valid = false;
    probe.problems.push(
      `pgbench exited ${bench.exitCode}${bench.timedOut ? ' after its bound' : ''}`,
    );
    out(redact(bench.output.slice(-1500)));
  }
  return { id: step.id, passed: probe.valid, probe };
}

function emptyProbe(step, { problems }) {
  return {
    control: step.control === true,
    seconds: step.seconds,
    transactions: 0,
    failed: 0,
    tps: null,
    latencyAverageMs: null,
    walSyncDelta: 0,
    walSyncPerSecond: null,
    walSyncPerTransaction: null,
    walRecordsPerTransaction: null,
    minIntervalTps: null,
    zeroCommitIntervals: 0,
    longestZeroCommitSeconds: null,
    valid: false,
    problems,
  };
}

/** A `\watch 1` psql session sampling `pg_stat_wal` until stopped. */
function startSampler(id) {
  const name = `rasta-evidence-sampler-${process.pid}-${id}`;
  containers.add(name);
  const run = runBounded(
    'docker',
    dockerPg(['-i', '--name', name], ['psql', '-X', '-A', '-t', '-q']),
    {
      timeoutMs: 40 * MINUTE,
      input:
        "SELECT extract(epoch FROM clock_timestamp())::numeric(16,3) || '|' || wal_sync FROM pg_stat_wal \\watch 1\n",
    },
  );
  return async () => {
    await runBounded('docker', ['kill', '--signal', 'INT', name], { timeoutMs: MINUTE });
    const stopped = await Promise.race([run, sleep(10_000).then(() => null)]);
    if (!stopped) await runBounded('docker', ['rm', '-f', name], { timeoutMs: MINUTE });
    containers.delete(name);
    return parseWalSamples((stopped ?? (await run)).output);
  };
}

async function runJest(step) {
  const reportPath = join(workDir, `${step.id}.json`);
  const named = step.kind === 'jest-named';
  let walBefore;
  try {
    walBefore = await readWal();
  } catch {
    walBefore = null;
  }
  const stopSampler = named ? startSampler(step.id) : null;
  const env = { ...process.env, NODE_ENV: 'test' };
  const result = named
    ? await runBounded(
        process.execPath,
        [
          createRequire(join(packageDir, 'package.json')).resolve('jest/bin/jest.js'),
          ...step.jestArgs,
          `--outputFile=${reportPath}`,
        ],
        { cwd: packageDir, env, timeoutMs: 8 * MINUTE },
      )
    : await runBounded('pnpm', [...step.pnpmArgs, `--outputFile=${reportPath}`], {
        env,
        timeoutMs: 30 * MINUTE,
      });
  const samples = stopSampler ? await stopSampler() : null;
  let walAfter;
  try {
    walAfter = await readWal();
  } catch {
    walAfter = null;
  }

  let report = null;
  if (existsSync(reportPath)) {
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'));
    } catch {
      report = null;
    }
  }
  const summary = summarizeJestReport(report, { expectNamed: named });
  if (!report)
    out(
      `[evidence] ${step.id} wrote no jest report; redacted tail:\n${redact(result.output.slice(-3000))}`,
    );
  const wallSeconds = (result.endedAt - result.startedAt) / 1000;
  const wal =
    walBefore && walAfter
      ? {
          walSyncDelta: walAfter.walSync - walBefore.walSync,
          walSyncPerSecond: (walAfter.walSync - walBefore.walSync) / wallSeconds,
        }
      : null;
  if (!wal) summary.problems.push('pg_stat_wal could not be read around the run');
  return {
    id: step.id,
    passed: result.exitCode === 0 && !result.timedOut && summary.problems.length === 0,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    startedAt: result.startedAt.toISOString(),
    endedAt: result.endedAt.toISOString(),
    wallSeconds,
    summary,
    wal,
    burst: samples ? summarizeBurst(samples) : null,
  };
}

async function main() {
  const reportPath = process.argv[2];
  if (!reportPath) {
    out('usage: node scripts/aggregation-evidence.mjs <report-path>');
    return 2;
  }
  const missing = [...PG_ENV, 'DATABASE_URL_IDENTITY'].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    out(`[evidence] missing environment: ${missing.join(', ')}`);
    return 2;
  }

  const plan = planEvidenceRun();
  const contract = validateEvidenceContract({
    specSource: readFileSync(join(packageDir, STRESS.spec), 'utf8'),
    plan,
  });
  if (contract.length > 0) {
    for (const problem of contract) out(`[evidence] contract: ${problem}`);
    return 1;
  }

  workDir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'aggregation-evidence-'));
  const results = [];
  let topo;
  try {
    topo = await topology();
  } catch (error) {
    topo = { error: JSON.stringify(redact(error.message)) };
  }
  out(`[evidence] topology ${JSON.stringify(topo)}`);

  for (const step of plan) {
    out(`[evidence] ${step.id} started ${new Date().toISOString()}`);
    const result = step.kind === 'probe' ? await runProbe(step) : await runJest(step);
    results.push(result);
    out(
      `[evidence] ${step.id} finished ${new Date().toISOString()}: ${result.passed ? 'PASS' : 'FAIL'}`,
    );
  }

  const server = process.env.GITHUB_SERVER_URL;
  const text = formatReport({
    meta: {
      commit: process.env.GITHUB_SHA ?? 'local',
      runUrl:
        server && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
          ? `${server}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`
          : 'local',
      generatedAt: new Date().toISOString(),
    },
    topology: topo,
    results,
  });
  out(`\n${text}`);
  try {
    writeFileSync(reportPath, text);
  } catch (error) {
    out(`[evidence] could not write the report: ${error.code ?? 'error'}`);
    return 1;
  }
  return results.every((result) => result.passed) && !topo.error ? 0 : 1;
}

main()
  .then((code) => {
    cleanup();
    process.exit(code);
  })
  .catch((error) => {
    out(`[evidence] aborted: ${redact(error?.message ?? String(error))}`);
    cleanup();
    process.exit(1);
  });
