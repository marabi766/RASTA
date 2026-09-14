/**
 * Native-Linux evidence for identity-service's aggregation stress proof — the
 * pure half.
 *
 * Why this exists. The four-client 500-capture proof in
 * `security-event-aggregation.int-spec.ts` serializes on one hot row, so its
 * pace is the database's commit latency. Locally it has failed only on Docker
 * Desktop under host load, and passed 5/5 on both an existing and a disposable
 * volume when the host was quiet (PROJECT_MEMORY, AUD-004). Before any
 * fail-fast storage-capability precondition can be designed, the distribution
 * on a native Ubuntu runner is the missing input. This measures it; it sets no
 * commit-rate threshold and changes nothing the proof asserts.
 *
 * Plan: a read-only control and a validated single-committer WAL probe, five
 * fresh jest processes running only the named proof, one fresh run of the whole
 * `aggregation-stress` project through `pnpm test:aggregation-stress`, and the
 * WAL probe again. Output is aggregates only — never a connection string,
 * credential, row, identifier or failure message.
 *
 * The runner (`aggregation-evidence.mjs`) executes the plan and reads the real
 * processes; everything here takes plain values and is unit-tested.
 */

/** The unchanged proof, selected by its exact title. */
export const NAMED_PROOF = Object.freeze({
  title:
    'exactly 500 concurrent captures from four independent database clients serialize into one row, counting 1..500 with no gap',
  describePath: Object.freeze([
    'windowed refusal aggregation (real PostgreSQL)',
    'one row per identity per window',
  ]),
});

export const STRESS = Object.freeze({
  packageName: '@rasta/identity-service',
  packageDir: 'services/identity-service',
  spec: 'test/security-event-aggregation.int-spec.ts',
  jestProject: 'aggregation-stress',
  rootScript: 'test:aggregation-stress',
});

export const NAMED_RUNS = 5;
export const PROBE_SECONDS = 60;
export const CONTROL_SECONDS = 10;

/** One committed transaction writing WAL: a transactional logical message. Fixed, non-sensitive text. */
export const WAL_PROBE_SQL =
  "SELECT pg_logical_emit_message(true, 'rasta-wal-probe', 'one-committer-probe');";

/** The read-only control: many transactions, no commit record, no WAL flush. */
export const CONTROL_SQL = 'SELECT 1;';

/**
 * Bounds that make a probe *valid*, not *fast*. A single committer on
 * `synchronous_commit=on` flushes WAL once per commit, so `wal_sync` per
 * transaction must sit near one; background writers may add a little. A
 * read-only control must add almost none, or the counter is not measuring
 * commits. Neither bound says anything about how many commits per second are
 * acceptable — that decision waits for these measurements.
 */
export const PROBE_VALIDITY = Object.freeze({
  minSyncPerTransaction: 0.9,
  maxSyncPerTransaction: 1.25,
  minRecordsPerTransaction: 2,
  maxControlSyncPerTransaction: 0.01,
});

/** Samples at or above this many `wal_sync` per second mark the proof's burst as active. */
export const ACTIVE_SYNCS_PER_SECOND = 5;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The `--testNamePattern` that selects the named proof and nothing else. Jest
 * matches it against the describe path and title joined by spaces.
 */
export function namedProofPattern() {
  return `^${escapeRegExp([...NAMED_PROOF.describePath, NAMED_PROOF.title].join(' '))}$`;
}

/**
 * The ordered evidence plan. Every jest step is its own process; nothing is
 * retried, and a failing step never stops the rest.
 */
