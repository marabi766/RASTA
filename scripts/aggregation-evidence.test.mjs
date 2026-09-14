import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CALIBRATION_OUTCOMES,
  CONTROL_SECONDS,
  CONTROL_SQL,
  INFRASTRUCTURE_CATEGORY_NAMES,
  MAX_CALIBRATION_PAIRS,
  MIN_CALIBRATION_PAIRS,
  NAMED_PROOF,
  NAMED_RUNS,
  PROBE_SECONDS,
  STRESS,
  WAL_PROBE_SQL,
  calibrationProbeId,
  calibrationStressId,
  classifyFailures,
  classifyInfrastructureProblems,
  distribution,
  formatCalibrationReport,
  formatReport,
  namedProofPattern,
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
  validateProbeSql,
} from './aggregation-evidence-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specSource = readFileSync(join(root, STRESS.packageDir, STRESS.spec), 'utf8');
const fullName = [...NAMED_PROOF.describePath, NAMED_PROOF.title].join(' ');

const PGBENCH_OUTPUT = `pgbench (16.4 (Debian 16.4-1.pgdg110+2))
progress: 1.0 s, 30.0 tps, lat 33.100 ms stddev 2.000, 0 failed
progress: 2.0 s, 0.0 tps, lat 0.000 ms stddev 0.000, 0 failed
progress: 3.0 s, 0.0 tps, lat 0.000 ms stddev 0.000, 0 failed
progress: 4.0 s, 29.0 tps, lat 34.000 ms stddev 1.000, 0 failed
progress: 5.0 s, 0.0 tps, lat 0.000 ms stddev 0.000, 0 failed
transaction type: /probe/probe-before.sql
scaling factor: 1
query mode: simple
number of clients: 1
number of threads: 1
maximum number of tries: 1
duration: 5 s
number of transactions actually processed: 59
number of failed transactions: 0 (0.000%)
latency average = 84.000 ms
latency stddev = 3.000 ms
initial connection time = 4.000 ms
tps = 11.800000 (without initial connection time)
`;

// ---------------------------------------------------------------------------
// The proof and the plan

test('the name pattern selects exactly the named proof and not its sibling 500-write proof', () => {
  const pattern = new RegExp(namedProofPattern());
  assert.ok(pattern.test(fullName));
  assert.ok(
    !pattern.test(
      `${NAMED_PROOF.describePath.join(' ')} exactly 500 concurrent matching refusals through the real endpoint become one row with occurrenceCount 500`,
    ),
  );
  assert.ok(!pattern.test(`${fullName} again`));
  assert.ok(!pattern.test(fullName.replace('1..500', '1x.500')), 'dots are literal');
});

test('the plan: control, probe, five fresh named runs, one full project, probe', () => {
  const plan = planEvidenceRun();
  assert.deepEqual(
    plan.map((step) => step.id),
    [
      'control',
      'probe-before',
      'named-1',
      'named-2',
      'named-3',
      'named-4',
      'named-5',
      'full-project',
      'probe-after',
    ],
  );
  assert.equal(plan.filter((step) => step.kind === 'jest-named').length, NAMED_RUNS);
  assert.deepEqual(plan.find((step) => step.id === 'full-project').pnpmArgs, [
    'run',
    'test:aggregation-stress',
    '--',
    '--json',
  ]);
  assert.deepEqual(validateEvidenceContract({ specSource, plan }), []);
});

test('the contract catches a changed stress constant, a filtered full run and a missing probe', () => {
  const plan = planEvidenceRun();
  const expectProblem = (inputs, pattern) => {
    const problems = validateEvidenceContract(inputs);
    assert.ok(
      problems.some((problem) => pattern.test(problem)),
      `no problem matched ${pattern}; got:\n${problems.join('\n') || '(none)'}`,
    );
  };
  // Replaces the first occurrence inside the named proof (or anywhere before it for file constants).
  const swap = (from, to) => {
    const at = specSource.indexOf(from, Math.max(0, specSource.indexOf(NAMED_PROOF.title)));
    const index = at === -1 ? specSource.indexOf(from) : at;
    assert.ok(index !== -1, `fixture text not found: ${from}`);
    return {
      specSource: specSource.slice(0, index) + to + specSource.slice(index + from.length),
      plan,
    };
  };
  expectProblem(
    swap('const LANES_PER_CLIENT = 2;', 'const LANES_PER_CLIENT = 1;'),
    /LANES_PER_CLIENT = 2/,
  );
  expectProblem(swap('const TOTAL = 500;', 'const TOTAL = 400;'), /TOTAL = 500/);
  expectProblem(
    swap(
      'timeoutMs: 5000, windowSeconds: WINDOW_SECONDS',
      'timeoutMs: 15000, windowSeconds: WINDOW_SECONDS',
    ),
    /timeoutMs: 5000/,
  );
  expectProblem(
    swap('const WINDOW_SECONDS = 60;', 'const WINDOW_SECONDS = 120;'),
    /WINDOW_SECONDS = 60/,
  );
  expectProblem(
    swap('        await independentStore(),\n      ];', '      ];'),
    /independentStore/,
  );
  expectProblem(swap(NAMED_PROOF.title, `${NAMED_PROOF.title} (renamed)`), /appears 0 time/);
  expectProblem({ specSource: `jest.retryTimes(2);\n${specSource}`, plan }, /retries/);

  expectProblem({ specSource, plan: plan.filter((step) => step.id !== 'named-5') }, /4 named runs/);
  expectProblem(
    { specSource, plan: plan.filter((step) => step.id !== 'probe-after') },
    /after every jest step/,
  );
  expectProblem(
    { specSource, plan: plan.filter((step) => step.id !== 'probe-before') },
    /before every jest step/,
  );
  const withNoTests = structuredClone(plan);
  withNoTests[2].jestArgs.push('--passWithNoTests');
  expectProblem({ specSource, plan: withNoTests }, /passes with no tests/);
  const filtered = structuredClone(plan);
  filtered.find((step) => step.id === 'full-project').pnpmArgs.push('--testNamePattern=x');
  expectProblem({ specSource, plan: filtered }, /unfiltered/);
  const wideProjects = structuredClone(plan);
  wideProjects[3].jestArgs.splice(2, 0, 'integration');
  expectProblem({ specSource, plan: wideProjects }, /exactly the aggregation-stress project/);
  const txid = structuredClone(plan);
  txid[1].sql = 'SELECT txid_current();';
  expectProblem({ specSource, plan: txid }, /txid_current/);
});

