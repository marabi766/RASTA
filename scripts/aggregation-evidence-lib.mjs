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
 * (`pnpm test:aggregation-evidence-lib`); the runner executes the plan. That
 * includes the diagnostic transport: `measureProbe` and `summarizeJestRun` take
 * their subprocess results as parameters, so why a step could not measure is
 * carried end to end and asserted without Docker or PostgreSQL.
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

/**
 * The same three labels as an object, so code names them instead of spelling
 * them. There is exactly one outcome vocabulary; this is a view of it.
 */
export const PROBE_OUTCOME = Object.freeze(
  Object.fromEntries(CALIBRATION_OUTCOMES.map((name) => [name, name])),
);

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

// ---------------------------------------------------------------------------
// Structured, secret-safe diagnostics
//
// Why a category is *carried* and never re-derived. A step that cannot produce
// evidence knows exactly why at the moment it fails — the child's own output is
// still in hand there, and nowhere else. Rendering that knowledge as prose and
// classifying the prose again later throws it away: a `psql` that could not
// reach the server becomes "something exited 1", and the campaign reports a
// harness error where an unreachable database happened.
//
// So the category is fixed **once**, at the source, and from then on only fixed
// category names, a fixed launcher identity, a fixed tool identity and numbers
// travel onward. The text beside them exists for a human to read; nothing
// downstream parses it, and no report depends on it.

/**
 * The finite infrastructure vocabulary — the one canonical set of reason codes.
 *
 * Deliberately contains no capability category: nothing here may become
 * "too slow".
 */
export const INFRASTRUCTURE_CATEGORY = Object.freeze({
  missingEnvironment: 'missingEnvironment',
  dockerUnavailable: 'dockerUnavailable',
  pgbenchUnavailable: 'pgbenchUnavailable',
  psqlUnavailable: 'psqlUnavailable',
  connectionFailure: 'connectionFailure',
  permissionDenied: 'permissionDenied',
  statsUnreadable: 'statsUnreadable',
  statsReset: 'statsReset',
  timeout: 'timeout',
  failedTransactions: 'failedTransactions',
  controlContamination: 'controlContamination',
  backgroundWalContamination: 'backgroundWalContamination',
  noProgress: 'noProgress',
  harnessError: 'harnessError',
});

/** The category names, in report order. Fixed, so a report is deterministic. */
export const INFRASTRUCTURE_CATEGORY_NAMES = Object.freeze([
  ...Object.values(INFRASTRUCTURE_CATEGORY),
  'other',
]);

const KNOWN_CATEGORIES = new Set(INFRASTRUCTURE_CATEGORY_NAMES);

/**
 * What each category says about the *measurement*, per ADR-055 § 4. One table,
 * consulted by one resolver; nothing here is derived from text.
 *
 * The split is not about speed — no entry may ever mean "too slow". It is about
 * whether a measurement exists at all:
 *
 * - `INCONCLUSIVE` — nothing trustworthy was measured, so nothing may be said
 *   about the measurement. Reporting these as `INVALID` would claim a sample was
 *   taken and found wanting, when in fact no sample was taken.
 * - `INVALID` — the probe reached the server and the resulting measurement fails
 *   the unchanged `PROBE_VALIDITY` bounds, or the server refused the probe
 *   itself. ADR-055 § 4 names the `pg_logical_emit_message` privilege refusal
 *   `INVALID`, so `permissionDenied` sits here even when it surfaces before any
 *   figure is produced; what it must never do is produce a fabricated figure.
 */
