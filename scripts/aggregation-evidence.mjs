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
 * **A refused calibration still answers.** When anything stops the campaign
 * before it measures — a missing environment name, a jest launcher that cannot
 * be resolved, a stress spec that cannot be read, static contract drift, a
 * temporary directory that cannot be made — a valid calibration request with a
 * writable path still gets its artifact: every requested pair and the control
 * recorded as `INCONCLUSIVE`, every step marked not run, no invented figure, and
 * the single campaign-level cause counted once at campaign scope rather than
 * once per pair. The exit stays non-zero. Writing nothing would make a campaign
 * that refused indistinguishable from one that was never launched, which is
 * exactly the confusion ADR-055 § 6 cannot afford in its dataset.
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
  PG_LIBPQ_ENV,
  PROCESS_OUTCOME,
  STRESS,
  checkedOutput,
  countCategories,
  diagnostic,
  diagnosticFromError,
  formatCalibrationReport,
  formatReport,
  measureProbe,
  missingCampaignEnv,
  missingEnvironmentDiagnostic,
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
const MINUTE = 60_000;

const out = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Prints why a step could not produce evidence, as counts over the categories
 * the step already attached — never a child process's stdout or stderr, which
 * can carry URLs, credentials, rows and identifiers, and never a re-reading of
 * the aggregate text printed beside them.
 */
function reportDiagnostics(label, diagnostics, log = out) {
  const counts = Object.entries(countCategories(diagnostics)).filter(([, count]) => count > 0);
  log(
    `[evidence] ${label}: ${
      counts.map(([name, count]) => `${name}=${count}`).join(' ') || 'unclassified=0'
    }`,
  );
  for (const entry of diagnostics) log(`[evidence]   problem: ${entry.text}`);
}

const children = new Set();
const containers = new Set();
let workDir;

function cleanup() {
  for (const child of children) child.kill('SIGKILL');
  for (const name of containers) spawn('docker', ['rm', '-f', name], { stdio: 'ignore' });
  if (workDir) rmSync(workDir, { recursive: true, force: true });
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
  ...PG_LIBPQ_ENV.flatMap((name) => ['-e', name]),
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

/**
 * An OS error code, or nothing. A fixed short token is safe to print; an
 * exception's message is not — it carries the path it failed on, and a report
 * path names a user, a machine and sometimes a mount.
 */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,15}$/;

/**
 * Saves the artifact, or refuses without naming the target. Returns whether it
 * was written; the caller's exit code never depends on the difference between a
 * missing directory and a read-only one.
 */
function saveReport(reportPath, text, write, log) {
  try {
    write(reportPath, text);
    return true;
  } catch (error) {
    const code = String(error?.code ?? '');
    log(`[evidence] could not write the report: ${ERROR_CODE.test(code) ? code : 'error'}`);
    return false;
  }
}

/**
 * How many contract findings the one campaign diagnostic quotes, and how much
 * of each. Bounded on purpose: an artifact is a record, not a transcript.
 */
const CONTRACT_FINDINGS_SHOWN = 5;
const CONTRACT_FINDING_CHARS = 200;

/**
 * Static contract drift as **one** campaign event.
 *
 * A contract check answers with one finding per broken clause, and a single
 * edit to the spec breaks several at once. Counting each finding as its own
 * `harnessError` would say the campaign failed five times when it refused once,
 * and that number would go straight into ADR-055 section 6's dataset. So the
 * findings become one diagnostic. Its text quotes the repository's *own* fixed
 * problem sentences — which interpolate expected constants, step ids and counts,
 * never spec source and never a path — bounded in number and in length, and
 * passed through `redact` as a second line of defence.
 */
function contractDiagnostic(findings) {
  const shown = findings
    .slice(0, CONTRACT_FINDINGS_SHOWN)
    .map((finding) => redact(String(finding)).slice(0, CONTRACT_FINDING_CHARS));
  return diagnostic(
    [INFRASTRUCTURE_CATEGORY.harnessError],
    `the static campaign contract failed with ${findings.length} finding(s): ` +
      `${shown.join('; ')}${findings.length > shown.length ? '; and more' : ''}`,
  );
}

/**
 * What the artifact says about the machine when nothing was read from it.
 *
 * A refused campaign never opens a connection, so it has no topology. Printing
 * a plausible one would be the same lie as printing a probe figure.
 */
const UNMEASURED_TOPOLOGY = Object.freeze({ measured: 'no' });

/**
 * The two exit codes a refusal may keep, decided by the *first* thing that
 * refused. Both are non-zero; they differ only in which thing has to be fixed.
 *
 * - `2` — the campaign's prerequisites are not in place: a missing environment
 *   name, a launcher that will not resolve, a spec that cannot be read, a
 *   temporary directory that cannot be made. Fix the machine.
 * - `1` — the repository's own static contract no longer describes the proof
 *   this harness measures. Fix the code. This is the code the contract check
 *   has always returned, and it stays.
 */