// ---------------------------------------------------------------------------
// The WAL probe

test('probe SQL: one transactional logical message is accepted; txid_current, blocks and read-only are refused', () => {
  assert.deepEqual(validateProbeSql(WAL_PROBE_SQL), []);
  assert.deepEqual(validateProbeSql(CONTROL_SQL, { control: true }), []);
  assert.ok(validateProbeSql('SELECT txid_current();').length > 0);
  assert.ok(validateProbeSql('SELECT 1;').length > 0, 'read-only is not a WAL probe');
  assert.ok(validateProbeSql("SELECT pg_logical_emit_message(false, 'a', 'b');").length > 0);
  assert.ok(validateProbeSql(`BEGIN; ${WAL_PROBE_SQL} COMMIT;`).length > 0);
  assert.ok(validateProbeSql(`${WAL_PROBE_SQL} ${WAL_PROBE_SQL}`).length > 0);
  assert.deepEqual(pgbenchArgs({ seconds: 60, scriptPath: '/probe/p.sql' }), [
    '-n',
    '-c',
    '1',
    '-j',
    '1',
    '-T',
    '60',
    '-P',
    '1',
    '-f',
    '/probe/p.sql',
  ]);
});

test('pgbench output: totals, and zero-commit intervals as stalls', () => {
  const parsed = parsePgbenchOutput(PGBENCH_OUTPUT);
  assert.equal(parsed.transactions, 59);
  assert.equal(parsed.failed, 0);
  assert.equal(parsed.latencyAverageMs, 84);
  assert.equal(parsed.tps, 11.8);
  assert.equal(parsed.progressIntervals, 5);
  assert.equal(parsed.zeroCommitIntervals, 3);
  assert.equal(parsed.longestZeroCommitSeconds, 2);
  assert.equal(parsed.minIntervalTps, 0);
});

test('pg_stat_wal readings parse only in the expected shape', () => {
  assert.deepEqual(parseWalStat('\n1200|300|310|99999\n'), {
    walRecords: 1200,
    walSync: 300,
    walWrite: 310,
    walBytes: 99999,
  });
  assert.throws(() => parseWalStat('ERROR: permission denied'), /expected shape/);
});

test('a probe is valid only near one wal_sync per commit, and a control only near zero', () => {
  const pgbench = {
    ...parsePgbenchOutput(PGBENCH_OUTPUT),
    progressIntervals: 60,
    transactions: 1500,
  };
  const at = (walRecords, walSync) => ({ walRecords, walSync, walWrite: 0, walBytes: 0 });
  const good = summarizeProbe({ pgbench, before: at(10, 10), after: at(3100, 1540), seconds: 60 });
  assert.equal(good.valid, true, good.problems.join('; '));
  assert.equal(good.walSyncPerTransaction, 1.02);
  assert.equal(good.walSyncPerSecond, 25.5);

  const noWal = summarizeProbe({ pgbench, before: at(10, 10), after: at(20, 12), seconds: 60 });
  assert.equal(noWal.valid, false);
  assert.ok(noWal.problems.some((p) => /not approximately one/.test(p)));
  assert.ok(noWal.problems.some((p) => /message \+ commit/.test(p)));

  const noisy = summarizeProbe({ pgbench, before: at(10, 10), after: at(9000, 3000), seconds: 60 });
  assert.equal(noisy.valid, false);

  const failed = summarizeProbe({
    pgbench: { ...pgbench, failed: 2 },
    before: at(10, 10),
    after: at(3100, 1540),
    seconds: 60,
  });
  assert.equal(failed.valid, false);

  const control = { ...pgbench, transactions: 40000, progressIntervals: 10 };
  assert.equal(
    summarizeProbe({
      pgbench: control,
      before: at(0, 0),
      after: at(5, 3),
      seconds: 10,
      control: true,
    }).valid,
    true,
  );
  assert.equal(
    summarizeProbe({
      pgbench: control,
      before: at(0, 0),
      after: at(90000, 40000),
      seconds: 10,
      control: true,
    }).valid,
    false,
  );
});