export const CATEGORY_VALIDITY = Object.freeze({
  [INFRASTRUCTURE_CATEGORY.missingEnvironment]: 'INCONCLUSIVE',
  [INFRASTRUCTURE_CATEGORY.dockerUnavailable]: 'INCONCLUSIVE',
  [INFRASTRUCTURE_CATEGORY.pgbenchUnavailable]: 'INCONCLUSIVE',
  [INFRASTRUCTURE_CATEGORY.psqlUnavailable]: 'INCONCLUSIVE',
  [INFRASTRUCTURE_CATEGORY.connectionFailure]: 'INCONCLUSIVE',
  [INFRASTRUCTURE_CATEGORY.statsUnreadable]: 'INCONCLUSIVE',
  [INFRASTRUCTURE_CATEGORY.timeout]: 'INCONCLUSIVE',
  [INFRASTRUCTURE_CATEGORY.harnessError]: 'INCONCLUSIVE',
  // An unclassified failure is inconclusive for the same reason: if the harness
  // cannot name what went wrong, it certainly cannot vouch for a measurement.
  other: 'INCONCLUSIVE',
  [INFRASTRUCTURE_CATEGORY.permissionDenied]: 'INVALID',
  [INFRASTRUCTURE_CATEGORY.statsReset]: 'INVALID',
  [INFRASTRUCTURE_CATEGORY.failedTransactions]: 'INVALID',
  [INFRASTRUCTURE_CATEGORY.controlContamination]: 'INVALID',
  [INFRASTRUCTURE_CATEGORY.backgroundWalContamination]: 'INVALID',
  // Only `summarizeProbe` emits this, and only from a pgbench run whose output
  // was in hand — so it always describes a measurement that was attempted and
  // came back empty, not a process that never ran. A pgbench that did not
  // complete adds its own inconclusive category, which wins below.
  [INFRASTRUCTURE_CATEGORY.noProgress]: 'INVALID',
});

/**
 * Known names only, deduplicated, in report order — the single normalization
 * path. An unknown name is dropped rather than invented into the vocabulary.
 */
export function normalizeCategories(categories) {
  const seen = new Set();
  for (const value of categories ?? []) if (KNOWN_CATEGORIES.has(value)) seen.add(value);
  return INFRASTRUCTURE_CATEGORY_NAMES.filter((name) => seen.has(name));
}

/** One diagnostic: its fixed categories, and the aggregate line a human reads. */
export function diagnostic(categories, text) {
  return { categories: normalizeCategories(categories), text: String(text) };
}

/**
 * The single counting path. A diagnostic adds one to each of its categories; a
 * diagnostic that carries none adds one to `other`, so nothing is dropped
 * silently. Counting the same diagnostic twice is impossible because a result
 * keeps exactly one list.
 */
export function countCategories(diagnostics) {
  const counts = Object.fromEntries(INFRASTRUCTURE_CATEGORY_NAMES.map((name) => [name, 0]));
  for (const entry of diagnostics ?? []) {
    const names = normalizeCategories(entry?.categories);
    if (names.length === 0) counts.other += 1;
    else for (const name of names) counts[name] += 1;
  }
  return counts;
}

/**
 * The validity outcome a set of attached diagnostics implies.
 *
 * `INCONCLUSIVE` dominates `INVALID` whenever both apply: an absent or
 * untrustworthy measurement must never be presented as a measured sample that
 * failed. Both flags are collected before deciding, so the answer cannot depend
 * on the order the diagnostics arrived in.
 *
 * `VALID` needs *no* diagnostic at all — it is the absence of any reason to
 * doubt, never the failure to recognize one.
 */
export function outcomeForDiagnostics(diagnostics) {
  let inconclusive = false;
  let invalid = false;
  for (const entry of diagnostics ?? []) {
    const names = normalizeCategories(entry?.categories);
    // A diagnostic whose categories nobody recognized counts as `other`, the
    // same way `countCategories` counts it.
    for (const name of names.length === 0 ? ['other'] : names) {
      if (CATEGORY_VALIDITY[name] === PROBE_OUTCOME.INCONCLUSIVE) inconclusive = true;
      if (CATEGORY_VALIDITY[name] === PROBE_OUTCOME.INVALID) invalid = true;
    }
  }
  if (inconclusive) return PROBE_OUTCOME.INCONCLUSIVE;
  return invalid ? PROBE_OUTCOME.INVALID : PROBE_OUTCOME.VALID;
}

/**
 * Fixes a probe's explicit outcome from the diagnostics attached to it, and
 * derives `valid` from that one decision.
 *
 * Called again whenever a diagnostic is added after the fact, so `outcome` and
 * `valid` always describe the complete set. `valid` stays only because the
 * legacy evidence report prints it; it is a view of `outcome`, never a second
 * opinion.
 */
