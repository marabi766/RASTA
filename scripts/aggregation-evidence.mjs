#!/usr/bin/env node
/**
 * Measures identity-service's aggregation stress proof against one PostgreSQL
 * and writes a short aggregate report. Manual in both modes: nothing in
 * `pnpm verify` or CI runs either of them, and `pnpm check:test-phases`
 * enforces that.
 *
 *   node scripts/aggregation-evidence.mjs <report-path>
 *     The evidence campaign, unchanged: a control, a WAL probe, five
 *     name-filtered runs of the proof, the whole project once, the probe again.
 *
 *   node scripts/aggregation-evidence.mjs --calibrate --pairs <N> <report-path>
 *   pnpm run calibrate:aggregation-stress -- --pairs <N> <report-path>
 *     The ADR-055 paired calibration campaign: a control, then N samples of
 *     "one validated WAL probe, then immediately the whole unchanged
 *     aggregation-stress project". Adjacency is the point — a measurement taken
 *     apart from the run describes conditions that run never met.
 *
 * Calibration reports validity only (`VALID`/`INVALID`/`INCONCLUSIVE`). It
 * applies no threshold and makes no capability judgement: ADR-055 is
 * `Proposed` and the two-sided dataset it needs does not exist yet.
 *
 * Needs a migrated identity database (`DATABASE_URL_IDENTITY`), libpq
 * variables for a superuser session on the same server (`PGHOST`, `PGPORT`,
 * `PGUSER`, `PGPASSWORD`, `PGDATABASE`), and Docker, which runs `pgbench` and
 * `psql` from the server's own image (`EVIDENCE_PG_IMAGE`) on
 * `EVIDENCE_DOCKER_NETWORK` (default `host`; on Docker Desktop, the server's
 * Compose network with `PGHOST` set to its service name). It runs the stress
 * spec six times against that database, so give it the database alone —
 * beside other suites it measures their load. The plan and every
 * judgement live in `aggregation-evidence-lib.mjs`.
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
  classifyInfrastructureProblems,
  formatCalibrationReport,
  formatReport,
  parseEvidenceArgs,
  parsePgbenchOutput,
  parseWalSamples,
  parseWalStat,
  pgbenchArgs,
  planCalibrationRun,
  planEvidenceRun,
  redact,
  summarizeBurst,
  summarizeCalibration,
  summarizeJestReport,
  summarizeProbe,
  validateCalibrationContract,
  validateEvidenceContract,
} from './aggregation-evidence-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(root, STRESS.packageDir);
const image = process.env.EVIDENCE_PG_IMAGE ?? 'postgis/postgis:16-3.4';
const network = process.env.EVIDENCE_DOCKER_NETWORK ?? 'host';
const PG_ENV = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'];
const MINUTE = 60_000;

const out = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Prints why a step could not produce evidence, as category counts over the
 * aggregate problems the harness already built — never a child process's
 * stdout or stderr, which can carry URLs, credentials, rows and identifiers.
 */
function reportCategories(label, problems) {
  const counts = Object.entries(classifyInfrastructureProblems(problems)).filter(
    ([, count]) => count > 0,
  );
  out(
    `[evidence] ${label}: ${
      counts.map(([name, count]) => `${name}=${count}`).join(' ') || 'unclassified=0'
    }`,
  );
  for (const problem of problems) out(`[evidence]   problem: ${redact(String(problem))}`);
}

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
  network,
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
    // The message becomes a probe `problem`, which reaches the report. So it
    // carries the exit code and a category — never the output itself, which
    // can hold a connection string, a role name or a server error verbatim.
    const categories = Object.entries(
      classifyInfrastructureProblems([redact(result.output.slice(-600))]),
    )
      .filter(([, count]) => count > 0)
      .map(([name]) => name);
    throw new Error(`psql exited ${result.exitCode} (${categories.join(', ') || 'unclassified'})`);
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
    // Only the aggregate problem and its category leave this function. An
    // output tail — even redacted — can still carry row values, identifiers
    // and command environments that no report needs.
    reportCategories(`${step.id} probe`, probe.problems);
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