test('burst summary: active span, its sync rate and the longest no-sync stretch inside it', () => {
  const samples = parseWalSamples(
    [
      '100.000|10', // idle wait for a fresh window
      '101.000|10',
      '102.000|35',
      '103.000|60',
      '104.000|60',
      '105.000|60',
      '106.000|90',
      '107.000|91', // cleanup
      'not a sample',
    ].join('\n'),
  );
  assert.equal(samples.length, 8);
  assert.deepEqual(summarizeBurst(samples), {
    samples: 8,
    activeSeconds: 5,
    syncsPerSecond: 16,
    longestNoSyncSeconds: 2,
  });
  assert.equal(summarizeBurst(parseWalSamples('1.0|5\n2.0|5')).syncsPerSecond, null);
});

// ---------------------------------------------------------------------------
// Jest reports

const assertion = (name, status, extra = {}) => ({
  fullName: name,
  status,
  duration: 20000,
  ...extra,
});
const report = (assertions, overrides = {}) => {
  const count = (status) => assertions.filter((a) => a.status === status).length;
  return {
    success: count('failed') === 0,
    numTotalTestSuites: 1,
    numPassedTestSuites: count('failed') === 0 ? 1 : 0,
    numFailedTestSuites: count('failed') === 0 ? 0 : 1,
    numPendingTestSuites: 0,
    numRuntimeErrorTestSuites: 0,
    numTotalTests: assertions.length,
    numPassedTests: count('passed'),
    numFailedTests: count('failed'),
    numPendingTests: count('pending'),
    testResults: [
      {
        status: count('failed') === 0 ? 'passed' : 'failed',
        message: '',
        assertionResults: assertions,
      },
    ],
    ...overrides,
  };
};
const others = Array.from({ length: 21 }, (_, i) => assertion(`other test ${i}`, 'pending'));

test('a named run must run exactly the named proof, with the other 21 filtered', () => {
  const ok = summarizeJestReport(report([assertion(fullName, 'passed'), ...others]), {
    expectNamed: true,
  });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.tests, { total: 22, passed: 1, failed: 0, skipped: 21 });
  assert.equal(ok.namedDurationMs, 20000);

  const none = summarizeJestReport(report(others), { expectNamed: true });
  assert.ok(none.problems.some((p) => /ran 0 test/.test(p)));

  const two = summarizeJestReport(
    report([assertion(fullName, 'passed'), assertion('x', 'passed')]),
    {
      expectNamed: true,
    },
  );
  assert.ok(two.problems.some((p) => /ran 2 test/.test(p)));

  assert.ok(summarizeJestReport(null).problems.includes('no jest report'));
  assert.ok(summarizeJestReport(report([])).problems.includes('jest collected no test'));
});

test('failures are classified into counts, never echoed', () => {
  const timeout =
    'PrismaClientKnownRequestError: Code: `57014`. Message: `ERROR: canceling statement due to statement timeout`';
  const secondRow =
    'expect(received).toHaveLength(expected)\n    > 337 |       expect(results.filter((result) => result.created)).toHaveLength(1);';
  const sequence =
    'expect(received).toEqual(expected)\n    > 339 |       expect(results.map((result) => result.occurrenceCount).sort((a, b) => a - b)).toEqual(';
  const jestTimeout = 'thrown: "Exceeded timeout of 120000 ms for a test.';
  const db = "PrismaClientInitializationError: Can't reach database server";
  const counts = classifyFailures([
    timeout,
    secondRow,
    sequence,
    jestTimeout,
    db,
    'something else',
  ]);
  assert.deepEqual(counts, {
    sqlstate57014: 1,
    jestTimeout: 1,
    secondRowOrWindowCrossing: 1,
    countSequence: 1,
    finalRow: 0,
    otherDatabaseError: 1,
    other: 1,
  });

  const failed = summarizeJestReport(
    report([
      assertion(fullName, 'failed', {
        failureMessages: [`USR_01ABCDEFGH_01J0000000000000000000000 ${timeout}`],
      }),
      ...others,
    ]),
    { expectNamed: true },
  );
  assert.equal(failed.failures.sqlstate57014, 1);
  assert.ok(!JSON.stringify(failed).includes('USR_'), 'no failure text is kept');
});

test('redaction removes connection strings, tokens and test identifiers', () => {
  const text = redact(
    'postgresql://rasta_identity:pw@localhost:5432/db USR_ABCDE12345_01J8Z3K4M5N6P7Q8R9S0T1V2W3 eyJhbGciOi.eyJzdWIi.sig password=hunter2 ok',
  );
  assert.ok(
    !/rasta_identity|pw@|ABCDE12345|01J8Z3K4M5N6P7Q8R9S0T1V2W3|eyJ|hunter2/.test(text),
    text,
  );
  assert.ok(text.endsWith('ok'));
});

