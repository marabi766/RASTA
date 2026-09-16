/**
 * Slot accounting for the preregistered ADR-055 fresh-run campaign — the pure
 * half of `aggregation-campaign-accounting.mjs`.
 *
 * The preregistration
 * (`docs/evidence/adr-055/fresh-run-first-pair-replication-design-2026-09-16.md`)
 * fixes 59 slots, one pair per fresh job, and § 8.4 fixes how they are counted:
 * enumerate slot indices `1..59` — never artifacts found, never jobs that
 * succeeded — and resolve each to exactly one of four states **from report
 * content**:
 *
 * - `non-event` — an eligible `VALID` pair whose unchanged suite passed;
 * - `event` — an eligible `VALID` pair whose unchanged suite failed with
 *   environment categories only and every product-assertion category zero;
 * - `blocker` — anything § 5.2 names a blocker: `INVALID`/`INCONCLUSIVE`, a
 *   suite that did not run, a process bound, a product, mixed, unclassified or
 *   unknown failure, a campaign refusal;
 * - `missing` — no report for the index, a report that does not parse, a slot
 *   claimed more than once, or provenance that does not match across reports.
 *
 * **Job conclusions are never an input.** A qualifying event is a red job by
 * design, so a job's colour carries no information about a slot. Neither does
 * a file name, an artifact name or the order reports were given in: every
 * decision here is a function of the multiset of report texts.
 *
 * **Nothing here interprets the campaign.** The output is per-slot states and
 * their totals — the inputs to the preregistered branches of § 6, for a human
 * to apply. No threshold, margin, p-value, replacement, retry, optional
 * stopping or acceptance decision exists in this file.
 *
 * Every rule fails closed: a line that is not exactly the shape the calibration
 * report renders makes the report unparseable, and an unparseable report never
 * becomes an event or a non-event.
 */
import { createHash } from 'node:crypto';

import {
  CALIBRATION_OUTCOMES,
  CALIBRATION_REPORT_FOOTER,
  CALIBRATION_REPORT_HEADER,
  CAMPAIGN_SLOT_FIELD,
  FAILURE_CATEGORY_PARTITION,
  INFRASTRUCTURE_CATEGORY_NAMES,
  MAX_CAMPAIGN_SLOT,
  MIN_CAMPAIGN_SLOT,
  PROBE_SECONDS,
  classifyFailures,
} from './aggregation-evidence-lib.mjs';

/** The preregistered denominator. Fixed by § 3, never derived from the inputs. */
export const CAMPAIGN_SLOT_COUNT = MAX_CAMPAIGN_SLOT - MIN_CAMPAIGN_SLOT + 1;

/** The four slot states of § 8.4, in report order. */
export const SLOT_STATE = Object.freeze({
  nonEvent: 'non-event',
  event: 'event',
  blocker: 'blocker',
  missing: 'missing',
});

/** The failure category names a calibration report prints, in its order. */
export const FAILURE_CATEGORY_NAMES = Object.freeze(Object.keys(classifyFailures([])));

const DISTRIBUTIONS = Object.freeze([
  'probe_tps',
  'probe_min_interval_tps',
  'probe_longest_stall_s',
  'stress_wall_s',
]);

const COMMIT = /^[0-9a-f]{40}$/;
const COUNT = /^\d+$/;
const PAIRS_LINE = new RegExp(
  `^pairs: (\\d+)( requested, 0 attempted)?; each pair is one ${PROBE_SECONDS} s validated WAL probe immediately followed by$`,
);
const PREFLIGHT_PASSED = 'campaign preflight: passed';
const PREFLIGHT_REFUSED =
  'campaign preflight: REFUSED before any measurement - no control, probe or stress step was started';
const CONTROL_RAN = /^control \(read-only, \d+ s\): outcome=(\w+) valid=(yes|NO)$/;
const CONTROL_NOT_RUN = /^control: not run, outcome=(\w+)$/;
const STRESS_LINE =
  /^ {2}stress: ran=(yes|NO) result=(PASS|FAIL) exit=(n\/a|-?\d+)( \(process bound exceeded\))? wall_s=(\S+)$/;
