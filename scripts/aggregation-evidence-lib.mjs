/**
 * Commit-rate evidence for identity-service's aggregation stress proof — the
 * pure half of a manual measurement (`aggregation-evidence.mjs`).
 *
 * Why this exists. The four-client 500-capture proof in
 * `security-event-aggregation.int-spec.ts` serializes on one hot row, so its
 * pace is the database's commit latency. On Docker Desktop it has failed only
 * under host load. On a native Ubuntu GitHub runner (2026-09-14, PROJECT_MEMORY
 * AUD-004) the same database image committed ~4,600 validated single-client
 * WAL syncs/s, against ~15–29/s locally, and the unchanged proof passed 5/5
 * named runs plus the whole project. A future fail-fast storage-capability
 * precondition needs both distributions, so this keeps the measurement
 * reproducible. It sets no commit-rate threshold and changes nothing the proof
 * asserts.
 *
 * Plan: a read-only control and a validated single-committer WAL probe, five
 * fresh jest processes running only the named proof, one fresh run of the whole
 * `aggregation-stress` project through `pnpm test:aggregation-stress`, and the
 * WAL probe again. Output is aggregates only — never a connection string,
 * credential, row, identifier or failure message.
 *
 * Everything here takes plain values and is unit-tested
 * (`pnpm test:aggregation-evidence-lib`); the runner executes the plan.
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

// ---------------------------------------------------------------------------
// Paired calibration (ADR-055) — manual, report-only, and deliberately
// threshold-free.
//
// ADR-055 separates *probe validity* from *environment capability* and refuses
// to pick a capability threshold until a two-sided dataset exists. Collecting
// that dataset needs samples in which the measurement and the proof are
// adjacent: a probe taken an hour before a stress run says nothing about the
// conditions that run actually met. So one calibration sample is exactly one
// validated WAL probe followed immediately by one fresh run of the *entire
// unchanged* aggregation-stress project, with nothing in between.
//
// Nothing here judges capability. The outputs are `VALID`, `INVALID` and
// `INCONCLUSIVE` only; there is no threshold, no margin, and no "too slow".

/** Bounds on how many pairs one campaign may collect. Refused, never coerced. */
export const MIN_CALIBRATION_PAIRS = 1;
export const MAX_CALIBRATION_PAIRS = 20;

/** Outcome labels the calibration mode may emit. Capability is not among them. */
export const CALIBRATION_OUTCOMES = Object.freeze(['VALID', 'INVALID', 'INCONCLUSIVE']);

/** The step id of pair `n`'s probe and of the stress run that must follow it. */
export const calibrationProbeId = (pair) => `pair-${pair}-probe`;
export const calibrationStressId = (pair) => `pair-${pair}-stress`;

/**
 * The ordered calibration plan: one read-only control to prove the counter is
 * measuring commits at all, then `pairs` adjacent (probe, stress) samples.
 *
 * Throws on a pair count that is missing, non-integer or out of bounds — a
 * silently coerced count would quietly change what a campaign means.
 */
export function planCalibrationRun({ pairs } = {}) {
  if (typeof pairs !== 'number' || !Number.isInteger(pairs)) {
    throw new Error(`calibration pairs must be an integer, got ${JSON.stringify(pairs)}`);
  }
  if (pairs < MIN_CALIBRATION_PAIRS || pairs > MAX_CALIBRATION_PAIRS) {
    throw new Error(
      `calibration pairs must be between ${MIN_CALIBRATION_PAIRS} and ${MAX_CALIBRATION_PAIRS}, got ${pairs}`,
    );
  }
  const steps = [
    { id: 'control', kind: 'probe', sql: CONTROL_SQL, seconds: CONTROL_SECONDS, control: true },
  ];
  for (let pair = 1; pair <= pairs; pair += 1) {
    steps.push({
      id: calibrationProbeId(pair),
      kind: 'probe',
      sql: WAL_PROBE_SQL,
      seconds: PROBE_SECONDS,
      pair,
      role: 'probe',
    });
    steps.push({
      id: calibrationStressId(pair),
      kind: 'jest-full',
      // The root route, unfiltered: turbo's task definition and strict
      // environment are part of what a sample measures.
      pnpmArgs: ['run', STRESS.rootScript, '--', '--json'],
      pair,
      role: 'stress',
    });
  }
  return steps;
}