test('the report carries aggregates and fails when any step failed', () => {
  const probe = summarizeProbe({
    pgbench: { ...parsePgbenchOutput(PGBENCH_OUTPUT), progressIntervals: 60, transactions: 1500 },
    before: { walRecords: 0, walSync: 0, walWrite: 0, walBytes: 0 },
    after: { walRecords: 3000, walSync: 1500, walWrite: 0, walBytes: 0 },
    seconds: PROBE_SECONDS,
  });
  const jestRun = (id, passed) => ({
    id,
    passed,
    exitCode: passed ? 0 : 1,
    timedOut: false,
    startedAt: '2026-09-14T00:00:00.000Z',
    endedAt: '2026-09-14T00:01:00.000Z',
    wallSeconds: 60,
    summary: summarizeJestReport(
      report([assertion(fullName, passed ? 'passed' : 'failed'), ...others]),
      {
        expectNamed: true,
      },
    ),
    wal: { walSyncDelta: 600, walSyncPerSecond: 10 },
    burst: { samples: 60, activeSeconds: 22, syncsPerSecond: 24, longestNoSyncSeconds: 1 },
  });
  const results = [
    { id: 'probe-before', passed: true, probe },
    ...[1, 2, 3, 4, 5].map((i) => jestRun(`named-${i}`, i !== 3)),
    { ...jestRun('full-project', true), burst: null },
    { id: 'probe-after', passed: true, probe },
  ];
  const text = formatReport({
    meta: { commit: 'abc', runUrl: 'https://example.invalid/run', generatedAt: 'now' },
    topology: { server_version: '16.4' },
    results,
  });
  assert.match(text, /probe-before .*valid=yes .*transactions=1500/);
  assert.match(text, /named-3: result=FAIL/);
  assert.match(text, /tests passed\/failed\/skipped\/total=1\/0\/21\/22/);
  assert.match(text, /burst_wal_sync_per_s=24/);
  assert.match(text, /verdict: FAIL \(named-3\)/);
  assert.match(text, /control .*: not run/);

  const broken = formatReport({
    meta: { commit: 'abc', runUrl: 'local', generatedAt: 'now' },
    topology: {},
    results: [
      { id: 'control', passed: false, error: 'docker not found' },
      { id: 'named-1', passed: false, error: 'jest launcher not found' },
    ],
  });
  assert.match(broken, /control .*: valid=NO harness error: docker not found/);
  assert.match(broken, /named-1: result=FAIL harness error: jest launcher not found/);
  assert.match(broken, /verdict: FAIL \(control, named-1\)/);
});

// ---------------------------------------------------------------------------
// Paired calibration (ADR-055): CLI, plan, contract, distributions, safety

test('calibration CLI: the legacy invocation still means the evidence campaign', () => {
  assert.deepEqual(parseEvidenceArgs(['report.txt']), {
    mode: 'evidence',
    reportPath: 'report.txt',
  });
  assert.deepEqual(parseEvidenceArgs(['--calibrate', '--pairs', '3', 'report.txt']), {
    mode: 'calibrate',
    pairs: 3,
    reportPath: 'report.txt',
  });
  // Order is not significant, and `--pairs=N` is accepted.
  assert.deepEqual(parseEvidenceArgs(['report.txt', '--calibrate', '--pairs=4']), {
    mode: 'calibrate',
    pairs: 4,
    reportPath: 'report.txt',
  });
  // `pnpm run calibrate:aggregation-stress -- --pairs 2 out.txt` forwards the
  // separator itself; it is skipped, not mistaken for an option.
  assert.deepEqual(parseEvidenceArgs(['--calibrate', '--', '--pairs', '2', 'out.txt']), {
    mode: 'calibrate',
    pairs: 2,
    reportPath: 'out.txt',
  });
  assert.deepEqual(parseEvidenceArgs(['--', 'out.txt']), {
    mode: 'evidence',
    reportPath: 'out.txt',
  });
});

test('calibration CLI: every invalid form is refused, with usage and never a coerced value', () => {
  const bad = (argv, pattern) => {
    const parsed = parseEvidenceArgs(argv);
    assert.ok(parsed.error, `expected a refusal for ${JSON.stringify(argv)}`);
    assert.match(parsed.error, pattern);
    assert.match(parsed.usage, /--calibrate --pairs/);
    assert.equal(parsed.mode, undefined, 'a refusal never yields a mode');
    assert.equal(parsed.pairs, undefined, 'a refusal never yields a pair count');
  };
  bad([], /report path is required/);
  bad(['--calibrate'], /report path is required/);
  bad(['--calibrate', '--pairs', '2'], /report path is required/);
  bad(['a.txt', 'b.txt'], /expected one report path, got 2/);
  bad(['--calibrate', '--pairs', 'report.txt'], /report path is required/);
  bad(['--calibrate', '--pairs'], /--pairs needs a value/);
  bad(['--calibrate', '--pairs=', 'r.txt'], /--pairs needs a value/);
  bad(['--pairs', '2', 'r.txt'], /--pairs requires --calibrate/);
  bad(['--calibrate', 'r.txt'], /--calibrate requires --pairs/);
  bad(['--calibrate', '--calibrate', '--pairs', '2', 'r.txt'], /--calibrate given more than once/);
  bad(['--calibrate', '--pairs', '2', '--pairs', '3', 'r.txt'], /--pairs given more than once/);
  bad(['--calibrate', '--pairs=2', '--pairs=3', 'r.txt'], /--pairs given more than once/);
  bad(['--calibrate', '--pairs', '2.5', 'r.txt'], /positive integer/);
  bad(['--calibrate', '--pairs', '-1', 'r.txt'], /positive integer/);
  // `--pairs` never swallows a following option as its value.
  bad(['--pairs', '--calibrate', 'r.txt'], /--pairs needs a value/);
  bad(['--calibrate', '--pairs', 'three', 'r.txt'], /positive integer/);
  bad(['--calibrate', '--pairs', '0x2', 'r.txt'], /positive integer/);
  bad(['--verbose', 'r.txt'], /unknown option/);
  bad(['-r', 'r.txt'], /unknown option/);
  // A report path may not look like a flag: it would be swallowed as one.
  bad(['--calibrate', '--pairs', '2', '--out.txt'], /unknown option/);
});