const COUNTS_LINE =
  /^ {4}suites passed\/failed\/skipped\/total=(n\/a|\d+\/\d+\/\d+\/\d+) tests passed\/failed\/skipped\/total=(n\/a|\d+\/\d+\/\d+\/\d+)$/;

/** A refusal to parse: a fixed, bounded reason and nothing from the text. */
class ReportShapeError extends Error {}
const shape = (reason) => {
  throw new ReportShapeError(reason);
};

/** `name=count` tokens with exactly `names`, in order, as a map of integers. */
function parseCounts(body, names, what) {
  const tokens = body.split(' ');
  if (tokens.length !== names.length) shape(`${what} does not list every category`);
  const counts = {};
  tokens.forEach((token, index) => {
    const [name, value, extra] = token.split('=');
    if (name !== names[index] || extra !== undefined || !COUNT.test(value ?? '')) {
      shape(`${what} is malformed`);
    }
    counts[name] = Number(value);
  });
  return counts;
}

/** The one top-level line starting with `prefix`; anything else is a shape error. */
function single(lines, prefix, what) {
  const found = lines.filter((line) => line.startsWith(prefix));
  if (found.length !== 1) shape(`${what} appears ${found.length} time(s)`);
  return found[0].slice(prefix.length);
}

/** `passed/failed/skipped/total` as numbers, or `null` for `n/a`. */
const splitCounts = (text) => {
  if (text === 'n/a') return null;
  const [passed, failed, skipped, total] = text.split('/').map(Number);
  return { passed, failed, skipped, total };
};

/**
 * Reads the slot field alone, before anything else is trusted.
 *
 * Returns `{ slot }` or `{ rejected }` with a fixed reason. A report whose slot
 * cannot be read cannot be assigned to any index, so it is rejected as an input
 * rather than guessed into one.
 */
export function readCampaignSlot(text) {
  const lines = String(text).split('\n');
  const fields = lines.filter((line) => line.startsWith(CAMPAIGN_SLOT_FIELD));
  if (fields.length === 0) return { rejected: 'no campaign_slot field' };
  if (fields.length > 1) return { rejected: 'campaign_slot field repeated' };
  if (lines[2] !== fields[0]) return { rejected: 'campaign_slot field misplaced' };
  const value = fields[0].slice(CAMPAIGN_SLOT_FIELD.length);
  if (!/^[1-9]\d*$/.test(value)) return { rejected: 'campaign_slot field malformed' };
  const slot = Number(value);
  if (slot < MIN_CAMPAIGN_SLOT || slot > MAX_CAMPAIGN_SLOT) {
    return { rejected: 'campaign_slot field out of range' };
  }
  return { slot };
}

/**
 * The content of one one-pair calibration report, or a fixed reason it is not
 * one. Strict on purpose: every line must be exactly a line the renderer
 * produces, the report must end with its footer and a newline, and the summary
 * lines must agree with the pair row — a truncated or edited report fails here.
 */
export function parseSlotReport(text) {
  try {
    return { ok: true, report: parseStrict(String(text)) };
  } catch (error) {
    if (error instanceof ReportShapeError) return { ok: false, reason: error.message };
    throw error;
  }
}