export function planEvidenceRun({ namedRuns = NAMED_RUNS } = {}) {
  const pattern = namedProofPattern();
  const named = Array.from({ length: namedRuns }, (_, index) => ({
    id: `named-${index + 1}`,
    kind: 'jest-named',
    // Run in the package directory with the package's own jest binary.
    jestArgs: [
      '--selectProjects',
      STRESS.jestProject,
      '--runInBand',
      `--testNamePattern=${pattern}`,
      '--json',
    ],
  }));
  return [
    { id: 'control', kind: 'probe', sql: CONTROL_SQL, seconds: CONTROL_SECONDS, control: true },
    { id: 'probe-before', kind: 'probe', sql: WAL_PROBE_SQL, seconds: PROBE_SECONDS },
    ...named,
    {
      id: 'full-project',
      kind: 'jest-full',
      // Through the root script, so turbo's strict environment and its task
      // definition are what is measured.
      pnpmArgs: ['run', STRESS.rootScript, '--', '--json'],
    },
    { id: 'probe-after', kind: 'probe', sql: WAL_PROBE_SQL, seconds: PROBE_SECONDS },
  ];
}

/** pgbench arguments for one probe: one client, one thread, no vacuum, 1 s progress. */
export function pgbenchArgs({ seconds, scriptPath }) {
  return ['-n', '-c', '1', '-j', '1', '-T', String(seconds), '-P', '1', '-f', scriptPath];
}

/**
 * Refuses a probe script that would not commit one WAL-writing transaction per
 * execution: `txid_current()` (assigns an xid lazily and proves nothing about
 * a flush), a non-transactional message, an explicit transaction block, or
 * more than one statement.
 */
export function validateProbeSql(sql, { control = false } = {}) {
  const problems = [];
  const statements = String(sql)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  if (statements.length !== 1) problems.push(`expected one statement, found ${statements.length}`);
  if (/txid_current|pg_current_xact_id/i.test(sql)) {
    problems.push('txid_current()/pg_current_xact_id() is not a WAL commit probe');
  }
  if (/\b(BEGIN|COMMIT|END|START\s+TRANSACTION)\b/i.test(sql)) {
    problems.push('the probe must be one implicit transaction, not an explicit block');
  }
  if (control) {
    if (!/^SELECT\s+1$/i.test(statements[0] ?? '')) problems.push('the control must be SELECT 1');
  } else if (
    !/^SELECT\s+pg_logical_emit_message\(\s*true\s*,\s*'[a-z0-9-]+'\s*,\s*'[a-z0-9-]+'\s*\)$/i.test(
      statements[0] ?? '',
    )
  ) {
    problems.push(
      'the probe must be SELECT pg_logical_emit_message(true, <fixed prefix>, <fixed payload>)',
    );
  }
  return problems;
}

const numberAfter = (text, pattern) => {
  const match = String(text).match(pattern);
  return match ? Number(match[1]) : null;
};

/** The aggregate figures of one pgbench run, from its combined stdout and stderr. */
export function parsePgbenchOutput(text) {
  const intervals = [];
  for (const match of String(text).matchAll(/^progress: ([\d.]+) s, ([\d.]+) tps/gm)) {
    intervals.push({ at: Number(match[1]), tps: Number(match[2]) });
  }
  let longestZero = 0;
  let zeroIntervals = 0;
  let run = 0;
  let previousAt = 0;
  for (const { at, tps } of intervals) {
    const width = at - previousAt;
    previousAt = at;
    if (tps === 0) {
      zeroIntervals += 1;
      run += width;
      longestZero = Math.max(longestZero, run);
    } else {
      run = 0;
    }
  }
  return {
    transactions: numberAfter(text, /^number of transactions actually processed: (\d+)/m),
    failed: numberAfter(text, /^number of failed transactions: (\d+)/m) ?? 0,
    latencyAverageMs: numberAfter(text, /^latency average = ([\d.]+) ms/m),
    tps: numberAfter(text, /^tps = ([\d.]+)/m),
    progressIntervals: intervals.length,
    minIntervalTps: intervals.length ? Math.min(...intervals.map((i) => i.tps)) : null,
    zeroCommitIntervals: zeroIntervals,
    longestZeroCommitSeconds: Number(longestZero.toFixed(1)),
  };
}