const PREREQUISITE_EXIT = 2;
const CONTRACT_EXIT = 1;

/**
 * Everything that must hold before a campaign may measure anything, in one
 * place and in one pass: the environment names, the jest launcher, the stress
 * spec, the plan, the static contract, and last the temporary work directory.
 *
 * Returns either the **validated plan** the measuring half will run — built and
 * checked exactly once, here, never again — or campaign-scoped diagnostics and
 * the exit code the refusal keeps. Nothing in here opens a connection, starts
 * Docker, spawns a measurement or reads an environment *value*: a refusal must
 * not become the one place a credential leaks.
 *
 * Everything that can still be checked is checked, not only the first failure,
 * so one refusal describes as much of the situation as it can. The work
 * directory is created last, so a campaign that was going to refuse never
 * leaves one behind.
 */
function prepareCampaign({ mode, pairs, env, resolveJestBin, readSpec, makeWorkDir, log }) {
  const problems = [];
  const codes = [];
  const refuse = (entry, code) => {
    problems.push(entry);
    codes.push(code);
  };
  const setupFailure = (text) =>
    diagnostic([INFRASTRUCTURE_CATEGORY.harnessError], `the campaign could not start: ${text}`);

  const missing = missingCampaignEnv(env);
  if (missing.length > 0) refuse(missingEnvironmentDiagnostic(missing), PREREQUISITE_EXIT);
  try {
    resolveJestBin();
  } catch (error) {
    // An untyped throw keeps `harnessError` and loses its message.
    refuse(diagnosticFromError(error), PREREQUISITE_EXIT);
  }

  let specSource;
  try {
    specSource = readSpec();
  } catch {
    // The errno, the path and the message each name a machine; the category
    // names only what happened, so the exception is read no further.
    refuse(setupFailure('the aggregation stress spec could not be read'), PREREQUISITE_EXIT);
  }

  let plan = null;
  if (specSource !== undefined) {
    try {
      plan = mode === 'calibrate' ? planCalibrationRun({ pairs }) : planEvidenceRun();
    } catch {
      refuse(setupFailure('the campaign plan could not be built'), PREREQUISITE_EXIT);
    }
  }

  if (plan) {
    const findings =
      mode === 'calibrate'
        ? validateCalibrationContract({ specSource, plan, pairs })
        : validateEvidenceContract({ specSource, plan });
    if (findings.length > 0) {
      for (const finding of findings) log(`[evidence] contract: ${finding}`);
      refuse(contractDiagnostic(findings), CONTRACT_EXIT);
      plan = null;
    }
  }

  if (problems.length > 0) return { problems, exitCode: codes[0], plan: null };

  try {
    workDir = makeWorkDir();
  } catch {
    return {
      problems: [setupFailure('the temporary campaign directory could not be created')],
      exitCode: PREREQUISITE_EXIT,
      plan: null,
    };
  }
  return { problems: [], exitCode: 0, plan };
}

/**
 * Removes the campaign's temporary directory, after a refusal as after a run.
 *
 * It never throws: this runs in a `finally`, and a directory a straggling child
 * still holds must not replace the exit code the campaign already decided — nor
 * put an OS message carrying that path anywhere.
 */
function releaseWorkDir() {
  if (!workDir) return;
  try {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  } catch {
    // Left set on purpose, so the entry point's `cleanup` tries once more.
    // Either way the path is never said out loud.
  }
}

/** The commit, or `unknown`: provenance may never be why a refusal loses its artifact. */
async function commitFor(readCommit) {
  try {
    return await readCommit();
  } catch {
    return 'unknown';
  }
}

/**
 * Renders and writes the one artifact a refused calibration owes its caller,
 * then keeps the refusal's exit code.
 *
 * The legacy evidence report has no campaign-scoped section and its schema is
 * established, so that mode refuses without an artifact — unchanged.
 */
async function refuseCampaign({
  mode,
  pairs,
  reportPath,
  problems,
  exitCode,
  writeReport,
  readCommit,
  now,
  log,
}) {
  reportDiagnostics('preflight', problems, log);
  if (mode !== 'calibrate') return exitCode;
  const text = formatCalibrationReport({
    meta: { commit: await commitFor(readCommit), generatedAt: now().toISOString() },
    topology: UNMEASURED_TOPOLOGY,
    summary: summarizeCalibration({ pairs, results: [], preflight: problems }),
  });
  log(`\n${text}`);
  saveReport(reportPath, text, writeReport, log);
  return exitCode;
}