function parseStrict(text) {
  if (!text.endsWith('\n')) shape('report does not end with a newline (truncated)');
  const lines = text.slice(0, -1).split('\n');
  if (lines.some((line) => line.includes('\r'))) shape('report has carriage returns');
  if (lines[0] !== CALIBRATION_REPORT_HEADER) shape('report header is not a calibration header');
  if (lines[lines.length - 1] !== CALIBRATION_REPORT_FOOTER) {
    shape('report footer is missing (truncated)');
  }

  const provenance = /^commit=(\S+)(?: run=\S+)? generated=\S+$/.exec(lines[1] ?? '');
  if (!provenance) shape('commit line is malformed');
  if (!COMMIT.test(provenance[1])) shape('commit is not a full commit hash');
  const { slot, rejected } = readCampaignSlot(text);
  if (rejected) shape(rejected);
  if (!(lines[3] ?? '').startsWith('topology: ')) shape('topology line is missing');
  if (lines.filter((line) => line.startsWith('topology: ')).length !== 1) {
    shape('topology line is repeated');
  }
  const topology = lines[3];
  const topologyMeasured =
    topology !== 'topology: measured=no' && !/^topology: error=/.test(topology);

  const pairsMatch = PAIRS_LINE.exec(lines[4] ?? '');
  if (!pairsMatch) shape('pairs line is malformed');
  if (pairsMatch[1] !== '1') shape('report is not a one-pair report');

  const preflightLines = lines.filter((line) => line.startsWith('campaign preflight: '));
  if (preflightLines.length !== 1) shape('campaign preflight line is missing or repeated');
  if (![PREFLIGHT_PASSED, PREFLIGHT_REFUSED].includes(preflightLines[0])) {
    shape('campaign preflight line is malformed');
  }
  const refused = preflightLines[0] === PREFLIGHT_REFUSED;
  if (refused !== (pairsMatch[2] !== undefined)) shape('pairs line disagrees with the preflight');

  const controlLines = lines.filter((line) => line.startsWith('control'));
  const controlHeader = controlLines.filter((line) => !line.startsWith('control infrastructure'));
  if (controlHeader.length !== 1) shape('control line is missing or repeated');
  const controlMatch = CONTROL_RAN.exec(controlHeader[0]) ?? CONTROL_NOT_RUN.exec(controlHeader[0]);
  if (!controlMatch || !CALIBRATION_OUTCOMES.includes(controlMatch[1])) {
    shape('control line is malformed');
  }

  const row = parsePairRow(lines);

  const outcomes = parseCounts(
    single(lines, 'outcomes: ', 'outcomes line'),
    CALIBRATION_OUTCOMES,
    'outcomes line',
  );
  for (const name of CALIBRATION_OUTCOMES) {
    if (outcomes[name] !== (row.outcome === name ? 1 : 0)) {
      shape('outcomes line disagrees with the pair row');
    }
  }
  const stressSummary = /^passed=(\d+) failed=(\d+) of 1$/.exec(
    single(lines, 'stress: ', 'stress summary line'),
  );
  if (!stressSummary) shape('stress summary line is malformed');
  const expectedPassed = row.stress?.result === 'PASS' ? 1 : 0;
  const expectedFailed = row.stress && row.stress.result !== 'PASS' ? 1 : 0;
  if (Number(stressSummary[1]) !== expectedPassed || Number(stressSummary[2]) !== expectedFailed) {
    shape('stress summary line disagrees with the pair row');
  }
  for (const name of DISTRIBUTIONS) {
    const body = single(lines, `  ${name}: `, `${name} distribution`);
    if (!/^n=1 available=\d+ unavailable=\d+ min=\S+ median=\S+ max=\S+$/.test(body)) {
      shape(`${name} distribution is malformed`);
    }
  }
  const infraTotals = parseCounts(
    single(lines, 'infrastructure totals across pairs: ', 'pair infrastructure totals'),
    INFRASTRUCTURE_CATEGORY_NAMES,
    'pair infrastructure totals',
  );
  const controlTotals = parseCounts(
    single(lines, 'control infrastructure totals: ', 'control infrastructure totals'),
    INFRASTRUCTURE_CATEGORY_NAMES,
    'control infrastructure totals',
  );
  const preflightTotals = parseCounts(
    single(
      lines,
      'preflight infrastructure totals (campaign scope, denominator=1 campaign): ',
      'preflight infrastructure totals',
    ),
    INFRASTRUCTURE_CATEGORY_NAMES,
    'preflight infrastructure totals',
  );
  for (const name of INFRASTRUCTURE_CATEGORY_NAMES) {
    if (infraTotals[name] !== (row.infrastructure[name] ?? 0)) {
      shape('pair infrastructure totals disagree with the pair row');
    }
  }

  return {
    slot,
    commit: provenance[1],
    topology,
    topologyMeasured,
    refused,
    controlOutcome: controlMatch[1],
    controlTotals,
    preflightTotals,
    row,
  };
}