const USAGE = [
  'usage:',
  '  node scripts/aggregation-evidence.mjs <report-path>',
  `  node scripts/aggregation-evidence.mjs --calibrate --pairs <${MIN_CALIBRATION_PAIRS}..${MAX_CALIBRATION_PAIRS}> <report-path>`,
].join('\n');

/**
 * The command line, as a value. Pure, so every refusal is unit-testable and
 * happens before any subprocess or database access.
 *
 * Returns `{ mode: 'evidence' | 'calibrate', pairs?, reportPath }`, or
 * `{ error, usage }` — never throws, never reads the environment. A pair count
 * comes from the command line only: an environment override would let a
 * campaign silently mean something else than its recorded invocation.
 */
export function parseEvidenceArgs(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const fail = (error) => ({ error, usage: USAGE });
  let calibrate = false;
  let pairsRaw = null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      // `pnpm run <script> -- …` forwards the separator itself. It carries no
      // meaning here, so it is skipped rather than mistaken for an option.
      continue;
    }
    if (arg === '--calibrate') {
      if (calibrate) return fail('--calibrate given more than once');
      calibrate = true;
    } else if (arg === '--pairs') {
      if (pairsRaw !== null) return fail('--pairs given more than once');
      // A following option is never the value: swallowing it would drop the
      // option silently and change what the campaign means.
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        return fail('--pairs needs a value');
      }
      pairsRaw = args[i + 1];
      i += 1;
    } else if (arg.startsWith('--pairs=')) {
      if (pairsRaw !== null) return fail('--pairs given more than once');
      pairsRaw = arg.slice('--pairs='.length);
      if (pairsRaw === '') return fail('--pairs needs a value');
    } else if (arg.startsWith('-')) {
      return fail(`unknown option ${JSON.stringify(arg)}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) return fail('a report path is required');
  if (positional.length > 1) return fail(`expected one report path, got ${positional.length}`);
  const reportPath = positional[0];

  if (!calibrate) {
    if (pairsRaw !== null) return fail('--pairs requires --calibrate');
    return { mode: 'evidence', reportPath };
  }
  if (pairsRaw === null) return fail('--calibrate requires --pairs');
  if (!/^\d+$/.test(pairsRaw)) {
    return fail(`--pairs must be a positive integer, got ${JSON.stringify(pairsRaw)}`);
  }
  const pairs = Number(pairsRaw);
  if (pairs < MIN_CALIBRATION_PAIRS || pairs > MAX_CALIBRATION_PAIRS) {
    return fail(
      `--pairs must be between ${MIN_CALIBRATION_PAIRS} and ${MAX_CALIBRATION_PAIRS}, got ${pairs}`,
    );
  }
  return { mode: 'calibrate', pairs, reportPath };
}

/**
 * Finite, secret-safe classification of why a step could not produce evidence.
 *
 * Input is the aggregate problem strings the harness already built — never raw
 * child-process output. Output is category counts and the matched reason codes,
 * so a report can say *what kind* of thing went wrong without carrying a URL, a
 * credential, a row or a test identifier.
 *
 * Deliberately contains no capability category: nothing here may become
 * "too slow".
 */
const INFRASTRUCTURE_CATEGORIES = Object.freeze([
  ['missingEnvironment', /missing environment|required environment/i],
  [
    'dockerUnavailable',
    /docker (?:not found|unavailable|could not start)|cannot connect to the docker/i,
  ],
  [
    'pgbenchUnavailable',
    /pgbench (?:not found|unavailable|is not installed)|executable file not found.*pgbench/i,
  ],
  ['psqlUnavailable', /psql (?:not found|unavailable|is not installed)/i],
  [
    'connectionFailure',
    /could not connect|connection refused|ECONNREFUSED|ECONNRESET|no such host|could not translate host/i,
  ],
  [
    'permissionDenied',
    /permission denied|must be superuser|insufficient privilege|denied for function/i,
  ],
  [
    'statsUnreadable',
    /pg_stat_wal: no row|pg_stat_wal could not be read|relation "pg_stat_wal" does not exist/i,
  ],
  ['statsReset', /pg_stat_wal went backwards/i],
  ['timeout', /after its bound|timed out|process bound exceeded|statement timeout/i],
  ['failedTransactions', /failed transaction\(s\)/i],
  ['controlContamination', /read-only control flushed WAL/i],
  ['backgroundWalContamination', /is not approximately one|below message \+ commit/i],
  ['noProgress', /reported no completed transaction|reported no tps|printed \d+ progress lines/i],
  [
    'harnessError',
    /exited \d+|could not be written|launcher not found|no jest report|collected no test/i,
  ],
]);

export function classifyInfrastructureProblems(problems) {
  const counts = Object.fromEntries([
    ...INFRASTRUCTURE_CATEGORIES.map(([name]) => [name, 0]),
    ['other', 0],
  ]);
  for (const problem of problems ?? []) {
    const text = String(problem);
    const matched = INFRASTRUCTURE_CATEGORIES.filter(([, pattern]) => pattern.test(text)).map(
      ([name]) => name,
    );
    for (const name of matched) counts[name] += 1;
    if (matched.length === 0) counts.other += 1;
  }
  return counts;
}

/** The category names, in report order. Fixed, so a report is deterministic. */
export const INFRASTRUCTURE_CATEGORY_NAMES = Object.freeze([
  ...INFRASTRUCTURE_CATEGORIES.map(([name]) => name),
  'other',
]);

/**
 * Count, min, median and max of the available values, plus how many were not
 * available. A missing value is never dropped from the denominator: `count` is
 * always how many samples were asked for.
 */
export function distribution(values) {
  const all = values ?? [];
  const usable = all
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);
  const middle =
    usable.length === 0
      ? null
      : usable.length % 2 === 1
        ? usable[(usable.length - 1) / 2]
        : (usable[usable.length / 2 - 1] + usable[usable.length / 2]) / 2;
  return {
    count: all.length,
    available: usable.length,
    unavailable: all.length - usable.length,
    min: usable.length === 0 ? null : usable[0],
    median: middle === null ? null : Number(middle.toFixed(3)),
    max: usable.length === 0 ? null : usable[usable.length - 1],
  };
}

/**
 * One calibration campaign as a value: a row per pair, and the distributions
 * across every pair that was attempted.
 *
 * `outcome` is validity only. A pair whose probe was valid but whose stress run
 * failed is still `VALID` — that combination is exactly the evidence ADR-055
 * wants, and calling it anything else would be the capability judgement this
 * mode refuses to make.
 */
export function summarizeCalibration({ pairs, results }) {
  const byId = Object.fromEntries((results ?? []).map((result) => [result.id, result]));
  const control = byId.control ?? null;
  const rows = [];
  for (let pair = 1; pair <= pairs; pair += 1) {
    const probeResult = byId[calibrationProbeId(pair)] ?? null;
    const stressResult = byId[calibrationStressId(pair)] ?? null;
    const probe = probeResult?.probe ?? null;
    const problems = [
      ...(probe?.problems ?? []),
      ...(probeResult?.error ? [probeResult.error] : []),
      ...(stressResult?.error ? [stressResult.error] : []),
      ...(stressResult?.summary?.problems ?? []),
    ];
    let outcome;
    if (!probeResult || !probe) outcome = 'INCONCLUSIVE';
    else if (probeResult.error) outcome = 'INCONCLUSIVE';
    else if (!probe.valid) outcome = 'INVALID';
    else outcome = 'VALID';
    rows.push({
      pair,
      outcome,
      probe: probe
        ? {
            transactions: probe.transactions,
            failed: probe.failed,
            tps: probe.tps,
            latencyAverageMs: probe.latencyAverageMs,
            walSyncDelta: probe.walSyncDelta,
            walSyncPerSecond: probe.walSyncPerSecond,
            walSyncPerTransaction: probe.walSyncPerTransaction,
            walRecordsPerTransaction: probe.walRecordsPerTransaction,
            minIntervalTps: probe.minIntervalTps,
            zeroCommitIntervals: probe.zeroCommitIntervals,
            longestZeroCommitSeconds: probe.longestZeroCommitSeconds,
            problems: probe.problems ?? [],
          }
        : null,
      stress: stressResult
        ? {
            ran: !stressResult.error,
            passed: stressResult.passed === true,
            exitCode: stressResult.exitCode ?? null,
            timedOut: stressResult.timedOut === true,
            wallSeconds:
              typeof stressResult.wallSeconds === 'number' ? stressResult.wallSeconds : null,
            tests: stressResult.summary?.tests ?? null,
            suites: stressResult.summary?.suites ?? null,
            failures: stressResult.summary?.failures ?? null,
            problems: stressResult.summary?.problems ?? [],
          }
        : null,
      infrastructure: classifyInfrastructureProblems(problems),
    });
  }
  const pick = (get) => distribution(rows.map(get));
  return {
    pairs,
    control: control
      ? { valid: control.probe?.valid === true, problems: control.probe?.problems ?? [] }
      : null,
    rows,
    outcomes: Object.fromEntries(
      CALIBRATION_OUTCOMES.map((name) => [name, rows.filter((row) => row.outcome === name).length]),
    ),
    stressPassed: rows.filter((row) => row.stress?.passed === true).length,
    stressFailed: rows.filter((row) => row.stress && row.stress.passed !== true).length,
    distributions: {
      probeTps: pick((row) => row.probe?.tps ?? null),
      probeMinIntervalTps: pick((row) => row.probe?.minIntervalTps ?? null),
      probeLongestStallSeconds: pick((row) => row.probe?.longestZeroCommitSeconds ?? null),
      stressWallSeconds: pick((row) => row.stress?.wallSeconds ?? null),
    },
    infrastructure: rows.reduce(
      (total, row) => {
        for (const name of INFRASTRUCTURE_CATEGORY_NAMES) {
          total[name] = (total[name] ?? 0) + row.infrastructure[name];
        }
        return total;
      },
      Object.fromEntries(INFRASTRUCTURE_CATEGORY_NAMES.map((name) => [name, 0])),
    ),
  };
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

function probeLines(label, result) {
  if (!result) return [`${label}: not run`];
  if (result.error) return [`${label}: valid=NO harness error: ${result.error}`];
  const { probe } = result;
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
  if (run.error) return [`${label}: result=FAIL harness error: ${run.error}`];
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
    'AUD-004 aggregation stress proof - commit-rate evidence',
    `commit=${meta.commit}${meta.runUrl ? ` run=${meta.runUrl}` : ''} generated=${meta.generatedAt}`,
    `topology: ${Object.entries(topology)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')}`,
    `named proof: "${NAMED_PROOF.title}"`,
    `named runs: ${NAMED_RUNS} fresh jest processes; full project: 1 fresh process via pnpm ${STRESS.rootScript}; no retries`,
    'burst figures come from pg_stat_wal sampled every ~1 s (backend counters flush about once per second)',
    '',
    ...probeLines('control (read-only SELECT 1, 1 client)', byId.control),
    ...probeLines('probe-before (pg_logical_emit_message, 1 client)', byId['probe-before']),
  ];
  for (let i = 1; i <= NAMED_RUNS; i += 1)
    lines.push(...jestLines(`named-${i}`, byId[`named-${i}`]));
  lines.push(...jestLines('full-project', byId['full-project']));
  lines.push(...probeLines('probe-after (pg_logical_emit_message, 1 client)', byId['probe-after']));
  const failed = results.filter((result) => !result.passed).map((result) => result.id);
  lines.push('', `verdict: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.join(', ')})`}`);
  return `${lines.join('\n')}\n`;
}

const distributionLine = (label, stats) =>
  `  ${label}: n=${stats.count} available=${stats.available} unavailable=${stats.unavailable} ` +
  `min=${fmt(stats.min)} median=${fmt(stats.median)} max=${fmt(stats.max)}`;

/**
 * The calibration artifact: aggregates only, and no capability claim anywhere.
 *
 * Every pair keeps its own line even when it failed, so the denominator of a
 * campaign is what was attempted rather than what happened to succeed.
 */
export function formatCalibrationReport({ meta, topology, summary }) {
  const lines = [
    'ADR-055 paired calibration - probe immediately followed by the unchanged stress project',
    `commit=${meta.commit}${meta.runUrl ? ` run=${meta.runUrl}` : ''} generated=${meta.generatedAt}`,
    `topology: ${Object.entries(topology)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')}`,
    `pairs: ${summary.pairs}; each pair is one ${PROBE_SECONDS} s validated WAL probe immediately followed by`,
    `  one fresh unfiltered \`pnpm ${STRESS.rootScript}\` (${STRESS.jestProject}, --runInBand, no retry)`,
    'validity only: VALID / INVALID / INCONCLUSIVE. No threshold, no margin, no capability judgement.',
    '',
    summary.control
      ? `control (read-only, ${CONTROL_SECONDS} s): valid=${summary.control.valid ? 'yes' : 'NO'}`
      : 'control: not run',
  ];
  for (const problem of summary.control?.problems ?? []) lines.push(`  problem: ${problem}`);
  lines.push('');

  for (const row of summary.rows) {
    lines.push(`pair-${row.pair}: outcome=${row.outcome}`);
    if (!row.probe) {
      lines.push('  probe: not run');
    } else {
      lines.push(
        `  probe: transactions=${row.probe.transactions} failed=${row.probe.failed} ` +
          `tps=${fmt(row.probe.tps)} latency_avg_ms=${fmt(row.probe.latencyAverageMs, 3)}`,
        `    wal_sync_delta=${row.probe.walSyncDelta} wal_sync_per_s=${fmt(row.probe.walSyncPerSecond)} ` +
          `wal_sync_per_tx=${fmt(row.probe.walSyncPerTransaction, 4)} wal_records_per_tx=${fmt(row.probe.walRecordsPerTransaction, 3)}`,
        `    min_interval_tps=${fmt(row.probe.minIntervalTps)} zero_commit_intervals=${row.probe.zeroCommitIntervals} ` +
          `longest_zero_commit_s=${fmt(row.probe.longestZeroCommitSeconds, 1)}`,
      );
      for (const problem of row.probe.problems) lines.push(`    problem: ${problem}`);
    }
    if (!row.stress) {
      lines.push('  stress: not run');
    } else {
      const t = row.stress.tests;
      const s = row.stress.suites;
      lines.push(
        `  stress: ran=${row.stress.ran ? 'yes' : 'NO'} result=${row.stress.passed ? 'PASS' : 'FAIL'} ` +
          `exit=${row.stress.exitCode === null ? 'n/a' : row.stress.exitCode}` +
          `${row.stress.timedOut ? ' (process bound exceeded)' : ''} wall_s=${fmt(row.stress.wallSeconds, 1)}`,
        `    suites passed/failed/skipped/total=${s ? `${s.passed}/${s.failed}/${s.skipped}/${s.total}` : 'n/a'} ` +
          `tests passed/failed/skipped/total=${t ? `${t.passed}/${t.failed}/${t.skipped}/${t.total}` : 'n/a'}`,
        `    failures: ${
          row.stress.failures
            ? Object.entries(row.stress.failures)
                .map(([name, count]) => `${name}=${count}`)
                .join(' ')
            : 'n/a'
        }`,
      );
      for (const problem of row.stress.problems) lines.push(`    problem: ${problem}`);
    }
    const categories = Object.entries(row.infrastructure).filter(([, count]) => count > 0);
    if (categories.length > 0) {
      lines.push(
        `  infrastructure: ${categories.map(([name, count]) => `${name}=${count}`).join(' ')}`,
      );
    }
  }

  lines.push(
    '',
    `outcomes: ${CALIBRATION_OUTCOMES.map((name) => `${name}=${summary.outcomes[name]}`).join(' ')}`,
    `stress: passed=${summary.stressPassed} failed=${summary.stressFailed} of ${summary.pairs}`,
    'distributions across every attempted pair:',
    distributionLine('probe_tps', summary.distributions.probeTps),
    distributionLine('probe_min_interval_tps', summary.distributions.probeMinIntervalTps),
    distributionLine('probe_longest_stall_s', summary.distributions.probeLongestStallSeconds),
    distributionLine('stress_wall_s', summary.distributions.stressWallSeconds),
    `infrastructure totals: ${INFRASTRUCTURE_CATEGORY_NAMES.map(
      (name) => `${name}=${summary.infrastructure[name]}`,
    ).join(' ')}`,
    '',
    'this campaign does not locate a capability boundary and proposes no threshold (ADR-055 § 6).',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * The half of the contract that is about the spec alone: the stress constants
 * and assertions are the ones every mode was measured against, and the spec
 * does not retry. Shared by the evidence campaign and the calibration mode so
 * there is exactly one definition of "unchanged proof".
 */
export function validateStressSpecContract(specSource) {
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
  return problems;
}

/**
 * Static contract for the evidence itself: the proof's stress constants are
 * the ones it was measured with, and the plan runs it the way the evidence
 * claims. Returns problem strings; empty means the contract holds.
 */
export function validateEvidenceContract({ specSource, plan }) {
  const problems = validateStressSpecContract(specSource);
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

/**
 * Static contract for a calibration campaign: the proof is the unchanged one,
 * and the plan really does pair each probe with the stress run immediately
 * after it.
 *
 * Adjacency is the whole point of the mode, so it is asserted structurally: the
 * stress step of pair `n` must be the very next step after its probe. Anything
 * between them — another probe, another suite, a second stress run — makes the
 * sample describe conditions the proof never met.
 */
export function validateCalibrationContract({ specSource, plan, pairs }) {
  const problems = validateStressSpecContract(specSource);
  const steps = plan ?? [];

  if (!Number.isInteger(pairs) || pairs < MIN_CALIBRATION_PAIRS || pairs > MAX_CALIBRATION_PAIRS) {
    problems.push(
      `calibration pairs must be an integer in ${MIN_CALIBRATION_PAIRS}..${MAX_CALIBRATION_PAIRS}, got ${JSON.stringify(pairs)}`,
    );
    return problems;
  }
  if (steps.length !== pairs * 2 + 1) {
    problems.push(
      `plan has ${steps.length} steps; ${pairs} pair(s) plus one control need ${pairs * 2 + 1}`,
    );
  }
  const control = steps[0];
  if (
    !control ||
    control.id !== 'control' ||
    control.control !== true ||
    control.kind !== 'probe'
  ) {
    problems.push('the read-only control must be the first step');
  } else if (control.seconds !== CONTROL_SECONDS) {
    problems.push(`the control must run ${CONTROL_SECONDS} s`);
  }
  if (steps.filter((step) => step.control === true).length !== 1) {
    problems.push('exactly one read-only control may run');
  }
  if (new Set(steps.map((step) => step.id)).size !== steps.length) {
    problems.push('calibration steps share an id');
  }

  for (let pair = 1; pair <= pairs; pair += 1) {
    const at = steps.findIndex((step) => step.id === calibrationProbeId(pair));
    if (at === -1) {
      problems.push(`pair ${pair} has no probe step`);
      continue;
    }
    const probe = steps[at];
    const next = steps[at + 1];
    if (probe.kind !== 'probe' || probe.control === true) {
      problems.push(`pair ${pair}'s probe must be a WAL-writing probe`);
    }
    if (probe.seconds !== PROBE_SECONDS) {
      problems.push(`pair ${pair}'s probe must run ${PROBE_SECONDS} s`);
    }
    problems.push(
      ...validateProbeSql(probe.sql, { control: false }).map((p) => `${probe.id}: ${p}`),
    );
    if (!next || next.id !== calibrationStressId(pair)) {
      problems.push(
        `pair ${pair}'s stress run must be the step immediately after its probe (found ${JSON.stringify(next?.id ?? null)})`,
      );
      continue;
    }
    if (next.kind !== 'jest-full') {
      problems.push(`pair ${pair}'s stress step must run the whole ${STRESS.jestProject} project`);
    }
    const args = next.pnpmArgs ?? [];
    if (args[0] !== 'run' || args[1] !== STRESS.rootScript) {
      problems.push(`pair ${pair} must run \`pnpm run ${STRESS.rootScript}\``);
    }
    if (args.slice(2).some((arg) => arg.startsWith('--testNamePattern') || arg.startsWith('-t'))) {
      problems.push(`pair ${pair}'s stress run must be unfiltered`);
    }
    if (args.includes('--passWithNoTests')) {
      problems.push(`pair ${pair} passes with no tests: a missing spec has to fail`);
    }
    if (args.some((arg) => /^--retry/.test(arg))) {
      problems.push(`pair ${pair} retries; a retried sample is not evidence`);
    }
  }

  // Nothing outside the control and the pairs may run: an unrelated step would
  // sit between some pair's probe and the suite that pair is meant to describe.
  for (const [index, step] of steps.entries()) {
    if (index === 0) continue;
    const expected =
      index % 2 === 1 ? calibrationProbeId((index + 1) / 2) : calibrationStressId(index / 2);
    if (step.id !== expected) {
      problems.push(`step ${index} is ${JSON.stringify(step.id)}; the pairs must run back to back`);
    }
  }
  if (steps.some((step) => step.kind === 'jest-named')) {
    problems.push('a calibration campaign runs the whole project, never a name-filtered proof');
  }
  return problems;
}