/**
 * The measuring half. It receives the plan preparation already built and
 * validated, so nothing is planned or re-checked here: this function's first
 * statement is the campaign's first measurement.
 */
async function runMeasuredCampaign({
  mode,
  pairs,
  plan,
  reportPath,
  writeReport,
  readCommit,
  now,
  log,
}) {
  const topo = await readTopology();
  log(`[evidence] topology ${JSON.stringify(topo)}`);
  if (mode === 'calibrate') {
    log(
      `[evidence] calibration: ${pairs} pair(s); each is one ${plan[1].seconds} s probe immediately ` +
        `followed by one unfiltered \`pnpm run ${STRESS.rootScript}\`. No threshold is applied.`,
    );
  }

  const results = await runPlan(plan);
  const meta = { commit: await commitFor(readCommit), generatedAt: now().toISOString() };
  const text =
    mode === 'calibrate'
      ? formatCalibrationReport({
          meta,
          topology: topo,
          summary: summarizeCalibration({ pairs, results }),
        })
      : formatReport({ meta, topology: topo, results });

  log(`\n${text}`);
  if (!saveReport(reportPath, text, writeReport, log)) return 1;
  // Report-only means this is not wired into a quality gate, not that a bad
  // sample is painted green: an invalid probe, a failed suite, a process that
  // could not start or a broken topology all still exit non-zero.
  return results.every((result) => result.passed) && !topo.error ? 0 : 1;
}

/**
 * The CLI as a value: argv and the environment in, an exit code out. Exported
 * so the refusal paths are testable exactly as the CLI runs them, with no
 * Docker, no PostgreSQL and no live campaign — importing this module starts
 * nothing, because the entry point below is guarded.
 *
 * **Why a refused calibration still writes its artifact.** A caller that asked
 * for N pairs and gave a writable path asked a question; answering with no file
 * at all is indistinguishable from never having been asked, and the next reader
 * cannot tell a campaign that refused from one that was never launched. So the
 * refusal is *rendered*: every requested pair stays in the denominator as
 * `INCONCLUSIVE` with nothing available, every step is marked not run, no figure
 * is invented, and the one campaign-level cause is counted once at campaign
 * scope rather than copied into each row. The exit code stays non-zero — an
 * artifact is a record of a refusal, never a pass.
 *
 * **Where the boundary is.** Everything that can refuse before a measurement
 * exists lives in `prepareCampaign`, and every one of its refusals goes through
 * `refuseCampaign`. `runMeasuredCampaign` is unreachable after any of them and
 * its first statement is the campaign's first measurement, so the top-level
 * catch at the entry point covers only failures that happened *while measuring*.
 */
export async function runEvidenceCli({ argv = [], env = process.env, deps = {} } = {}) {
  const {
    resolveJestBin = jestBin,
    readSpec = () => readFileSync(join(packageDir, STRESS.spec), 'utf8'),
    makeWorkDir = () => mkdtempSync(join(tmpdir(), 'aggregation-evidence-')),
    writeReport = (path, text) => writeFileSync(path, text),
    measureCampaign = runMeasuredCampaign,
    readCommit = commitSha,
    now = () => new Date(),
    log = out,
  } = deps;

  const parsed = parseEvidenceArgs(argv);
  if (parsed.error) {
    // No valid output target exists yet, so there is nothing to write to and
    // nowhere to record this: usage and a refusal are the whole answer.
    log(`[evidence] ${parsed.error}`);
    log(parsed.usage);
    return 2;
  }
  const { mode, pairs, reportPath } = parsed;

  try {
    const prepared = prepareCampaign({
      mode,
      pairs,
      env,
      resolveJestBin,
      readSpec,
      makeWorkDir,
      log,
    });
    if (prepared.problems.length > 0) {
      return await refuseCampaign({
        mode,
        pairs,
        reportPath,
        problems: prepared.problems,
        exitCode: prepared.exitCode,
        writeReport,
        readCommit,
        now,
        log,
      });
    }
    return await measureCampaign({
      mode,
      pairs,
      plan: prepared.plan,
      reportPath,
      writeReport,
      readCommit,
      now,
      log,
    });
  } finally {
    // After a refusal as after a run: nothing temporary outlives the campaign.
    releaseWorkDir();
  }
}

/** True only when this file is the process's entry point, not an import. */
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      out(`[evidence] ${signal} received; stopping children and removing temporary files`);
      cleanup();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
  runEvidenceCli({ argv: process.argv.slice(2) })
    .then((code) => {
      cleanup();
      process.exit(code);
    })
    .catch((error) => {
      out(`[evidence] aborted: ${diagnosticFromError(error).text}`);
      cleanup();
      process.exit(1);
    });
}