/**
 * The single pair row, line by line. Only the shapes the renderer writes are
 * accepted, in its order; any other line inside the block is a shape error.
 */
function parsePairRow(lines) {
  const starts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^pair-\d+: /.test(line));
  if (starts.length !== 1) shape(`report has ${starts.length} pair rows, not one`);
  const head = /^pair-1: outcome=(\w+)$/.exec(starts[0].line);
  if (!head || !CALIBRATION_OUTCOMES.includes(head[1])) shape('pair row header is malformed');

  const end = lines.indexOf('', starts[0].index);
  if (end === -1) shape('pair row is not terminated (truncated)');
  const block = lines.slice(starts[0].index + 1, end);
  let at = 0;
  const next = () => block[at++];
  const skipProblems = (indent) => {
    while (at < block.length && block[at].startsWith(`${indent}problem: `)) at += 1;
  };

  let probe = next();
  if (probe === '  probe: not run') {
    probe = null;
  } else if ((probe ?? '').startsWith('  probe: transactions=')) {
    if (!(next() ?? '').startsWith('    wal_sync_delta=')) shape('probe row is malformed');
    if (!(next() ?? '').startsWith('    min_interval_tps=')) shape('probe row is malformed');
    skipProblems('    ');
    probe = true;
  } else {
    shape('probe row is malformed');
  }

  let stress = null;
  const stressLine = next();
  if (stressLine !== '  stress: not run') {
    const m = STRESS_LINE.exec(stressLine ?? '');
    if (!m) shape('stress row is malformed');
    const counts = COUNTS_LINE.exec(next() ?? '');
    if (!counts) shape('stress counts are malformed');
    const failuresLine = next() ?? '';
    if (!failuresLine.startsWith('    failures: ')) shape('stress failures line is missing');
    const failuresBody = failuresLine.slice('    failures: '.length);
    stress = {
      ran: m[1] === 'yes',
      result: m[2],
      exitCode: m[3] === 'n/a' ? null : Number(m[3]),
      boundExceeded: m[4] !== undefined,
      suites: splitCounts(counts[1]),
      tests: splitCounts(counts[2]),
      failures:
        failuresBody === 'n/a'
          ? null
          : parseCounts(failuresBody, FAILURE_CATEGORY_NAMES, 'stress failures line'),
    };
    skipProblems('    ');
  }

  const infrastructure = {};
  if (at < block.length && block[at].startsWith('  infrastructure: ')) {
    for (const token of block[at].slice('  infrastructure: '.length).split(' ')) {
      const [name, value, extra] = token.split('=');
      if (
        !INFRASTRUCTURE_CATEGORY_NAMES.includes(name) ||
        extra !== undefined ||
        !/^[1-9]\d*$/.test(value ?? '') ||
        name in infrastructure
      ) {
        shape('pair infrastructure line is malformed');
      }
      infrastructure[name] = Number(value);
    }
    at += 1;
  }
  if (at !== block.length) shape('pair row has an unexpected line');
  return { outcome: head[1], probeRan: probe !== null, stress, infrastructure };
}

const sum = (counts, names) => names.reduce((total, name) => total + counts[name], 0);
const anyNonZero = (counts) => Object.values(counts).some((count) => count !== 0);

/**
 * One parsed report's state under § 5.2 / § 8.4, with a fixed bounded reason.
 * Every branch that is not positively a non-event or an event is a blocker.
 */
