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
 *
 * **Why a step's failure is typed here and never re-read.** A subprocess result
 * is turned into a fixed diagnostic — a launcher, an in-image tool, an outcome,
 * an exit code and canonical category names — at the one place its raw output
 * still exists. From there only that diagnostic travels: to the probe or suite
 * result, to the campaign summary and into the report. No stage parses a
 * sentence to learn what happened, so an unreachable server stays
 * `connectionFailure` and a Docker CLI that cannot start stays
 * `dockerUnavailable` instead of collapsing into "something exited 1".
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DiagnosticError,
  INFRASTRUCTURE_CATEGORY,
  IN_IMAGE_TOOL,
  LAUNCHER,
  PROCESS_OUTCOME,
  STRESS,
  checkedOutput,
  countCategories,
  diagnostic,
  diagnosticFromError,
  formatCalibrationReport,
  formatReport,
  measureProbe,
  parseEvidenceArgs,
  parseWalSamples,
  pgbenchArgs,
  planCalibrationRun,
  planEvidenceRun,
  redact,
  summarizeCalibration,
  summarizeJestRun,
  validateCalibrationContract,
  validateEvidenceContract,
  walStatFrom,
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
 * Prints why a step could not produce evidence, as counts over the categories
 * the step already attached — never a child process's stdout or stderr, which
 * can carry URLs, credentials, rows and identifiers, and never a re-reading of
 * the aggregate text printed beside them.
 */