/** `wal_records|wal_sync|wal_write|wal_bytes` from psql's unaligned tuples-only output. */
export function parseWalStat(text) {
  const line = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^\d+\|\d+\|\d+\|\d+$/.test(l));
  if (!line) throw new Error('pg_stat_wal: no row in the expected shape');
  const [walRecords, walSync, walWrite, walBytes] = line.split('|').map(Number);
  return { walRecords, walSync, walWrite, walBytes };
}

/** Joins a pgbench run with the `pg_stat_wal` readings around it and judges validity. */
export function summarizeProbe({ pgbench, before, after, seconds, control = false }) {
  const problems = [];
  const syncDelta = after.walSync - before.walSync;
  const recordDelta = after.walRecords - before.walRecords;
  const transactions = pgbench.transactions ?? 0;
  if (!Number.isInteger(pgbench.transactions) || transactions <= 0) {
    problems.push('pgbench reported no completed transaction');
  }
  if (pgbench.failed !== 0)
    problems.push(`pgbench reported ${pgbench.failed} failed transaction(s)`);
  if (pgbench.tps === null) problems.push('pgbench reported no tps');
  if (pgbench.progressIntervals < Math.floor(seconds * 0.9)) {
    problems.push(`pgbench printed ${pgbench.progressIntervals} progress lines for ${seconds} s`);
  }
  if (syncDelta < 0 || recordDelta < 0) problems.push('pg_stat_wal went backwards (stats reset?)');
  const syncPerTransaction = transactions > 0 ? syncDelta / transactions : null;
  const recordsPerTransaction = transactions > 0 ? recordDelta / transactions : null;
  if (syncPerTransaction !== null) {
    if (control) {
      if (syncPerTransaction > PROBE_VALIDITY.maxControlSyncPerTransaction) {
        problems.push(
          `read-only control flushed WAL ${syncPerTransaction.toFixed(4)} times per transaction`,
        );
      }
    } else {
      if (
        syncPerTransaction < PROBE_VALIDITY.minSyncPerTransaction ||
        syncPerTransaction > PROBE_VALIDITY.maxSyncPerTransaction
      ) {
        problems.push(
          `wal_sync per transaction ${syncPerTransaction.toFixed(3)} is not approximately one`,
        );
      }
      if (recordsPerTransaction < PROBE_VALIDITY.minRecordsPerTransaction) {
        problems.push(
          `wal_records per transaction ${recordsPerTransaction.toFixed(3)} is below message + commit`,
        );
      }
    }
  }
  return {
    control,
    seconds,
    transactions,
    failed: pgbench.failed,
    tps: pgbench.tps,
    latencyAverageMs: pgbench.latencyAverageMs,
    walSyncDelta: syncDelta,
    walSyncPerSecond: Number((syncDelta / seconds).toFixed(2)),
    walSyncPerTransaction:
      syncPerTransaction === null ? null : Number(syncPerTransaction.toFixed(4)),
    walRecordsPerTransaction:
      recordsPerTransaction === null ? null : Number(recordsPerTransaction.toFixed(3)),
    minIntervalTps: pgbench.minIntervalTps,
    zeroCommitIntervals: pgbench.zeroCommitIntervals,
    longestZeroCommitSeconds: pgbench.longestZeroCommitSeconds,
    valid: problems.length === 0,
    problems,
  };
}

/** `epoch|wal_sync` samples from a `\watch 1` psql session. */
export function parseWalSamples(text) {
  const samples = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+(?:\.\d+)?)\|(\d+)$/);
    if (match) samples.push({ at: Number(match[1]), walSync: Number(match[2]) });
  }
  return samples;
}

/**
 * The burst as `pg_stat_wal` saw it: the span from the first to the last
 * sample interval carrying at least `ACTIVE_SYNCS_PER_SECOND`, its sync rate,
 * and the longest stretch inside it with no observed `wal_sync` increase.
 * Backends flush their counters about once a second, so the resolution is
 * roughly one to two seconds; idle waits before and after the burst (the
 * fresh-window wait, harness start and cleanup) fall outside the span.
 */
