/**
 * Byte comparison of two retrievals of the preregistered ADR-055 fresh-run
 * campaign — the pure half of `aggregation-campaign-retrieval-comparison.mjs`.
 *
 * The campaign's reports can reach an operator two ways: the 59 per-slot
 * artifacts the jobs uploaded (the primary retrieval), and the 59 files that
 * `recover:aggregation-campaign-logs -- --output-dir …` materializes from job
 * logs (the fallback). Whether recovered text equals the uploaded artifact
 * bytes is not provable offline (launch readiness § 10). When both complete
 * sets happen to exist, this library answers one narrower question: are the
 * two supplied byte sets identical, slot by slot?
 *
 * - **Each cohort is validated alone** by the unchanged `accountCampaign` (and
 *   so `parseSlotReport`): exactly 59 inputs, complete accounting (no rejected
 *   input, blocker, missing or unparseable slot), exactly one campaign commit
 *   and exactly one byte-identical measured topology. There is no second
 *   parser and no bound is relaxed.
 * - **Slots come from content.** Every accepted report is bound to the slot
 *   `parseSlotReport` read from it, and each binding must be one to one. Paths,
 *   file names, input order, job conclusions and majorities play no part —
 *   none is ever seen here.
 * - **Bytes are compared as bytes.** Decoding happens only so the parser can
 *   read the text (strict UTF-8, BOM kept, so a BOM fails the parser). The
 *   comparison is `Buffer.equals` on the exact bytes supplied for the same
 *   slot: nothing is trimmed, normalised, re-rendered, re-encoded or reduced
 *   to parsed fields or digests.
 *
 * Three outcomes, nothing in between: `MATCH` (exit 0) only when both cohorts
 * validate and all 59 slots are byte-identical; `DIFFERENT` (exit 1) when both
 * validate and at least one slot differs; `REJECTED` (exit 1) when either
 * cohort is incomplete or invalid. A partial or mixed cohort is never
 * compared, and `MATCH` says nothing about authenticity, retrievability,
 * freshness, attempt number or authorization of either source.
 *
 * Pure: bytes in, values out. Diagnostics are fixed sentences and counts; no
 * path, report content, slot identity of a difference, commit, topology,
 * timestamp or run value is ever part of the output.
 */
import {
  CAMPAIGN_SLOT_COUNT,
  accountCampaign,
  parseSlotReport,
} from './aggregation-campaign-accounting-lib.mjs';
import { LOG_RECOVERY_LIMITS } from './aggregation-campaign-log-recovery-lib.mjs';
import { MAX_CAMPAIGN_SLOT, MIN_CAMPAIGN_SLOT } from './aggregation-evidence-lib.mjs';

/** Bounds shared with the existing campaign tools; nothing new is invented. */
export const RETRIEVAL_COMPARISON_LIMITS = Object.freeze({
  /** Paths per cohort above this are a usage error, refused before any read. */
  maxPathsPerCohort: LOG_RECOVERY_LIMITS.maxLogs,
  /** Bytes of one report file; larger files are refused unread (a report is about 3.4 KiB). */
  maxReportBytes: LOG_RECOVERY_LIMITS.maxCandidateBytes,
});

/** The two cohorts, in output order. */
export const RETRIEVAL_COHORTS = Object.freeze({
  artifacts: 'artifacts',
  fallback: 'fallback',
});

/** Fixed cohort problems, in the order they are reported. */
export const COHORT_INPUT_PROBLEM = Object.freeze({
  count: `cohort does not supply exactly ${CAMPAIGN_SLOT_COUNT} report inputs`,
  oversized: 'a report exceeds the byte limit',
  unreadable: 'a report could not be read',
  notUtf8: 'a report is not valid UTF-8',
  accounting:
    'slot accounting is incomplete (rejected input, blocker, missing or unparseable slot, or provenance problem)',
  commit: 'reports do not carry exactly one campaign commit',
  topology: 'reports do not carry exactly one measured topology',
  binding: 'reports do not bind one to one to the campaign slots',
});

/** The three results. */
export const COMPARISON_DECISION = Object.freeze({
  match: 'MATCH',
  different: 'DIFFERENT',
  rejected: 'REJECTED',
});

const strictUtf8 = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Validates one cohort, given as a list of `{ bytes }`, `{ unreadable: true }`
 * or `{ oversized: true }`. Returns `{ accepted, problems, inputs, read,
 * accountingComplete, bySlot }`; `bySlot` maps each slot to its exact bytes
 * and is present only when the cohort is accepted.
 */