function reportDiagnostics(label, diagnostics) {
  const counts = Object.entries(countCategories(diagnostics)).filter(([, count]) => count > 0);
  out(
    `[evidence] ${label}: ${
      counts.map(([name, count]) => `${name}=${count}`).join(' ') || 'unclassified=0'
    }`,
  );
  for (const entry of diagnostics) out(`[evidence]   problem: ${entry.text}`);
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

/** The fixed command behind each launcher name. Nothing else may be spawned. */
const LAUNCHER_COMMAND = Object.freeze({
  [LAUNCHER.docker]: 'docker',
  [LAUNCHER.pnpm]: 'pnpm',
  [LAUNCHER.jest]: process.execPath,
  [LAUNCHER.git]: 'git',
});

/**
 * Runs one process with a hard bound, keeping only the tail of its output in
 * memory. Never throws, and never keeps an OS error message: the three ways a
 * run can end — the launcher could not start, the child exited, the bound
 * killed it — are distinguished by `outcome`, and the caller learns *which*
 * fixed launcher and in-image tool it asked for without the arguments, the
 * environment or the connection behind them.
 */
function runBounded(
  launcher,
  args,
  { cwd = root, env = process.env, timeoutMs, input, tool } = {},
) {
  return new Promise((done) => {
    const startedAt = new Date();
    const child = spawn(LAUNCHER_COMMAND[launcher], args, {
      cwd,
      env,
      shell: process.platform === 'win32' && launcher === LAUNCHER.pnpm,
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
    const finish = (exitCode, outcome) => {
      clearTimeout(timer);
      children.delete(child);
      done({
        launcher,
        tool: tool ?? null,
        outcome,
        exitCode,
        timedOut: outcome === PROCESS_OUTCOME.timedOut,
        output,
        startedAt,
        endedAt: new Date(),
      });
    };
    // The spawn error object is deliberately never read: it carries an errno,
    // a path and a command line, and which launcher failed is already known.
    child.on('error', () => finish(127, PROCESS_OUTCOME.launcherFailed));
    child.on('close', (code) =>
      finish(code ?? 1, timedOut ? PROCESS_OUTCOME.timedOut : PROCESS_OUTCOME.completed),
    );
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

/** One `psql` execution in the pinned image. The result is typed; the output is never retained. */
const psqlRun = (sql) =>
  runBounded(
    LAUNCHER.docker,
    dockerPg([], ['psql', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql]),
    { timeoutMs: 2 * MINUTE, tool: IN_IMAGE_TOOL.psql },
  );

const psql = async (sql) => checkedOutput(await psqlRun(sql));

const readWal = async () =>
  walStatFrom(
    await psqlRun(
      "SELECT concat_ws('|', wal_records, wal_sync, wal_write, wal_bytes) FROM pg_stat_wal",
    ),
  );

/** A storage driver name is one fixed token or it is not reported at all. */
const DRIVER_NAME = /^[A-Za-z0-9_.-]{1,32}$/;

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
  const driver = await runBounded(LAUNCHER.docker, ['info', '--format', '{{.Driver}}'], {
    timeoutMs: MINUTE,
  });
  const driverName = driver.exitCode === 0 ? driver.output.trim() : '';
  return {
    runner_os: JSON.stringify(osName),
    runner_image:
      process.env.ImageOS && process.env.ImageVersion
        ? `${process.env.ImageOS}/${process.env.ImageVersion}`
        : 'unknown',
    kernel: release(),
    cpus: cpus().length,
    memory_gib: (totalmem() / 2 ** 30).toFixed(1),
    docker_storage_driver: DRIVER_NAME.test(driverName) ? driverName : 'unknown',
    postgres_image: image,
    // Server settings are fixed names with short fixed-shape values; `redact`
    // stays on top of them so a surprising value cannot become the exception.
    ...Object.fromEntries(settings.map((name, index) => [name, redact(row[index] ?? 'unknown')])),
  };
}

/** Writes the probe script and runs the injected plan step through the shared helper. */
function runProbe(step) {
  const scriptPath = join(workDir, `${step.id}.sql`);
  writeFileSync(scriptPath, `${step.sql}\n`);
  return measureProbe(step, {
    readWalStat: readWal,
    runPgbench: (probeStep) =>
      runBounded(
        LAUNCHER.docker,
        dockerPg(
          ['-v', `${workDir}:/probe:ro`],
          [
            'pgbench',
            ...pgbenchArgs({
              seconds: probeStep.seconds,
              scriptPath: `/probe/${probeStep.id}.sql`,
            }),
          ],
        ),
        { timeoutMs: probeStep.seconds * 1000 + 2 * MINUTE, tool: IN_IMAGE_TOOL.pgbench },
      ),
    settle: () => sleep(1500),
  });
}

/** A `\watch 1` psql session sampling `pg_stat_wal` until stopped. */
function startSampler(id) {
  const name = `rasta-evidence-sampler-${process.pid}-${id}`;
  containers.add(name);
  const run = runBounded(
    LAUNCHER.docker,
    dockerPg(['-i', '--name', name], ['psql', '-X', '-A', '-t', '-q']),
    {
      timeoutMs: 40 * MINUTE,
      tool: IN_IMAGE_TOOL.psql,
      input:
        "SELECT extract(epoch FROM clock_timestamp())::numeric(16,3) || '|' || wal_sync FROM pg_stat_wal \\watch 1\n",
    },
  );
  return async () => {
    await runBounded(LAUNCHER.docker, ['kill', '--signal', 'INT', name], { timeoutMs: MINUTE });
    const stopped = await Promise.race([run, sleep(10_000).then(() => null)]);
    if (!stopped) await runBounded(LAUNCHER.docker, ['rm', '-f', name], { timeoutMs: MINUTE });
    containers.delete(name);
    return parseWalSamples((stopped ?? (await run)).output);
  };
}

/**
 * The package's own jest launcher. `jest/bin/jest.js` is not an exported
 * subpath, so go through the manifest. A failure here refuses with a category
 * and no path: an absolute path names a user and a machine.
 */
function jestBin() {
  let path;
  try {
    const manifest = createRequire(join(packageDir, 'package.json')).resolve('jest/package.json');
    const { bin } = JSON.parse(readFileSync(manifest, 'utf8'));
    path = join(dirname(manifest), typeof bin === 'string' ? bin : bin.jest);
  } catch {
    path = null;
  }
  if (!path || !existsSync(path)) {
    throw new DiagnosticError(
      diagnostic(
        [INFRASTRUCTURE_CATEGORY.harnessError],
        'the jest launcher could not be resolved in the identity package',
      ),
    );
  }
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
    ? await runBounded(LAUNCHER.jest, [jestBin(), ...step.jestArgs, `--outputFile=${reportPath}`], {
        cwd: packageDir,
        env,
        timeoutMs: 8 * MINUTE,
      })
    : await runBounded(LAUNCHER.pnpm, [...step.pnpmArgs, `--outputFile=${reportPath}`], {
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
  return summarizeJestRun({ step, result, report, walBefore, walAfter, samples });
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
      // Recorded as a failed step; the remaining steps still run. An untyped
      // throw keeps its category and loses its message.
      const entry = diagnosticFromError(error);
      result = { id: step.id, passed: false, error: entry.text, diagnostics: [entry] };
    }
    results.push(result);
    if (result.diagnostics?.length > 0) reportDiagnostics(step.id, result.diagnostics);
    out(
      `[evidence] ${step.id} finished ${new Date().toISOString()}: ${result.passed ? 'PASS' : 'FAIL'}`,
    );
  }
  return results;
}

async function commitSha() {
  const head = await runBounded(LAUNCHER.git, ['rev-parse', 'HEAD'], { timeoutMs: MINUTE });
  return head.exitCode === 0 && head.outcome === PROCESS_OUTCOME.completed
    ? head.output.trim()
    : 'unknown';
}

async function readTopology() {
  try {
    return await topology();
  } catch (error) {
    // Category names only: a topology that could not be read must not put an
    // arbitrary message into the artifact.
    return { error: diagnosticFromError(error).categories.join(',') || 'other' };
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
    reportDiagnostics('environment', [
      diagnostic(
        [INFRASTRUCTURE_CATEGORY.missingEnvironment],
        `missing environment: ${missing.join(', ')}`,
      ),
    ]);
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
    out(`[evidence] aborted: ${diagnosticFromError(error).text}`);
    cleanup();
    process.exit(1);
  });