export function sealProbeOutcome(probe) {
  probe.outcome = outcomeForDiagnostics(probe.diagnostics);
  probe.valid = probe.outcome === PROBE_OUTCOME.VALID;
  return probe;
}

/** Sums category counts, keeping every name in the total even at zero. */
export function totalCategories(counts) {
  return counts.reduce(
    (total, one) => {
      for (const name of INFRASTRUCTURE_CATEGORY_NAMES) total[name] += one?.[name] ?? 0;
      return total;
    },
    Object.fromEntries(INFRASTRUCTURE_CATEGORY_NAMES.map((name) => [name, 0])),
  );
}

/**
 * Records one diagnostic on a probe or a suite summary, keeping its text in the
 * human-readable `problems` list. The two lists are written together here and
 * nowhere else, so they cannot drift and `problems` is never the source of a
 * category.
 */
export function addDiagnostic(target, entry) {
  target.diagnostics.push(entry);
  target.problems.push(entry.text);
  return target;
}

/**
 * A failure that already knows its categories. It carries no child output, no
 * command arguments, no connection data and no OS error text — only the fixed
 * diagnostic built where the cause was still visible.
 */
export class DiagnosticError extends Error {
  constructor(entry) {
    super(entry.text);
    this.name = 'DiagnosticError';
    this.diagnostic = entry;
  }
}

/**
 * Any thrown value as a fixed diagnostic. A throw that did not bring its own
 * categories keeps `harnessError` and **loses its message**: an arbitrary
 * message can carry a path, a username, a host or a credential, and no report
 * needs one.
 */
export function diagnosticFromError(error) {
  const attached = error?.diagnostic;
  if (attached && Array.isArray(attached.categories)) {
    return diagnostic(attached.categories, attached.text ?? 'the step could not measure');
  }
  return diagnostic([INFRASTRUCTURE_CATEGORY.harnessError], 'the step could not measure');
}

/**
 * The fixed launchers this harness may start. A diagnostic names one of these
 * and never a command line, so a reader learns *what* was asked for without the
 * arguments, the environment or the connection behind it.
 */
export const LAUNCHER = Object.freeze({
  docker: 'docker',
  pnpm: 'pnpm',
  jest: 'jest',
  git: 'git',
});

/** The fixed tools run inside the pinned PostgreSQL image, through `docker`. */
export const IN_IMAGE_TOOL = Object.freeze({ psql: 'psql', pgbench: 'pgbench' });

/**
 * How a bounded process ended. Three outcomes, and never an OS error message:
 * the launcher itself could not start, the child ran to an exit code, or the
 * hard time bound killed it.
 */
export const PROCESS_OUTCOME = Object.freeze({
  completed: 'completed',
  launcherFailed: 'launcherFailed',
  timedOut: 'timedOut',
});

/**
 * What a child's *own* output shows. These patterns describe Docker's and
 * PostgreSQL's messages — not this harness's prose — and they are applied
 * exactly once, where the raw text is still in hand. Only fixed names leave.
 */
const OUTPUT_CATEGORIES = Object.freeze([
  [
    INFRASTRUCTURE_CATEGORY.dockerUnavailable,
    /cannot connect to the docker daemon|is the docker daemon running|error during connect|docker daemon is not running|docker: command not found/i,
  ],
  [
    INFRASTRUCTURE_CATEGORY.connectionFailure,
    /could not connect|connection to server .{0,200}failed|connection refused|ECONNREFUSED|ECONNRESET|no such host|could not translate host|server closed the connection unexpectedly|password authentication failed/i,
  ],
  [
    INFRASTRUCTURE_CATEGORY.permissionDenied,
    /permission denied|must be superuser|insufficient privilege|denied for function/i,
  ],
  [INFRASTRUCTURE_CATEGORY.statsUnreadable, /relation "pg_stat_wal" does not exist/i],
  [INFRASTRUCTURE_CATEGORY.timeout, /canceling statement due to statement timeout|\b57014\b/i],
]);

/**
 * A container that started but could not exec what was asked of it. Which tool
 * is missing comes from the **request**, not from the text: the runner names
 * the in-image tool it launched, so `psql` and `pgbench` stay distinguishable
 * without parsing a message for a program name.
 */
const EXECUTABLE_MISSING = /executable file not found|command not found|no such file or directory/i;