export function validateRetrievalCohort(inputs, { limits = RETRIEVAL_COMPARISON_LIMITS } = {}) {
  const list = Array.isArray(inputs) ? inputs : [];
  const problems = new Set();
  const done = (extra) => {
    const ordered = Object.values(COHORT_INPUT_PROBLEM).filter((problem) => problems.has(problem));
    return { accepted: ordered.length === 0, problems: ordered, inputs: list.length, ...extra };
  };

  // A cohort of the wrong size can never be complete; its entries are not examined.
  if (list.length !== CAMPAIGN_SLOT_COUNT) {
    problems.add(COHORT_INPUT_PROBLEM.count);
    return done({ read: 0, accountingComplete: false });
  }

  const decoded = list.map((input) => {
    if (input?.oversized === true) {
      problems.add(COHORT_INPUT_PROBLEM.oversized);
      return null;
    }
    if (!input || input.unreadable || !Buffer.isBuffer(input.bytes)) {
      problems.add(COHORT_INPUT_PROBLEM.unreadable);
      return null;
    }
    if (input.bytes.length > limits.maxReportBytes) {
      problems.add(COHORT_INPUT_PROBLEM.oversized);
      return null;
    }
    try {
      return { bytes: input.bytes, text: strictUtf8().decode(input.bytes) };
    } catch {
      problems.add(COHORT_INPUT_PROBLEM.notUtf8);
      return null;
    }
  });
  const read = decoded.filter(Boolean).length;

  const accounting = accountCampaign(
    decoded.map((entry) => (entry ? { text: entry.text } : { unreadable: true })),
  );
  if (!accounting.complete) problems.add(COHORT_INPUT_PROBLEM.accounting);
  if (accounting.provenance.commits.length !== 1) problems.add(COHORT_INPUT_PROBLEM.commit);
  if (accounting.provenance.topologyDigests.length !== 1) {
    problems.add(COHORT_INPUT_PROBLEM.topology);
  }

  // Bind every report to the slot the strict parser reads from it, one to one.
  const bySlot = new Map();
  for (const entry of decoded) {
    if (!entry) continue;
    const parsed = parseSlotReport(entry.text);
    if (!parsed.ok || bySlot.has(parsed.report.slot)) {
      problems.add(COHORT_INPUT_PROBLEM.binding);
      continue;
    }
    bySlot.set(parsed.report.slot, entry.bytes);
  }
  for (let slot = MIN_CAMPAIGN_SLOT; slot <= MAX_CAMPAIGN_SLOT; slot += 1) {
    if (!bySlot.has(slot)) problems.add(COHORT_INPUT_PROBLEM.binding);
  }

  const result = done({ read, accountingComplete: accounting.complete });
  return result.accepted ? { ...result, bySlot } : result;
}

/**
 * The whole comparison: both cohorts validated independently, then the exact
 * bytes of each slot compared. `{ artifacts, fallback }` are input lists as
 * `validateRetrievalCohort` takes them.
 */
export function compareRetrievals({ artifacts, fallback } = {}, options) {
  const cohorts = {
    artifacts: validateRetrievalCohort(artifacts, options),
    fallback: validateRetrievalCohort(fallback, options),
  };
  const summary = (cohort) => ({
    accepted: cohort.accepted,
    problems: cohort.problems,
    inputs: cohort.inputs,
    read: cohort.read,
    accountingComplete: cohort.accountingComplete,
  });

  if (!cohorts.artifacts.accepted || !cohorts.fallback.accepted) {
    return {
      artifacts: summary(cohorts.artifacts),
      fallback: summary(cohorts.fallback),
      comparison: null,
      decision: COMPARISON_DECISION.rejected,
      exitCode: 1,
    };
  }

  let identical = 0;
  let different = 0;
  for (let slot = MIN_CAMPAIGN_SLOT; slot <= MAX_CAMPAIGN_SLOT; slot += 1) {
    if (cohorts.artifacts.bySlot.get(slot).equals(cohorts.fallback.bySlot.get(slot)))
      identical += 1;
    else different += 1;
  }
  const match = different === 0 && identical === CAMPAIGN_SLOT_COUNT;
  return {
    artifacts: summary(cohorts.artifacts),
    fallback: summary(cohorts.fallback),
    comparison: { compared: identical + different, identical, different },
    decision: match ? COMPARISON_DECISION.match : COMPARISON_DECISION.different,
    exitCode: match ? 0 : 1,
  };
}

/** The comparison as text: fixed lines, counts and fixed problem sentences only. */
export function formatRetrievalComparison(result) {
  const cohortLines = (name, cohort) => [
    `${name} cohort: ${cohort.accepted ? 'ACCEPTED' : 'REJECTED'} inputs=${cohort.inputs} read=${
      cohort.read
    } accounting=${cohort.accountingComplete ? 'COMPLETE' : 'INCOMPLETE'}`,
    `  ${name} problems: ${cohort.problems.length === 0 ? 'none' : cohort.problems.join('; ')}`,
  ];
  const { comparison } = result;
  const lines = [
    'ADR-055 campaign retrieval comparison - exact report bytes per parsed slot; paths, file names, input order and job conclusions are never read',
    ...cohortLines(RETRIEVAL_COHORTS.artifacts, result.artifacts),
    ...cohortLines(RETRIEVAL_COHORTS.fallback, result.fallback),
    comparison === null
      ? 'comparison: not performed - both cohorts must be complete and valid; sources are never mixed'
      : `comparison: slots_compared=${comparison.compared} identical=${comparison.identical} different=${comparison.different}`,
    `COMPARISON: ${result.decision}`,
    'scope: equality of the supplied bytes only; it does not show that either source is authentic, retrievable, fresh, from attempt 1 or from an authorized run, and it verifies no launch-readiness row.',
  ];
  return `${lines.join('\n')}\n`;
}