export function classifySlotReport(report) {
  const blocker = (reason) => ({ state: SLOT_STATE.blocker, reason });
  if (report.refused) return blocker('campaign preflight refused before measurement');
  if (anyNonZero(report.preflightTotals)) return blocker('preflight infrastructure is non-zero');
  if (!report.topologyMeasured) return blocker('topology was not captured');
  if (report.controlOutcome !== 'VALID') return blocker(`control ${report.controlOutcome}`);
  if (anyNonZero(report.controlTotals)) return blocker('control infrastructure is non-zero');
  const { row } = report;
  if (row.outcome !== 'VALID') return blocker(`pair ${row.outcome}`);
  if (!row.probeRan) return blocker('probe did not run');
  const { stress } = row;
  if (!stress || !stress.ran) return blocker('stress suite did not run');
  if (stress.boundExceeded) return blocker('stress process bound exceeded');
  // A named infrastructure category is a setup, launcher, process or stats
  // failure around the suite. Only `other` — the suite's own failure lines —
  // may accompany an eligible pair.
  const named = Object.keys(row.infrastructure).filter((name) => name !== 'other');
  if (named.length > 0) return blocker(`infrastructure ${named.sort().join(',')}`);
  if (!stress.failures || !stress.tests || !stress.suites) {
    return blocker('stress counts are not available');
  }
  if (stress.tests.total === 0) return blocker('stress suite collected no test');

  const environment = sum(stress.failures, FAILURE_CATEGORY_PARTITION.environment);
  const product = sum(stress.failures, FAILURE_CATEGORY_PARTITION.productAssertion);
  const unclassified = sum(stress.failures, FAILURE_CATEGORY_PARTITION.unclassified);

  if (stress.result === 'PASS') {
    if (
      stress.exitCode !== 0 ||
      environment + product + unclassified !== 0 ||
      stress.tests.failed !== 0 ||
      stress.suites.failed !== 0 ||
      (row.infrastructure.other ?? 0) !== 0
    ) {
      return blocker('passing suite with inconsistent counts');
    }
    return { state: SLOT_STATE.nonEvent, reason: 'VALID pair; unchanged suite passed' };
  }

  if (stress.exitCode === null || stress.exitCode === 0) {
    return blocker('failing suite without a non-zero exit');
  }
  if (unclassified > 0) return blocker('unclassified failure category');
  if (product > 0 && environment > 0) return blocker('mixed product and environment failure');
  if (product > 0) return blocker('product-assertion failure');
  if (environment === 0) return blocker('failure without a classified category');
  if (stress.tests.failed === 0) return blocker('suite failed without a failed test');
  return {
    state: SLOT_STATE.event,
    reason: `VALID pair; environment-only failure (${FAILURE_CATEGORY_PARTITION.environment
      .map((name) => `${name}=${stress.failures[name]}`)
      .join(' ')})`,
  };
}

const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Accounts for the fixed campaign from a list of inputs, each `{ text }` or
 * `{ unreadable: true }`. Deterministic in the multiset of inputs: order and
 * names play no part, because none is ever seen.
 */
