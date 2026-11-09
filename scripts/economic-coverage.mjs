// CI-only: three isolated Jest shards, followed by Jest's own merged threshold check.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfigs } from 'jest-config';
import { CoverageReporter } from '@jest/reporters';
const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '..');
const PACKAGE = resolve(ROOT, 'services/economic-service');
const OUTPUT = resolve(ROOT, '.economic-coverage');
const SHARDS = 3;
const DEADLINE_MS = 420_000; // Leave one minute for diagnostics before the 8-minute step cap.
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const jest = resolve(PACKAGE, 'node_modules/jest/bin/jest.js');
const suitePath = (file) => relative(PACKAGE, file).replaceAll('\\', '/');
const directory = (shard) => resolve(OUTPUT, `shard-${shard}`);

export function slowest(suites) {
  return [...suites].sort((a, b) => b.ms - a.ms).slice(0, 10);
}

// Loaded by Jest as an additional reporter. Persist each completion so a deadline
// can show useful diagnostics even when Jest never writes its final JSON result.
export default class ProgressReporter {
  constructor() {
    this.suites = [];
    this.active = null;
  }
  save() {
    const file = resolve(directory(process.env.ECONOMIC_COVERAGE_SHARD), 'progress.json');
    // A deadline may kill Jest during a write. Keep the last complete record readable.
    writeFileSync(`${file}.next`, JSON.stringify({ active: this.active, suites: this.suites }));
    renameSync(`${file}.next`, file);
  }
  onTestStart(test) {
    this.active = suitePath(test.path);
    this.save();
  }
  onTestResult(test, result) {
    this.suites.push({
      file: suitePath(test.path),
      ms: result.perfStats.end - result.perfStats.start,
    });
    this.active = null;
    this.save();
  }
}

function inventory() {
  const result = spawnSync(process.execPath, [jest, '--listTests', '--json', '--runInBand'], {
    cwd: PACKAGE,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error('Economic coverage inventory failed');
  const files = JSON.parse(result.stdout).map(suitePath).sort();
  if (!files.length || new Set(files).size !== files.length)
    throw new Error('Economic coverage inventory empty or duplicated');
  return files;
}

export function validateResults(results, expected) {
  const files = [];
  if (results.length !== SHARDS) throw new Error('Missing economic coverage shard');
  for (const result of results) {
    if (
      result.success !== true ||
      result.numFailedTestSuites !== 0 ||
      result.numFailedTests !== 0 ||
      result.numPendingTestSuites !== 0 ||
      result.numPendingTests !== 0 ||
      !Number.isSafeInteger(result.numPassedTests) ||
      result.numPassedTests <= 0 ||
      result.numTotalTests !== result.numPassedTests ||
      result.numPassedTestSuites !== result.testResults.length ||
      result.numTotalTestSuites !== result.testResults.length ||
      !result.testResults.length
    )
      throw new Error('Economic coverage shard failed, skipped or empty');
    for (const suite of result.testResults) {
      if (suite.status !== 'passed') throw new Error('Economic coverage suite did not pass');
      files.push(suitePath(suite.name));
    }
  }
  if (JSON.stringify(files.sort()) !== JSON.stringify(expected))
    throw new Error('Economic coverage inventory missing or duplicated suites');
}

async function merge() {
  const results = Array.from({ length: SHARDS }, (_, i) =>
    read(resolve(directory(i + 1), 'results.json')),
  );
  validateResults(results, inventory());
  await mergeCoverage(
    Array.from({ length: SHARDS }, (_, i) =>
      read(resolve(directory(i + 1), 'coverage-final.json')),
    ),
  );
  console.log(
    `Economic coverage: ${results.reduce((n, r) => n + r.numPassedTests, 0)} tests; all ${SHARDS} shards complete`,
  );
}

export async function mergeCoverage(maps, output = resolve(OUTPUT, 'merged')) {
  rmSync(output, { recursive: true, force: true });
  // Use the same pinned Jest reporter; no second implementation
  // of Istanbul merging, source maps, percentage rounding or threshold semantics.
  const { globalConfig } = await readConfigs({ _: [], $0: jest }, [PACKAGE]);
  const reporter = new CoverageReporter(
    { ...globalConfig, coverageReporters: ['json', 'text-summary'], coverageDirectory: output },
    { changedFiles: undefined },
  );
  const files = Object.keys(maps[0]).sort();
  if (!files.length || maps.length !== SHARDS)
    throw new Error('Empty or missing economic coverage map');
  for (const coverage of maps) {
    if (JSON.stringify(Object.keys(coverage).sort()) !== JSON.stringify(files))
      throw new Error('Economic coverage maps have different source inventories');
    reporter.onTestResult(null, { coverage });
  }
  const aggregate = {};
  await reporter.onRunComplete(new Set(), aggregate);
  if (reporter.getLastError()) throw reporter.getLastError();
  // Jest logs report-write errors, so require its machine-readable output too.
  if (!Object.keys(read(resolve(output, 'coverage-final.json'))).length)
    throw new Error('Missing merged economic coverage');
}

async function shard() {
  const id = process.env.ECONOMIC_COVERAGE_SHARD;
  if (!['1', '2', '3'].includes(id)) throw new Error('Invalid economic coverage shard');
  const output = directory(id);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'progress.json'), JSON.stringify({ active: null, suites: [] }));
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [
      jest,
      '--coverage',
      '--runInBand',
      '--shard',
      `${id}/${SHARDS}`,
      '--coverageThreshold={}',
      '--coverageReporters=json',
      '--coverageDirectory',
      output,
      '--json',
      '--outputFile',
      resolve(output, 'results.json'),
      '--reporters=default',
      `--reporters=${SELF}`,
    ],
    { cwd: PACKAGE, stdio: 'inherit', detached: true },
  );
  await supervise(child, output, started);
}

export async function supervise(
  child,
  output,
  started = performance.now(),
  deadline = DEADLINE_MS,
) {
  let timedOut = false;
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* Already exited. */
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, deadline);
  const signal = () => {
    timedOut = true;
    stop();
  };
  process.once('SIGTERM', signal);
  process.once('SIGINT', signal);
  const code = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  }).finally(() => {
    clearTimeout(timer);
    process.removeListener('SIGTERM', signal);
    process.removeListener('SIGINT', signal);
  });
  const progress = read(resolve(output, 'progress.json'));
  console.log(`Economic coverage shard: ${Math.round(performance.now() - started)} ms`);
  console.log('Slowest economic suites:', JSON.stringify(slowest(progress.suites)));
  if (timedOut)
    throw new Error(
      `Economic coverage deadline (${deadline} ms); active suite: ${progress.active ?? 'coverage finalization'}`,
    );
  if (code !== 0) throw new Error('Economic coverage shard failed');
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const args = process.argv.slice(2);
  const action = args.length === 1 && { shard, merge }[args[0]];
  if (!action || !['shard', 'merge'].includes(args[0])) {
    console.error('Expected economic coverage action: shard or merge');
    process.exitCode = 1;
  } else
    action().catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