test('calibration CLI: the pair count honours its bounds, one below and one above', () => {
  const at = (n) => parseEvidenceArgs(['--calibrate', '--pairs', String(n), 'r.txt']);
  assert.equal(at(MIN_CALIBRATION_PAIRS).pairs, MIN_CALIBRATION_PAIRS);
  assert.equal(at(MAX_CALIBRATION_PAIRS).pairs, MAX_CALIBRATION_PAIRS);
  assert.match(at(MIN_CALIBRATION_PAIRS - 1).error, /between/);
  assert.match(at(MAX_CALIBRATION_PAIRS + 1).error, /between/);

  // The planner refuses the same values rather than coercing them.
  assert.doesNotThrow(() => planCalibrationRun({ pairs: MIN_CALIBRATION_PAIRS }));
  assert.doesNotThrow(() => planCalibrationRun({ pairs: MAX_CALIBRATION_PAIRS }));
  assert.throws(() => planCalibrationRun({ pairs: MIN_CALIBRATION_PAIRS - 1 }), /between/);
  assert.throws(() => planCalibrationRun({ pairs: MAX_CALIBRATION_PAIRS + 1 }), /between/);
  for (const value of [undefined, null, '3', 2.5, NaN, Infinity, -1]) {
    assert.throws(() => planCalibrationRun({ pairs: value }), /calibration pairs must be/);
  }
  assert.throws(() => planCalibrationRun(), /calibration pairs must be/);
});

test('calibration plan: one control, then probe/stress pairs back to back', () => {
  const plan = planCalibrationRun({ pairs: 3 });
  assert.deepEqual(
    plan.map((step) => step.id),
    [
      'control',
      'pair-1-probe',
      'pair-1-stress',
      'pair-2-probe',
      'pair-2-stress',
      'pair-3-probe',
      'pair-3-stress',
    ],
  );
  assert.equal(plan.filter((step) => step.control === true).length, 1);
  assert.equal(plan[0].seconds, CONTROL_SECONDS);
  for (const pair of [1, 2, 3]) {
    const at = plan.findIndex((step) => step.id === calibrationProbeId(pair));
    assert.equal(plan[at].sql, WAL_PROBE_SQL);
    assert.equal(plan[at].seconds, PROBE_SECONDS);
    // Adjacency is the point of the mode: nothing sits between the two.
    assert.equal(plan[at + 1].id, calibrationStressId(pair));
    assert.deepEqual(plan[at + 1].pnpmArgs, ['run', STRESS.rootScript, '--', '--json']);
  }
  assert.ok(!plan.some((step) => step.kind === 'jest-named'), 'no name-filtered run');
  assert.deepEqual(validateCalibrationContract({ specSource, plan, pairs: 3 }), []);
});

test('calibration plan: the legacy evidence plan is untouched', () => {
  const plan = planEvidenceRun();
  assert.deepEqual(
    plan.map((step) => step.id),
    [
      'control',
      'probe-before',
      'named-1',
      'named-2',
      'named-3',
      'named-4',
      'named-5',
      'full-project',
      'probe-after',
    ],
  );
  assert.equal(plan.filter((step) => step.kind === 'jest-named').length, NAMED_RUNS);
  assert.deepEqual(validateEvidenceContract({ specSource, plan }), []);
  // And the two plans are not confusable by the other mode's contract.
  assert.ok(validateCalibrationContract({ specSource, plan, pairs: 1 }).length > 0);
  assert.ok(
    validateEvidenceContract({ specSource, plan: planCalibrationRun({ pairs: 2 }) }).length > 0,
  );
});