export function categoriesFromProcessOutput(text, { tool = null } = {}) {
  const output = String(text ?? '');
  const found = new Set();
  for (const [name, pattern] of OUTPUT_CATEGORIES) if (pattern.test(output)) found.add(name);
  if (EXECUTABLE_MISSING.test(output)) {
    if (tool === IN_IMAGE_TOOL.psql) found.add(INFRASTRUCTURE_CATEGORY.psqlUnavailable);
    else if (tool === IN_IMAGE_TOOL.pgbench) found.add(INFRASTRUCTURE_CATEGORY.pgbenchUnavailable);
    else found.add(INFRASTRUCTURE_CATEGORY.harnessError);
  }
  return normalizeCategories([...found]);
}

const known = (value, vocabulary) => (Object.values(vocabulary).includes(value) ? value : null);

/**
 * The finite diagnostic of one bounded process result.
 *
 * It reads the child's output only to match it once, here. What it returns is
 * fixed category names, a fixed launcher, a fixed tool and numbers — no output,
 * no arguments, no environment, no connection data. A launcher that could not
 * spawn is typed by *which* launcher it was, so a Docker CLI that cannot start
 * or cannot reach its daemon is `dockerUnavailable` rather than an anonymous
 * exit 127.
 */
export function processDiagnostic({
  launcher,
  tool = null,
  outcome,
  exitCode = null,
  output = '',
} = {}) {
  const requestedTool = known(tool, IN_IMAGE_TOOL);
  const requestedLauncher = known(launcher, LAUNCHER);
  const found = new Set(categoriesFromProcessOutput(output, { tool: requestedTool }));
  if (outcome === PROCESS_OUTCOME.timedOut) found.add(INFRASTRUCTURE_CATEGORY.timeout);
  if (outcome === PROCESS_OUTCOME.launcherFailed) {
    found.add(
      requestedLauncher === LAUNCHER.docker
        ? INFRASTRUCTURE_CATEGORY.dockerUnavailable
        : INFRASTRUCTURE_CATEGORY.harnessError,
    );
  }
  // A nonzero exit nobody recognized is still a harness fact, not an unknown.
  if (found.size === 0) found.add(INFRASTRUCTURE_CATEGORY.harnessError);
  return {
    launcher: requestedLauncher,
    tool: requestedTool,
    outcome: known(outcome, PROCESS_OUTCOME) ?? PROCESS_OUTCOME.launcherFailed,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    categories: normalizeCategories([...found]),
  };
}

/** The one human-readable line for a process diagnostic: fixed words, fixed names, numbers. */
export function describeProcessDiagnostic(detail) {
  const launcher = detail.launcher ?? 'an unpinned launcher';
  const what = detail.tool ? `${detail.tool} via ${launcher}` : launcher;
  const how =
    detail.outcome === PROCESS_OUTCOME.launcherFailed
      ? 'could not start'
      : detail.outcome === PROCESS_OUTCOME.timedOut
        ? 'exceeded its time bound'
        : `exited ${detail.exitCode === null ? 'unknown' : detail.exitCode}`;
  return `${what} ${how} (${detail.categories.join(', ') || 'other'})`;
}

/** One bounded process result as a diagnostic ready to record. */
export function processDiagnosticEntry(result, note = '') {
  const detail = processDiagnostic(result ?? {});
  return diagnostic(
    detail.categories,
    `${describeProcessDiagnostic(detail)}${note ? ` ${note}` : ''}`,
  );
}

/**
 * The output of a bounded result that succeeded, or a typed refusal carrying
 * the categories of why it did not. The refusal never carries the output.
 */
export function checkedOutput(result) {
  if (result?.outcome !== PROCESS_OUTCOME.completed || result?.exitCode !== 0) {
    throw new DiagnosticError(processDiagnosticEntry(result));
  }
  return String(result.output ?? '');
}

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
 * The explicit validity outcome of one probe step, as the step recorded it.
 *
 * Nothing here reads `problems` prose or falls back to `valid === false`. A step
 * that never produced a probe at all is judged from the typed diagnostics it
 * did carry; a step that is simply absent, or that somehow carries neither, is
 * `INCONCLUSIVE` — refusing to guess is the whole point.
 */