export function summarizeBurst(samples) {
  const intervals = [];
  for (let i = 1; i < samples.length; i += 1) {
    const width = samples[i].at - samples[i - 1].at;
    if (width <= 0) continue;
    intervals.push({
      start: samples[i - 1].at,
      end: samples[i].at,
      delta: samples[i].walSync - samples[i - 1].walSync,
      width,
    });
  }
  const active = intervals
    .map((interval, index) => ({ ...interval, index }))
    .filter((interval) => interval.delta / interval.width >= ACTIVE_SYNCS_PER_SECOND);
  if (active.length === 0) {
    return {
      samples: samples.length,
      activeSeconds: 0,
      syncsPerSecond: null,
      longestNoSyncSeconds: null,
    };
  }
  const first = active[0].index;
  const last = active[active.length - 1].index;
  const span = intervals.slice(first, last + 1);
  const seconds = span[span.length - 1].end - span[0].start;
  const syncs = span.reduce((sum, interval) => sum + interval.delta, 0);
  let longest = 0;
  let current = 0;
  for (const interval of span) {
    if (interval.delta === 0) {
      current += interval.width;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return {
    samples: samples.length,
    activeSeconds: Number(seconds.toFixed(1)),
    syncsPerSecond: Number((syncs / seconds).toFixed(2)),
    longestNoSyncSeconds: Number(longest.toFixed(1)),
  };
}

const FAILURE_CATEGORIES = Object.freeze([
  ['sqlstate57014', /57014|canceling statement due to statement timeout/i],
  ['jestTimeout', /Exceeded timeout of \d+\s*ms/],
  [
    'secondRowOrWindowCrossing',
    /^\s*>\s*\d+\s*\|.*(result\.created|new Set\(results\.map|expect\(rows\)\.toHaveLength)/m,
  ],
  ['countSequence', /^\s*>\s*\d+\s*\|.*(occurrenceCount\)\.sort|expect\(results\)\.toHaveLength)/m],
  ['finalRow', /^\s*>\s*\d+\s*\|.*occurrenceCount: 500/m],
  [
    'otherDatabaseError',
    /PrismaClient|\bP\d{4}\b|SQLSTATE|ECONNREFUSED|ECONNRESET|Can't reach database server|terminating connection|deadlock detected|could not serialize/i,
  ],
]);

/**
 * Which kinds of failure a failure message shows, as counts. The message text
 * itself is never returned: it can carry test identifiers and row values. A
 * `57014` is counted as that alone, not also as another database error.
 */
export function classifyFailures(messages) {
  const counts = Object.fromEntries([
    ...FAILURE_CATEGORIES.map(([name]) => [name, 0]),
    ['other', 0],
  ]);
  for (const message of messages) {
    const matches = FAILURE_CATEGORIES.filter(([, pattern]) => pattern.test(message)).map(
      ([name]) => name,
    );
    const counted = matches.includes('sqlstate57014')
      ? matches.filter((name) => name !== 'otherDatabaseError')
      : matches;
    for (const name of counted) counts[name] += 1;
    if (counted.length === 0) counts.other += 1;
  }
  return counts;
}

const SKIPPED = new Set(['pending', 'skipped', 'todo', 'disabled']);

/**
 * The aggregates of one jest `--json` report. For a named run, `expectNamed`
 * requires that exactly the named proof ran and every other test was filtered.
 */
export function summarizeJestReport(report, { expectNamed = false } = {}) {
  const problems = [];
  const assertions = (report?.testResults ?? []).flatMap((suite) => suite.assertionResults ?? []);
  const ran = assertions.filter((a) => !SKIPPED.has(a.status));
  const skipped = assertions.length - ran.length;
  const failedAssertions = assertions.filter((a) => a.status === 'failed');
  const suiteErrors = (report?.testResults ?? [])
    .filter(
      (suite) =>
        suite.status === 'failed' &&
        (suite.assertionResults ?? []).every((a) => a.status !== 'failed'),
    )
    .map((suite) => String(suite.message ?? ''));
  const messages = [...failedAssertions.flatMap((a) => a.failureMessages ?? []), ...suiteErrors];

  if (!report || typeof report.numTotalTests !== 'number') problems.push('no jest report');
  if ((report?.numTotalTests ?? 0) === 0) problems.push('jest collected no test');
  if ((report?.numFailedTests ?? 0) > 0) problems.push(`${report.numFailedTests} test(s) failed`);
  if ((report?.numFailedTestSuites ?? 0) > 0 || (report?.numRuntimeErrorTestSuites ?? 0) > 0) {
    problems.push('a test suite failed');
  }
  if (report && report.success !== true) problems.push('jest did not report success');

  let namedDurationMs = null;
  if (expectNamed) {
    const fullName = [...NAMED_PROOF.describePath, NAMED_PROOF.title].join(' ');
    if (ran.length !== 1 || ran[0].fullName !== fullName) {
      problems.push(`the name filter ran ${ran.length} test(s); exactly the named proof must run`);
    } else {
      namedDurationMs = ran[0].duration ?? null;
    }
  }
  return {
    suites: {
      total: report?.numTotalTestSuites ?? 0,
      passed: report?.numPassedTestSuites ?? 0,
      failed: report?.numFailedTestSuites ?? 0,
      skipped: report?.numPendingTestSuites ?? 0,
    },
    tests: {
      total: report?.numTotalTests ?? 0,
      passed: report?.numPassedTests ?? 0,
      failed: report?.numFailedTests ?? 0,
      skipped,
    },
    namedDurationMs,
    failures: classifyFailures(messages),
    problems,
  };
}

/** Strips anything that could identify a connection, token or test row from a log tail. */
export function redact(text) {
  return String(text)
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '<database-url>')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<jwt>')
    .replace(/[0-9A-HJKMNP-TV-Z]{26}/g, '<ulid>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(
      /(?<![0-9A-Za-z])(?=[0-9A-Z]{0,9}\d)(?=[0-9A-Z]{0,9}[A-Z])[0-9A-Z]{10}(?![0-9A-Za-z])/g,
      '<tag>',
    )
    .replace(/(password|secret|token)(\s*[=:]\s*)\S+/gi, '$1$2<redacted>');
}

const fmt = (value, digits = 2) =>
  value === null || value === undefined
    ? 'n/a'
    : typeof value === 'number'
      ? String(Number(value.toFixed(digits)))
      : String(value);

function probeLines(label, probe) {
  if (!probe) return [`${label}: not run`];
  const lines = [
    `${label}: valid=${probe.valid ? 'yes' : 'NO'} seconds=${probe.seconds} transactions=${probe.transactions} ` +
      `failed=${probe.failed} tps=${fmt(probe.tps)} latency_avg_ms=${fmt(probe.latencyAverageMs, 3)}`,
    `  wal_sync_delta=${probe.walSyncDelta} wal_sync_per_s=${fmt(probe.walSyncPerSecond)} ` +
      `wal_sync_per_tx=${fmt(probe.walSyncPerTransaction, 4)} wal_records_per_tx=${fmt(probe.walRecordsPerTransaction, 3)}`,
    `  min_interval_tps=${fmt(probe.minIntervalTps)} zero_commit_intervals=${probe.zeroCommitIntervals} ` +
      `longest_zero_commit_s=${fmt(probe.longestZeroCommitSeconds, 1)}`,
  ];
  for (const problem of probe.problems) lines.push(`  problem: ${problem}`);
  return lines;
}

function jestLines(label, run) {
  if (!run) return [`${label}: not run`];
  const s = run.summary;
  const failures = Object.entries(s.failures)
    .map(([name, count]) => `${name}=${count}`)
    .join(' ');
  const lines = [
    `${label}: result=${run.passed ? 'PASS' : 'FAIL'} exit=${run.exitCode}${run.timedOut ? ' (process bound exceeded)' : ''} ` +
      `start=${run.startedAt} end=${run.endedAt} wall_s=${fmt(run.wallSeconds, 1)}`,
    `  suites passed/failed/skipped/total=${s.suites.passed}/${s.suites.failed}/${s.suites.skipped}/${s.suites.total} ` +
      `tests passed/failed/skipped/total=${s.tests.passed}/${s.tests.failed}/${s.tests.skipped}/${s.tests.total}` +
      (s.namedDurationMs !== null ? ` named_test_ms=${s.namedDurationMs}` : ''),
    `  failures: ${failures}`,
  ];
  if (run.wal) {
    lines.push(
      `  wal_sync_delta=${run.wal.walSyncDelta} wal_sync_per_s=${fmt(run.wal.walSyncPerSecond)}` +
        (run.burst
          ? ` burst_active_s=${fmt(run.burst.activeSeconds, 1)} burst_wal_sync_per_s=${fmt(run.burst.syncsPerSecond)} ` +
            `burst_longest_no_sync_s=${fmt(run.burst.longestNoSyncSeconds, 1)} samples=${run.burst.samples}`
          : ''),
    );
  }
  for (const problem of s.problems) lines.push(`  problem: ${problem}`);
  return lines;
}

/** The artifact text: aggregates only. */
export function formatReport({ meta, topology, results }) {
  const byId = Object.fromEntries(results.map((result) => [result.id, result]));
  const lines = [
    'AUD-004 aggregation stress proof - native Ubuntu CI evidence',
    `commit=${meta.commit} run=${meta.runUrl} generated=${meta.generatedAt}`,
    `topology: ${Object.entries(topology)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')}`,
    `named proof: "${NAMED_PROOF.title}"`,
    `named runs: ${NAMED_RUNS} fresh jest processes; full project: 1 fresh process via pnpm ${STRESS.rootScript}; no retries`,
    'burst figures come from pg_stat_wal sampled every ~1 s (backend counters flush about once per second)',
    '',
    ...probeLines('control (read-only SELECT 1, 1 client)', byId.control?.probe),
    ...probeLines('probe-before (pg_logical_emit_message, 1 client)', byId['probe-before']?.probe),
  ];
  for (let i = 1; i <= NAMED_RUNS; i += 1)
    lines.push(...jestLines(`named-${i}`, byId[`named-${i}`]));
  lines.push(...jestLines('full-project', byId['full-project']));
  lines.push(
    ...probeLines('probe-after (pg_logical_emit_message, 1 client)', byId['probe-after']?.probe),
  );
  const failed = results.filter((result) => !result.passed).map((result) => result.id);
  lines.push('', `verdict: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.join(', ')})`}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Static contract for the evidence itself: the proof's stress constants are
 * the ones it was measured with, and the plan runs it the way the evidence
 * claims. Returns problem strings; empty means the contract holds.
 */
export function validateEvidenceContract({ specSource, plan }) {
  const problems = [];
  const source = String(specSource);
  const occurrences = source.split(`'${NAMED_PROOF.title}'`).length - 1;
  if (occurrences !== 1)
    problems.push(`the named proof title appears ${occurrences} time(s) in the spec`);
  for (const name of NAMED_PROOF.describePath) {
    if (!source.includes(`describe('${name}'`)) problems.push(`the spec lost describe('${name}')`);
  }
  const start = source.indexOf(`'${NAMED_PROOF.title}'`);
  const end = source.indexOf('\n    it(', start + 1);
  const body = start === -1 ? '' : source.slice(start, end === -1 ? undefined : end);
  const required = [
    ['const WINDOW_SECONDS = 60;', source],
    ['const CAPTURE = { timeoutMs: 5000, windowSeconds: WINDOW_SECONDS };', source],
    ['const TOTAL = 500;', body],
    ['const LANES_PER_CLIENT = 2;', body],
    [
      'store,\n        await independentStore(),\n        await independentStore(),\n        await independentStore(),\n      ];',
      body,
    ],
    ['results.push(await writer.capture(again(base), CAPTURE));', body],
    ['expect(results).toHaveLength(TOTAL);', body],
    ['expect(results.filter((result) => result.created)).toHaveLength(1);', body],
    ['Array.from({ length: 500 }, (_, index) => index + 1)', body],
    ['expect(rows).toHaveLength(1);', body],
    ['occurrenceCount: 500, claimCount: 0', body],
    ['}, 120_000);', body],
  ];
  for (const [text, where] of required) {
    if (!where.includes(text))
      problems.push(`stress constant or assertion changed: ${JSON.stringify(text)}`);
  }
  if (/retryTimes|\.retry\(/.test(source)) problems.push('the spec retries tests');

  const steps = plan ?? [];
  const ids = steps.map((step) => step.id);
  const named = steps.filter((step) => step.kind === 'jest-named');
  const full = steps.filter((step) => step.kind === 'jest-full');
  if (named.length !== NAMED_RUNS)
    problems.push(`plan has ${named.length} named runs, not ${NAMED_RUNS}`);
  if (new Set(named.map((step) => step.id)).size !== named.length)
    problems.push('named runs share an id');
  for (const step of named) {
    const args = step.jestArgs ?? [];
    if (!args.includes(`--testNamePattern=${namedProofPattern()}`)) {
      problems.push(`${step.id} does not select the named proof by its exact pattern`);
    }
    const at = args.indexOf('--selectProjects');
    if (
      at === -1 ||
      args[at + 1] !== STRESS.jestProject ||
      (args[at + 2] ?? '-').charAt(0) !== '-'
    ) {
      problems.push(`${step.id} must select exactly the ${STRESS.jestProject} project`);
    }
    if (!args.includes('--runInBand')) problems.push(`${step.id} must run in band`);
  }
  if (full.length !== 1) {
    problems.push(`plan runs the full project ${full.length} time(s), not once`);
  } else if (
    full[0].pnpmArgs?.[0] !== 'run' ||
    full[0].pnpmArgs?.[1] !== STRESS.rootScript ||
    full[0].pnpmArgs
      .slice(2)
      .some((arg) => arg.startsWith('--testNamePattern') || arg.startsWith('-t'))
  ) {
    problems.push(`the full project must run \`pnpm run ${STRESS.rootScript}\` unfiltered`);
  }
  for (const step of steps) {
    const args = [...(step.jestArgs ?? []), ...(step.pnpmArgs ?? [])];
    if (args.includes('--passWithNoTests')) problems.push(`${step.id} passes with no tests`);
    if (step.kind === 'probe')
      problems.push(
        ...validateProbeSql(step.sql, { control: step.control }).map((p) => `${step.id}: ${p}`),
      );
  }
  const probeIndex = (id) => ids.indexOf(id);
  const firstJest = steps.findIndex((step) => step.kind !== 'probe');
  const lastJest =
    steps.length - 1 - [...steps].reverse().findIndex((step) => step.kind !== 'probe');
  const before = steps[probeIndex('probe-before')];
  const after = steps[probeIndex('probe-after')];
  if (
    !before ||
    probeIndex('probe-before') > firstJest ||
    before.seconds !== PROBE_SECONDS ||
    before.control
  ) {
    problems.push(`a ${PROBE_SECONDS} s WAL probe must run before every jest step`);
  }
  if (
    !after ||
    probeIndex('probe-after') < lastJest ||
    after.seconds !== PROBE_SECONDS ||
    after.control
  ) {
    problems.push(`a ${PROBE_SECONDS} s WAL probe must run after every jest step`);
  }
  return problems;
}