test('calibration contract: reordering, inserting, filtering or retrying a pair is caught', () => {
  const pairs = 2;
  const base = planCalibrationRun({ pairs });
  const expectProblem = (plan, pattern) => {
    const problems = validateCalibrationContract({ specSource, plan, pairs });
    assert.ok(
      problems.some((problem) => pattern.test(problem)),
      `no problem matched ${pattern}; got:\n${problems.join('\n') || '(none)'}`,
    );
  };

  // A step between a probe and its suite makes the sample describe other conditions.
  const wedged = structuredClone(base);
  wedged.splice(2, 0, { id: 'pair-1-extra', kind: 'probe', sql: WAL_PROBE_SQL, seconds: 60 });
  expectProblem(wedged, /immediately after its probe|back to back/);

  const swapped = structuredClone(base);
  [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  expectProblem(swapped, /back to back|immediately after its probe/);

  expectProblem(
    base.filter((step) => step.id !== calibrationStressId(2)),
    /immediately after its probe|steps;/,
  );
  expectProblem(
    base.filter((step) => step.id !== calibrationProbeId(2)),
    /no probe step|steps;/,
  );
  expectProblem(
    base.filter((step) => step.id !== 'control'),
    /control must be the first step/,
  );

  const filtered = structuredClone(base);
  filtered.find((step) => step.id === calibrationStressId(1)).pnpmArgs.push('--testNamePattern=x');
  expectProblem(filtered, /must be unfiltered/);

  const noTests = structuredClone(base);
  noTests.find((step) => step.id === calibrationStressId(1)).pnpmArgs.push('--passWithNoTests');
  expectProblem(noTests, /passes with no tests/);

  const retried = structuredClone(base);
  retried.find((step) => step.id === calibrationStressId(2)).pnpmArgs.push('--retry=2');
  expectProblem(retried, /retries/);

  const namedInstead = structuredClone(base);
  namedInstead[2] = { ...base[2], kind: 'jest-named', jestArgs: ['--selectProjects', 'x'] };
  expectProblem(namedInstead, /whole project, never a name-filtered proof/);

  const txid = structuredClone(base);
  txid[1].sql = 'SELECT txid_current();';
  expectProblem(txid, /txid_current/);

  const shortProbe = structuredClone(base);
  shortProbe[1].seconds = 5;
  expectProblem(shortProbe, new RegExp(`probe must run ${PROBE_SECONDS} s`));

  const twoControls = structuredClone(base);
  twoControls.push({ ...base[0], id: 'control-2' });
  expectProblem(twoControls, /exactly one read-only control/);

  for (const bad of [0, -1, 2.5, '2', undefined, MAX_CALIBRATION_PAIRS + 1]) {
    const problems = validateCalibrationContract({ specSource, plan: base, pairs: bad });
    assert.ok(
      problems.some((problem) => /calibration pairs must be an integer/.test(problem)),
      `pair count ${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('calibration contract: a changed stress constant still fails, in this mode too', () => {
  const plan = planCalibrationRun({ pairs: 1 });
  const swap = (from, to) => {
    const at = specSource.indexOf(from, Math.max(0, specSource.indexOf(NAMED_PROOF.title)));
    const index = at === -1 ? specSource.indexOf(from) : at;
    assert.ok(index !== -1, `fixture text not found: ${from}`);
    return specSource.slice(0, index) + to + specSource.slice(index + from.length);
  };
  const expectProblem = (source, pattern) => {
    const problems = validateCalibrationContract({ specSource: source, plan, pairs: 1 });
    assert.ok(
      problems.some((problem) => pattern.test(problem)),
      `no problem matched ${pattern}`,
    );
  };
  expectProblem(swap('const TOTAL = 500;', 'const TOTAL = 400;'), /TOTAL = 500/);
  expectProblem(
    swap('const LANES_PER_CLIENT = 2;', 'const LANES_PER_CLIENT = 1;'),
    /LANES_PER_CLIENT = 2/,
  );
  expectProblem(
    swap(
      'timeoutMs: 5000, windowSeconds: WINDOW_SECONDS',
      'timeoutMs: 15000, windowSeconds: WINDOW_SECONDS',
    ),
    /timeoutMs: 5000/,
  );
  expectProblem(
    swap('const WINDOW_SECONDS = 60;', 'const WINDOW_SECONDS = 120;'),
    /WINDOW_SECONDS = 60/,
  );
  expectProblem(
    swap('        await independentStore(),\n      ];', '      ];'),
    /independentStore/,
  );
  expectProblem(`jest.retryTimes(2);\n${specSource}`, /retries/);
});

test('distributions: deterministic for odd and even counts, and missing values are kept', () => {
  assert.deepEqual(distribution([3, 1, 2]), {
    count: 3,
    available: 3,
    unavailable: 0,
    min: 1,
    median: 2,
    max: 3,
  });
  assert.deepEqual(distribution([4, 1, 3, 2]), {
    count: 4,
    available: 4,
    unavailable: 0,
    min: 1,
    median: 2.5,
    max: 4,
  });
  // A missing sample stays in the denominator; it is not silently dropped.
  assert.deepEqual(distribution([10, null, 30]), {
    count: 3,
    available: 2,
    unavailable: 1,
    min: 10,
    median: 20,
    max: 30,
  });
  assert.deepEqual(distribution([null, undefined, NaN, Infinity]), {
    count: 4,
    available: 0,
    unavailable: 4,
    min: null,
    median: null,
    max: null,
  });
  assert.deepEqual(distribution([]), {
    count: 0,
    available: 0,
    unavailable: 0,
    min: null,
    median: null,
    max: null,
  });
  assert.equal(distribution([1, 2]).median, 1.5);
  assert.equal(distribution([5]).median, 5);
});

test('infrastructure classification: every category, and never a capability verdict', () => {
  const cases = {
    missingEnvironment: 'missing environment: PGHOST, PGPORT',
    dockerUnavailable: 'docker not found on PATH',
    pgbenchUnavailable: 'pgbench not found in the image',
    psqlUnavailable: 'psql not found in the image',
    connectionFailure: 'could not connect to server',
    permissionDenied: 'permission denied for function pg_logical_emit_message',
    statsUnreadable: 'pg_stat_wal: no row in the expected shape',
    statsReset: 'pg_stat_wal went backwards (stats reset?)',
    timeout: 'pgbench exited 1 after its bound',
    failedTransactions: 'pgbench reported 3 failed transaction(s)',
    controlContamination: 'read-only control flushed WAL 0.5000 times per transaction',
    backgroundWalContamination: 'wal_sync per transaction 2.400 is not approximately one',
    noProgress: 'pgbench reported no completed transaction',
    harnessError: 'jest launcher not found at /x',
  };
  for (const [category, message] of Object.entries(cases)) {
    const counts = classifyInfrastructureProblems([message]);
    assert.equal(counts[category], 1, `${JSON.stringify(message)} must classify as ${category}`);
    assert.equal(counts.other, 0, `${category} must not fall through to "other"`);
  }
  assert.equal(classifyInfrastructureProblems(['something nobody predicted']).other, 1);
  assert.deepEqual(
    Object.keys(classifyInfrastructureProblems([])).sort(),
    [...INFRASTRUCTURE_CATEGORY_NAMES].sort(),
  );
  assert.equal(classifyInfrastructureProblems(undefined).other, 0);

  // No category, anywhere, is a statement about speed.
  for (const name of INFRASTRUCTURE_CATEGORY_NAMES) {
    assert.ok(!/capable|incapable|slow|threshold|fast/i.test(name), name);
  }
  assert.deepEqual([...CALIBRATION_OUTCOMES], ['VALID', 'INVALID', 'INCONCLUSIVE']);
});

// --- fixtures for the summary tests -----------------------------------------

const probeFor = ({ tps = 20, valid = true, minIntervalTps = 12, stall = 0 } = {}) => ({
  transactions: 1200,
  failed: 0,
  tps,
  latencyAverageMs: 50,
  walSyncDelta: 1200,
  walSyncPerSecond: 20,
  walSyncPerTransaction: valid ? 1.0 : 2.4,
  walRecordsPerTransaction: 2.1,
  minIntervalTps,
  zeroCommitIntervals: stall > 0 ? 1 : 0,
  longestZeroCommitSeconds: stall,
  valid,
  problems: valid ? [] : ['wal_sync per transaction 2.400 is not approximately one'],
});

const stressFor = ({ passed = true, wallSeconds = 55, problems = [] } = {}) => ({
  passed,
  exitCode: passed ? 0 : 1,
  timedOut: false,
  wallSeconds,
  summary: {
    suites: { total: 1, passed: passed ? 1 : 0, failed: passed ? 0 : 1, skipped: 0 },
    tests: { total: 22, passed: passed ? 22 : 21, failed: passed ? 0 : 1, skipped: 0 },
    namedDurationMs: null,
    failures: classifyFailures(passed ? [] : ['canceling statement due to statement timeout']),
    problems,
  },
});

const calibrationResults = (rows) => [
  { id: 'control', passed: true, probe: { valid: true, problems: [] } },
  ...rows.flatMap((row, index) => {
    const pair = index + 1;
    const steps = [];
    if (row.probe !== undefined) {
      steps.push({ id: calibrationProbeId(pair), passed: row.probe.valid, probe: row.probe });
    }
    if (row.probeError) {
      steps.push({ id: calibrationProbeId(pair), passed: false, error: row.probeError });
    }
    if (row.stress !== undefined) {
      steps.push({ id: calibrationStressId(pair), ...row.stress });
    }
    return steps;
  }),
];

test('calibration summary: validity only, and a failed pair stays in the denominator', () => {
  const summary = summarizeCalibration({
    pairs: 3,
    results: calibrationResults([
      { probe: probeFor({ tps: 20 }), stress: stressFor({ wallSeconds: 50 }) },
      // Valid probe, failed suite — exactly the evidence ADR-055 wants, and
      // still `VALID`: the probe measured correctly.
      {
        probe: probeFor({ tps: 15, minIntervalTps: 2, stall: 4 }),
        stress: stressFor({ passed: false, wallSeconds: 130 }),
      },
      { probe: probeFor({ tps: 25, valid: false }), stress: stressFor({ wallSeconds: 60 }) },
    ]),
  });
  assert.deepEqual(summary.outcomes, { VALID: 2, INVALID: 1, INCONCLUSIVE: 0 });
  assert.equal(summary.rows[1].outcome, 'VALID', 'a failed suite is not an invalid probe');
  assert.equal(summary.rows[2].outcome, 'INVALID');
  assert.equal(summary.stressPassed, 2);
  assert.equal(summary.stressFailed, 1);
  // Every attempted pair is in the denominator of every distribution.
  assert.equal(summary.distributions.probeTps.count, 3);
  assert.equal(summary.distributions.probeTps.min, 15);
  assert.equal(summary.distributions.probeTps.median, 20);
  assert.equal(summary.distributions.probeTps.max, 25);
  assert.equal(summary.distributions.stressWallSeconds.median, 60);
  assert.equal(summary.distributions.probeLongestStallSeconds.max, 4);
  assert.equal(summary.distributions.probeMinIntervalTps.min, 2);
  assert.equal(summary.infrastructure.backgroundWalContamination, 1);
  assert.ok(!JSON.stringify(summary).includes('CAPABLE'), 'no capability label anywhere');
});

test('calibration summary: a pair that never ran is INCONCLUSIVE and still counted', () => {
  const summary = summarizeCalibration({
    pairs: 3,
    results: calibrationResults([
      { probe: probeFor(), stress: stressFor() },
      { probeError: 'psql exited 2' },
      {},
    ]),
  });
  assert.deepEqual(summary.outcomes, { VALID: 1, INVALID: 0, INCONCLUSIVE: 2 });
  assert.equal(summary.rows[1].probe, null);
  assert.equal(summary.rows[2].stress, null);
  assert.equal(summary.stressPassed, 1);
  // Three pairs were attempted, so three is the denominator even though one
  // produced nothing at all.
  for (const stats of Object.values(summary.distributions)) assert.equal(stats.count, 3);
  assert.equal(summary.distributions.probeTps.available, 1);
  assert.equal(summary.distributions.probeTps.unavailable, 2);
  assert.equal(summary.distributions.stressWallSeconds.unavailable, 2);
});

test('calibration report: aggregates only, deterministic, and free of every sentinel', () => {
  const SENTINELS = [
    'postgresql://rasta_identity:hunter2@db.invalid:5432/rasta',
    'hunter2',
    'eyJhbGciOi.eyJzdWIi.sig',
    'USR_ABCDE12345_01J8Z3K4M5N6P7Q8R9S0T1V2W3',
    'PGPASSWORD=hunter2',
    'FATAL: password authentication failed for user "rasta_identity"',
  ];
  const summary = summarizeCalibration({
    pairs: 2,
    results: calibrationResults([
      { probe: probeFor({ tps: 18.5 }), stress: stressFor({ wallSeconds: 57.25 }) },
      { probe: probeFor({ valid: false }), stress: stressFor({ passed: false, wallSeconds: 121 }) },
    ]),
  });
  const render = () =>
    formatCalibrationReport({
      meta: { commit: 'abc1234', generatedAt: '2026-09-14T00:00:00.000Z' },
      topology: { server_version: '16.4', fsync: 'on' },
      summary,
    });
  const text = render();

  assert.equal(text, render(), 'the same input renders byte for byte the same report');
  assert.match(text, /pair-1: outcome=VALID/);
  assert.match(text, /pair-2: outcome=INVALID/);
  assert.match(text, /tps=18\.5/);
  assert.match(text, /probe_tps: n=2 available=2 unavailable=0 min=18\.5 median=.* max=20/);
  assert.match(text, /stress: passed=1 failed=1 of 2/);
  assert.match(text, /outcomes: VALID=1 INVALID=1 INCONCLUSIVE=0/);
  assert.match(text, /proposes no threshold/);
  // The report may *disclaim* capability; it may never assert one.
  for (const forbidden of [/VALID_CAPABLE/, /VALID_INCAPABLE/, /too slow/i, /threshold=/]) {
    assert.ok(!forbidden.test(text), `report asserted ${forbidden}`);
  }
  // Every line that mentions capability must be negating it, not asserting it.
  const capabilityLines = [...text.matchAll(/^.*capab.*$/gim)].map(([line]) => line);
  assert.ok(capabilityLines.length > 0, 'the report states its limits explicitly');
  for (const line of capabilityLines) {
    assert.match(line, /\b(?:no|not|never|does not)\b/i, `capability claimed: ${line}`);
  }
  assert.match(text, /No threshold, no margin, no capability judgement\./);
  assert.match(text, /does not locate a capability boundary/);

  for (const sentinel of SENTINELS) {
    assert.ok(!text.includes(sentinel), `report leaked ${sentinel}`);
    assert.ok(!JSON.stringify(summary).includes(sentinel), `summary retained ${sentinel}`);
  }
  // A pair that produced nothing still gets a line, so the report is readable
  // as a distribution rather than as a list of successes.
  const sparse = formatCalibrationReport({
    meta: { commit: 'abc', generatedAt: 'now' },
    topology: {},
    summary: summarizeCalibration({ pairs: 2, results: calibrationResults([{}, {}]) }),
  });
  assert.match(sparse, /pair-1: outcome=INCONCLUSIVE/);
  assert.match(sparse, /probe: not run/);
  assert.match(sparse, /stress: not run/);
  assert.match(sparse, /probe_tps: n=2 available=0 unavailable=2 min=n\/a median=n\/a max=n\/a/);
});