export function probeOutcomeOf(result) {
  if (!result) return PROBE_OUTCOME.INCONCLUSIVE;
  const explicit = result.probe?.outcome;
  if (CALIBRATION_OUTCOMES.includes(explicit)) return explicit;
  if (!result.probe && (result.diagnostics?.length ?? 0) > 0) {
    return outcomeForDiagnostics(result.diagnostics);
  }
  return PROBE_OUTCOME.INCONCLUSIVE;
}

/**
 * One calibration campaign as a value: a row per pair, and the distributions
 * across every pair that was attempted.
 *
 * `outcome` is validity only, and it is **read** from the probe rather than
 * inferred here: the probe fixed it where it knew whether a trustworthy
 * measurement existed. Inferring it from `valid === false` is exactly the bug
 * this replaced — it turned an unreachable server into a measured invalid
 * sample.
 *
 * A pair whose probe was valid but whose stress run failed is still `VALID` —
 * that combination is exactly the evidence ADR-055 wants, and calling it
 * anything else would be the capability judgement this mode refuses to make.
 */
export function summarizeCalibration({ pairs, results }) {
  const byId = Object.fromEntries((results ?? []).map((result) => [result.id, result]));
  const control = byId.control ?? null;
  // Categories come from the diagnostics a step already attached, never from
  // re-reading the prose it also produced.
  const diagnosticsOf = (result) => result?.diagnostics ?? [];
  const rows = [];
  for (let pair = 1; pair <= pairs; pair += 1) {
    const probeResult = byId[calibrationProbeId(pair)] ?? null;
    const stressResult = byId[calibrationStressId(pair)] ?? null;
    const probe = probeResult?.probe ?? null;
    rows.push({
      pair,
      outcome: probeOutcomeOf(probeResult),
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
      infrastructure: countCategories([
        ...diagnosticsOf(probeResult),
        ...diagnosticsOf(stressResult),
      ]),
    });
  }
  const pick = (get) => distribution(rows.map(get));
  // The control is not a pair, so it keeps its own explicit fixed-category
  // total rather than being folded into the per-pair denominator. A failed
  // control is then a number, not only a sentence.
  const controlInfrastructure = countCategories(diagnosticsOf(control));
  // A control that never ran is `INCONCLUSIVE`, not "valid=no": the counter was
  // never confirmed either way, and saying otherwise would claim a check that
  // did not happen.
  const controlOutcome = probeOutcomeOf(control);
  return {
    pairs,
    control: control
      ? {
          outcome: controlOutcome,
          valid: controlOutcome === PROBE_OUTCOME.VALID,
          problems: control.probe?.problems ?? [],
          infrastructure: controlInfrastructure,
        }
      : null,
    controlOutcome,
    controlInfrastructure,
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
    infrastructure: totalCategories(rows.map((row) => row.infrastructure)),
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

/**
 * `wal_records|wal_sync|wal_write|wal_bytes` from psql's unaligned tuples-only
 * output. Output that is not that shape refuses with `statsUnreadable`: without
 * the counter no validity can be shown, and that is not a harness error.
 */
export function parseWalStat(text) {
  const line = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^\d+\|\d+\|\d+\|\d+$/.test(l));
  if (!line) {
    throw new DiagnosticError(
      diagnostic(
        [INFRASTRUCTURE_CATEGORY.statsUnreadable],
        'pg_stat_wal: no row in the expected shape',
      ),
    );
  }
  const [walRecords, walSync, walWrite, walBytes] = line.split('|').map(Number);
  return { walRecords, walSync, walWrite, walBytes };
}

/** The `pg_stat_wal` reading behind one bounded `psql` result, or a typed refusal. */
export const walStatFrom = (result) => parseWalStat(checkedOutput(result));

/**
 * Joins a pgbench run with the `pg_stat_wal` readings around it and judges
 * validity. Every validity problem is recorded with its canonical category at
 * the point it is found, so nothing downstream has to read the sentence back.
 */
export function summarizeProbe({ pgbench, before, after, seconds, control = false }) {
  const found = { problems: [], diagnostics: [] };
  const record = (categories, text) => addDiagnostic(found, diagnostic(categories, text));
  const { problems } = found;
  const syncDelta = after.walSync - before.walSync;
  const recordDelta = after.walRecords - before.walRecords;
  const transactions = pgbench.transactions ?? 0;
  if (!Number.isInteger(pgbench.transactions) || transactions <= 0) {
    record([INFRASTRUCTURE_CATEGORY.noProgress], 'pgbench reported no completed transaction');
  }
  if (pgbench.failed !== 0) {
    record(
      [INFRASTRUCTURE_CATEGORY.failedTransactions],
      `pgbench reported ${pgbench.failed} failed transaction(s)`,
    );
  }
  if (pgbench.tps === null) record([INFRASTRUCTURE_CATEGORY.noProgress], 'pgbench reported no tps');
  if (pgbench.progressIntervals < Math.floor(seconds * 0.9)) {
    record(
      [INFRASTRUCTURE_CATEGORY.noProgress],
      `pgbench printed ${pgbench.progressIntervals} progress lines for ${seconds} s`,
    );
  }
  if (syncDelta < 0 || recordDelta < 0) {
    record([INFRASTRUCTURE_CATEGORY.statsReset], 'pg_stat_wal went backwards (stats reset?)');
  }
  const syncPerTransaction = transactions > 0 ? syncDelta / transactions : null;
  const recordsPerTransaction = transactions > 0 ? recordDelta / transactions : null;
  if (syncPerTransaction !== null) {
    if (control) {
      if (syncPerTransaction > PROBE_VALIDITY.maxControlSyncPerTransaction) {
        record(
          [INFRASTRUCTURE_CATEGORY.controlContamination],
          `read-only control flushed WAL ${syncPerTransaction.toFixed(4)} times per transaction`,
        );
      }
    } else {
      if (
        syncPerTransaction < PROBE_VALIDITY.minSyncPerTransaction ||
        syncPerTransaction > PROBE_VALIDITY.maxSyncPerTransaction
      ) {
        record(
          [INFRASTRUCTURE_CATEGORY.backgroundWalContamination],
          `wal_sync per transaction ${syncPerTransaction.toFixed(3)} is not approximately one`,
        );
      }
      if (recordsPerTransaction < PROBE_VALIDITY.minRecordsPerTransaction) {
        record(
          [INFRASTRUCTURE_CATEGORY.backgroundWalContamination],
          `wal_records per transaction ${recordsPerTransaction.toFixed(3)} is below message + commit`,
        );
      }
    }
  }
  // This probe reached the server and produced figures, so its outcome is
  // whatever those figures earned: `VALID`, or `INVALID` for a measurement that
  // failed the bounds. `measureProbe` seals it again if the pgbench process
  // itself turns out not to have completed.
  return sealProbeOutcome({
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
    problems,
    diagnostics: found.diagnostics,
  });
}

/**
 * A probe that never measured: the shape of a real one, its diagnostics, and
 * **no figures at all**.
 *
 * Every numeric field is `null` rather than `0`. A zero is an observation — it
 * says the probe ran and committed nothing — and this probe did not run. The
 * distributions already treat `null` as unavailable while keeping the pair in
 * the denominator, which is exactly what an attempted-but-unmeasured sample is.
 */
export function emptyProbe(step, diagnostics) {
  const entries = diagnostics ?? [];
  return sealProbeOutcome({
    control: step.control === true,
    seconds: step.seconds,
    transactions: null,
    failed: null,
    tps: null,
    latencyAverageMs: null,
    walSyncDelta: null,
    walSyncPerSecond: null,
    walSyncPerTransaction: null,
    walRecordsPerTransaction: null,
    minIntervalTps: null,
    zeroCommitIntervals: null,
    longestZeroCommitSeconds: null,
    problems: entries.map((entry) => entry.text),
    diagnostics: [...entries],
  });
}

/**
 * One probe step as a value: the `pg_stat_wal` readings around one `pgbench`
 * run, joined and judged.
 *
 * Both subprocesses are **injected**, so the whole diagnostic transport — a
 * bounded process result becoming a typed diagnostic, that diagnostic reaching
 * a probe result, and the probe result reaching a campaign summary — is
 * exercised without Docker or PostgreSQL. `readWalStat` is expected to throw a
 * `DiagnosticError`; `runPgbench` resolves to a bounded process result. Neither
 * the output nor the thrown message is retained.
 */
export async function measureProbe(step, { readWalStat, runPgbench, settle }) {
  let before;
  let after;
  let bench;
  try {
    before = await readWalStat();
    bench = await runPgbench(step);
    // A backend flushes its WAL counters when it exits; give that a moment.
    if (settle) await settle();
    after = await readWalStat();
  } catch (error) {
    // Nothing was measured. The probe carries the typed reason and no figures;
    // its outcome comes from that reason, so an unreachable server is
    // `INCONCLUSIVE` rather than a zero-valued sample that "failed validity".
    const probe = emptyProbe(step, [diagnosticFromError(error)]);
    return { id: step.id, passed: false, probe, diagnostics: probe.diagnostics };
  }
  const probe = summarizeProbe({
    pgbench: parsePgbenchOutput(bench.output),
    before,
    after,
    seconds: step.seconds,
    control: step.control === true,
  });
  if (bench.outcome !== PROCESS_OUTCOME.completed || bench.exitCode !== 0) {
    // The pgbench process did not complete, so whatever its output parsed to is
    // not an observation — a partial or absent summary parses to zeros that a
    // distribution would happily average. Every category found so far is kept,
    // including the validity ones, but the figures are dropped: the process
    // diagnostic makes this `INCONCLUSIVE`, and an inconclusive probe must
    // contribute no numbers at all.
    const unmeasured = emptyProbe(step, [...probe.diagnostics, processDiagnosticEntry(bench)]);
    return { id: step.id, passed: false, probe: unmeasured, diagnostics: unmeasured.diagnostics };
  }
  return { id: step.id, passed: probe.valid, probe, diagnostics: probe.diagnostics };
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
  const found = { problems: [], diagnostics: [] };
  const record = (categories, text) => addDiagnostic(found, diagnostic(categories, text));
  const { problems } = found;
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

  // A missing or empty report is a harness fact. A report that exists and says
  // tests failed is a *product* outcome, so it deliberately carries no
  // infrastructure category and lands in `other` rather than being dressed up
  // as an environment problem.
  if (!report || typeof report.numTotalTests !== 'number') {
    record([INFRASTRUCTURE_CATEGORY.harnessError], 'no jest report');
  }
  if ((report?.numTotalTests ?? 0) === 0) {
    record([INFRASTRUCTURE_CATEGORY.harnessError], 'jest collected no test');
  }
  if ((report?.numFailedTests ?? 0) > 0) record([], `${report.numFailedTests} test(s) failed`);
  if ((report?.numFailedTestSuites ?? 0) > 0 || (report?.numRuntimeErrorTestSuites ?? 0) > 0) {
    record([], 'a test suite failed');
  }
  if (report && report.success !== true) record([], 'jest did not report success');

  let namedDurationMs = null;
  if (expectNamed) {
    const fullName = [...NAMED_PROOF.describePath, NAMED_PROOF.title].join(' ');
    if (ran.length !== 1 || ran[0].fullName !== fullName) {
      record([], `the name filter ran ${ran.length} test(s); exactly the named proof must run`);
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
    diagnostics: found.diagnostics,
  };
}

/**
 * One jest step as a value: its aggregates, its diagnostics, and the WAL span
 * around it.
 *
 * Takes the bounded process result rather than running anything, so the same
 * transport can be exercised without jest, Docker or PostgreSQL. A run that
 * produced a report but failed tests keeps only the report's own problems — an
 * ordinary failing proof must not be relabelled as an infrastructure failure —
 * while a run that produced no report, or whose process never started or was
 * killed by its bound, carries the process diagnostic instead.
 */
export function summarizeJestRun({ step, result, report = null, walBefore, walAfter, samples }) {
  const summary = summarizeJestReport(report, { expectNamed: step.kind === 'jest-named' });
  if (!report) {
    addDiagnostic(summary, processDiagnosticEntry(result, 'and wrote no jest report'));
  } else if (result?.outcome !== PROCESS_OUTCOME.completed) {
    addDiagnostic(summary, processDiagnosticEntry(result));
  }
  const wallSeconds = (result.endedAt - result.startedAt) / 1000;
  const wal =
    walBefore && walAfter
      ? {
          walSyncDelta: walAfter.walSync - walBefore.walSync,
          walSyncPerSecond: (walAfter.walSync - walBefore.walSync) / wallSeconds,
        }
      : null;
  if (!wal) {
    addDiagnostic(
      summary,
      diagnostic(
        [INFRASTRUCTURE_CATEGORY.statsUnreadable],
        'pg_stat_wal could not be read around the run',
      ),
    );
  }
  const timedOut = result.outcome === PROCESS_OUTCOME.timedOut;
  return {
    id: step.id,
    passed:
      result.exitCode === 0 &&
      result.outcome === PROCESS_OUTCOME.completed &&
      summary.problems.length === 0,
    exitCode: result.exitCode,
    timedOut,
    startedAt: result.startedAt.toISOString(),
    endedAt: result.endedAt.toISOString(),
    wallSeconds,
    summary,
    wal,
    burst: samples ? summarizeBurst(samples) : null,
    diagnostics: summary.diagnostics,
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
  // Every figure goes through `fmt`, so a probe that never measured prints
  // `n/a` rather than a zero a reader would take for an observation.
  const lines = [
    `${label}: valid=${probe.valid ? 'yes' : 'NO'} outcome=${probe.outcome ?? 'n/a'} ` +
      `seconds=${probe.seconds} transactions=${fmt(probe.transactions, 0)} ` +
      `failed=${fmt(probe.failed, 0)} tps=${fmt(probe.tps)} latency_avg_ms=${fmt(probe.latencyAverageMs, 3)}`,
    `  wal_sync_delta=${fmt(probe.walSyncDelta, 0)} wal_sync_per_s=${fmt(probe.walSyncPerSecond)} ` +
      `wal_sync_per_tx=${fmt(probe.walSyncPerTransaction, 4)} wal_records_per_tx=${fmt(probe.walRecordsPerTransaction, 3)}`,
    `  min_interval_tps=${fmt(probe.minIntervalTps)} zero_commit_intervals=${fmt(probe.zeroCommitIntervals, 0)} ` +
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
      ? `control (read-only, ${CONTROL_SECONDS} s): outcome=${summary.control.outcome} valid=${
          summary.control.valid ? 'yes' : 'NO'
        }`
      : `control: not run, outcome=${summary.controlOutcome ?? PROBE_OUTCOME.INCONCLUSIVE}`,
  ];
  for (const problem of summary.control?.problems ?? []) lines.push(`  problem: ${problem}`);
  lines.push(
    `  control infrastructure: ${INFRASTRUCTURE_CATEGORY_NAMES.map(
      (name) => `${name}=${summary.controlInfrastructure?.[name] ?? 0}`,
    ).join(' ')}`,
    '',
  );

  for (const row of summary.rows) {
    lines.push(`pair-${row.pair}: outcome=${row.outcome}`);
    if (!row.probe) {
      lines.push('  probe: not run');
    } else {
      lines.push(
        `  probe: transactions=${fmt(row.probe.transactions, 0)} failed=${fmt(row.probe.failed, 0)} ` +
          `tps=${fmt(row.probe.tps)} latency_avg_ms=${fmt(row.probe.latencyAverageMs, 3)}`,
        `    wal_sync_delta=${fmt(row.probe.walSyncDelta, 0)} wal_sync_per_s=${fmt(row.probe.walSyncPerSecond)} ` +
          `wal_sync_per_tx=${fmt(row.probe.walSyncPerTransaction, 4)} wal_records_per_tx=${fmt(row.probe.walRecordsPerTransaction, 3)}`,
        `    min_interval_tps=${fmt(row.probe.minIntervalTps)} zero_commit_intervals=${fmt(row.probe.zeroCommitIntervals, 0)} ` +
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
    `infrastructure totals across pairs: ${INFRASTRUCTURE_CATEGORY_NAMES.map(
      (name) => `${name}=${summary.infrastructure[name]}`,
    ).join(' ')}`,
    `control infrastructure totals: ${INFRASTRUCTURE_CATEGORY_NAMES.map(
      (name) => `${name}=${summary.controlInfrastructure?.[name] ?? 0}`,
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