/** The package's own jest launcher. `jest/bin/jest.js` is not an exported subpath, so go through the manifest. */
function jestBin() {
  const manifest = createRequire(join(packageDir, 'package.json')).resolve('jest/package.json');
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8'));
  const path = join(dirname(manifest), typeof bin === 'string' ? bin : bin.jest);
  if (!existsSync(path)) throw new Error(`jest launcher not found at ${path}`);
  return path;
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
        [jestBin(), ...step.jestArgs, `--outputFile=${reportPath}`],
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
  if (!report) {
    summary.problems.push(
      `${step.id} wrote no jest report (exit ${result.exitCode}${result.timedOut ? ', after its bound' : ''})`,
    );
    reportCategories(`${step.id} suite`, summary.problems);
  }
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

/**
 * Runs an ordered plan. Every step runs; a failing one never stops the rest and
 * is never retried, so the report keeps the whole distribution rather than
 * stopping at the first bad sample.
 */
async function runPlan(plan) {
  const results = [];
  for (const step of plan) {
    out(`[evidence] ${step.id} started ${new Date().toISOString()}`);
    let result;
    try {
      result = step.kind === 'probe' ? await runProbe(step) : await runJest(step);
    } catch (error) {
      // Recorded as a failed step; the remaining steps still run.
      result = { id: step.id, passed: false, error: redact(error?.message ?? String(error)) };
    }
    results.push(result);
    out(
      `[evidence] ${step.id} finished ${new Date().toISOString()}: ${result.passed ? 'PASS' : 'FAIL'}`,
    );
  }
  return results;
}

async function commitSha() {
  const head = await runBounded('git', ['rev-parse', 'HEAD'], { timeoutMs: MINUTE });
  return head.exitCode === 0 ? head.output.trim() : 'unknown';
}

async function readTopology() {
  try {
    return await topology();
  } catch (error) {
    return { error: JSON.stringify(redact(error.message)) };
  }
}

async function main() {
  const parsed = parseEvidenceArgs(process.argv.slice(2));
  if (parsed.error) {
    out(`[evidence] ${parsed.error}`);
    out(parsed.usage);
    return 2;
  }
  const { mode, pairs, reportPath } = parsed;

  const missing = [...PG_ENV, 'DATABASE_URL_IDENTITY'].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    // Names only — never the values.
    out(`[evidence] missing environment: ${missing.join(', ')}`);
    return 2;
  }

  const specSource = readFileSync(join(packageDir, STRESS.spec), 'utf8');
  const plan = mode === 'calibrate' ? planCalibrationRun({ pairs }) : planEvidenceRun();
  const contract =
    mode === 'calibrate'
      ? validateCalibrationContract({ specSource, plan, pairs })
      : validateEvidenceContract({ specSource, plan });
  if (contract.length > 0) {
    for (const problem of contract) out(`[evidence] contract: ${problem}`);
    return 1;
  }

  // Resolved before anything is measured, so a harness that cannot start jest fails first.
  jestBin();

  workDir = mkdtempSync(join(tmpdir(), 'aggregation-evidence-'));
  const topo = await readTopology();
  out(`[evidence] topology ${JSON.stringify(topo)}`);
  if (mode === 'calibrate') {
    out(
      `[evidence] calibration: ${pairs} pair(s); each is one ${plan[1].seconds} s probe immediately ` +
        `followed by one unfiltered \`pnpm run ${STRESS.rootScript}\`. No threshold is applied.`,
    );
  }

  const results = await runPlan(plan);
  const meta = { commit: await commitSha(), generatedAt: new Date().toISOString() };
  const text =
    mode === 'calibrate'
      ? formatCalibrationReport({
          meta,
          topology: topo,
          summary: summarizeCalibration({ pairs, results }),
        })
      : formatReport({ meta, topology: topo, results });

  out(`\n${text}`);
  try {
    writeFileSync(reportPath, text);
  } catch (error) {
    out(`[evidence] could not write the report: ${error.code ?? 'error'}`);
    return 1;
  }
  // Report-only means this is not wired into a quality gate, not that a bad
  // sample is painted green: an invalid probe, a failed suite, a process that
  // could not start or a broken topology all still exit non-zero.
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