export function accountCampaign(inputs) {
  const list = Array.isArray(inputs) ? inputs : [];
  const rejected = {};
  const claims = new Map();
  const reject = (reason) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  };

  for (const input of list) {
    if (!input || input.unreadable || typeof input.text !== 'string') {
      reject('unreadable input');
      continue;
    }
    const { slot, rejected: why } = readCampaignSlot(input.text);
    if (why) {
      reject(why);
      continue;
    }
    const parsed = parseSlotReport(input.text);
    if (!claims.has(slot)) claims.set(slot, []);
    claims.get(slot).push(parsed);
  }

  const slots = [];
  const candidates = [];
  for (let slot = MIN_CAMPAIGN_SLOT; slot <= MAX_CAMPAIGN_SLOT; slot += 1) {
    const claimed = claims.get(slot) ?? [];
    const entry = { slot, state: SLOT_STATE.missing, reason: '' };
    if (claimed.length === 0) entry.reason = 'no report claims this slot';
    else if (claimed.length > 1) entry.reason = `claimed by ${claimed.length} reports`;
    else if (!claimed[0].ok) entry.reason = `unparseable report: ${claimed[0].reason}`;
    else candidates.push({ entry, report: claimed[0].report });
    slots.push(entry);
  }

  // Provenance is compared across every parseable, uniquely claimed report. No
  // majority is taken: with more than one value nothing says which is right, so
  // every report that took part becomes missing.
  const commits = [...new Set(candidates.map(({ report }) => report.commit))].sort();
  const measured = candidates.filter(({ report }) => report.topologyMeasured);
  const topologies = [...new Set(measured.map(({ report }) => report.topology))].sort();
  const problems = [];
  if (commits.length > 1) problems.push(`commit differs across reports (${commits.length} values)`);
  if (topologies.length > 1) {
    problems.push(`topology differs across reports (${topologies.length} values)`);
  }

  for (const { entry, report } of candidates) {
    if (commits.length > 1) {
      entry.reason = 'commit provenance differs across reports';
    } else if (topologies.length > 1 && report.topologyMeasured) {
      entry.reason = 'topology provenance differs across reports';
    } else {
      const { state, reason } = classifySlotReport(report);
      entry.state = state;
      entry.reason = reason;
    }
  }

  if (list.length !== CAMPAIGN_SLOT_COUNT) {
    problems.push(`expected ${CAMPAIGN_SLOT_COUNT} report inputs, got ${list.length}`);
  }
  const rejectedCount = Object.values(rejected).reduce((total, count) => total + count, 0);
  if (rejectedCount > 0) problems.push(`${rejectedCount} input(s) could not be assigned to a slot`);

  const count = (state) => slots.filter((entry) => entry.state === state).length;
  const totals = {
    nonEvents: count(SLOT_STATE.nonEvent),
    events: count(SLOT_STATE.event),
    blockers: count(SLOT_STATE.blocker),
    missing: count(SLOT_STATE.missing),
  };
  const accounted = totals.nonEvents + totals.events + totals.blockers + totals.missing;
  const invariantHolds = accounted === CAMPAIGN_SLOT_COUNT && slots.length === CAMPAIGN_SLOT_COUNT;
  if (!invariantHolds) problems.push('slot totals do not sum to the preregistered count');

  const complete = problems.length === 0 && totals.blockers === 0 && totals.missing === 0;
  return {
    inputs: list.length,
    rejected: Object.fromEntries(Object.entries(rejected).sort(([a], [b]) => a.localeCompare(b))),
    provenance: {
      commits,
      topologyDigests: topologies.map(digest),
    },
    slots,
    totals,
    accounted,
    invariantHolds,
    problems,
    complete,
    exitCode: complete ? 0 : 1,
  };
}

/** The accounting as text: every slot, then the totals and the invariant. */
export function formatAccounting(result) {
  const { totals } = result;
  const rejected = Object.entries(result.rejected);
  const lines = [
    'ADR-055 fresh-run campaign slot accounting - from report content only; job conclusions are never read',
    `expected_slots=${CAMPAIGN_SLOT_COUNT} inputs=${result.inputs} rejected_inputs=${rejected.reduce(
      (total, [, count]) => total + count,
      0,
    )}`,
    `provenance: commits=${result.provenance.commits.length}${
      result.provenance.commits.length === 1 ? ` (${result.provenance.commits[0]})` : ''
    } measured_topologies=${result.provenance.topologyDigests.length}${
      result.provenance.topologyDigests.length === 1
        ? ` (sha256:${result.provenance.topologyDigests[0]})`
        : ''
    }`,
    '',
    ...result.slots.map((entry) => `slot ${entry.slot}: ${entry.state} - ${entry.reason}`),
    '',
    `rejected inputs: ${
      rejected.length === 0 ? 'none' : rejected.map(([reason, n]) => `${reason}=${n}`).join('; ')
    }`,
    `campaign problems: ${result.problems.length === 0 ? 'none' : result.problems.join('; ')}`,
    `totals: non-events=${totals.nonEvents} events=${totals.events} blockers=${totals.blockers} missing=${totals.missing}`,
    `invariant: non-events + events + blockers + missing = ${totals.nonEvents} + ${totals.events} + ${
      totals.blockers
    } + ${totals.missing} = ${result.accounted} (expected ${CAMPAIGN_SLOT_COUNT}) ${
      result.invariantHolds ? 'holds' : 'VIOLATED'
    }`,
    result.complete
      ? 'accounting: COMPLETE - every slot resolved from content, zero blockers, zero missing'
      : 'accounting: INCOMPLETE - at least one slot is a blocker or missing, or an input or provenance problem exists',
    'interpretation of these totals is a separate human step under the preregistration § 6; no threshold, margin, p-value, replacement, retry or stopping rule is applied here.',
  ];
  return `${lines.join('\n')}\n`;
}
