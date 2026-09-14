import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTestPhaseInputs } from './check-test-phases.mjs';
import { validateTestPhases, workflowStepCommands } from './test-phases-lib.mjs';
import {
  NAMED_PROOF,
  NAMED_RUNS,
  PROBE_SECONDS,
  STRESS,
  WAL_PROBE_SQL,
  CONTROL_SQL,
  classifyFailures,
  formatReport,
  namedProofPattern,
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
  validateProbeSql,
} from './aggregation-evidence-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specSource = readFileSync(join(root, STRESS.packageDir, STRESS.spec), 'utf8');
const EVIDENCE_WORKFLOW = join(root, '.github', 'workflows', 'aggregation-stress-evidence.yml');
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
});

// ---------------------------------------------------------------------------
// The workflow: the evidence job, and the normal gates it must not bend

test('the evidence workflow runs the harness once on the integration job’s database and uploads a 7-day artifact', () => {
  const workflow = readFileSync(EVIDENCE_WORKFLOW, 'utf8');
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const commands = [...workflow.matchAll(/^\s*- name:\s*(.+?)\s*$/gm)].flatMap((m) =>
    workflowStepCommands(workflow, m[1]).flat(),
  );

  assert.match(workflow, /image: postgis\/postgis:16-3\.4\n/);
  assert.match(ci, /image: postgis\/postgis:16-3\.4\n/);
  assert.equal(
    commands.filter((line) => /^node scripts\/aggregation-evidence\.mjs\b/.test(line)).length,
    1,
    'the harness runs exactly once',
  );
  assert.ok(commands.includes('node --test scripts/aggregation-evidence.test.mjs'));
  assert.ok(commands.includes('bash infrastructure/docker/postgres/00-init-databases.sh'));
  assert.ok(commands.includes('pnpm --filter @rasta/identity-service run db:migrate'));
  assert.ok(!/passWithNoTests/.test(workflow));
  assert.ok(!/continue-on-error/.test(workflow), 'evidence must not turn failures green');
  assert.ok(!/turbo run test/.test(workflow), 'no test task through turbo directly');
  assert.ok(
    !/redis:|kafka:|minio|clamav/i.test(workflow),
    'PostgreSQL only: no other service load',
  );
  assert.match(workflow, /uses: actions\/upload-artifact@[0-9a-f]{40} # v4/);
  assert.match(workflow, /retention-days: 7\n/);
  assert.match(workflow, /if-no-files-found: error\n/);
  assert.ok(!/cancel-in-progress: true/.test(workflow));
  for (const url of [
    'DATABASE_URL_IDENTITY: postgresql://rasta_identity:rasta_ci_service_password@localhost:5432/rasta_identity?schema=public',
  ]) {
    assert.ok(
      workflow.includes(url) && ci.includes(url),
      'same identity database as the integration job',
    );
  }
});

test('the normal CI gates still run the stress spec through the two-phase orchestrator', () => {
  assert.deepEqual(validateTestPhases(readTestPhaseInputs()), []);
});
