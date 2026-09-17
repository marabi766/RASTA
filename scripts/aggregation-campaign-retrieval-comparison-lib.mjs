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
 * Report paths can also arrive through two **cohort manifests** — plain path
 * lists that avoid command-line length limits. `parseRetrievalManifest`
 * accepts exactly 59 LF-terminated lines of strict UTF-8 and resolves each
 * against the manifest's own directory. A manifest is operator-supplied
 * transport only: it proves nothing about authenticity or provenance, and its
 * line order means nothing because slots still come from report content.
 *
 * Pure: bytes and strings in, values out; path handling is string arithmetic
 * with `node:path` and never touches a file system. Diagnostics are fixed
 * sentences and counts; no path, manifest line, report content, slot identity
 * of a difference, commit, topology, timestamp or run value is ever part of
 * the output.
 */
import {
  CAMPAIGN_SLOT_COUNT,
  accountCampaign,
  parseSlotReport,
} from './aggregation-campaign-accounting-lib.mjs';
import { posix, win32 } from 'node:path';

import { LOG_RECOVERY_LIMITS } from './aggregation-campaign-log-recovery-lib.mjs';
import { MAX_CAMPAIGN_SLOT, MIN_CAMPAIGN_SLOT } from './aggregation-evidence-lib.mjs';

/** Bounds shared with the existing campaign tools, plus one path bound. */
export const RETRIEVAL_COMPARISON_LIMITS = Object.freeze({
  /** Paths per cohort above this are a usage error, refused before any read. */
  maxPathsPerCohort: LOG_RECOVERY_LIMITS.maxLogs,
  /** Bytes of one report file; larger files are refused unread (a report is about 3.4 KiB). */
  maxReportBytes: LOG_RECOVERY_LIMITS.maxCandidateBytes,
  /** UTF-8 bytes of one report or manifest path as given: one argument or one manifest line. */
  maxPathBytes: 1024,
});

/** A manifest lists exactly the campaign's reports, each line at most one bounded path plus LF. */
export const MAX_RETRIEVAL_MANIFEST_BYTES =
  CAMPAIGN_SLOT_COUNT * (RETRIEVAL_COMPARISON_LIMITS.maxPathBytes + 1);

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

// ---------------------------------------------------------------------------
// Cohort manifests — how report paths reach the command, never evidence

/** Fixed manifest-contract problems, in the order they are checked. */
export const MANIFEST_PROBLEM = Object.freeze({
  unreadable: 'manifest could not be read',
  tooLarge: 'manifest exceeds the byte limit',
  bom: 'manifest starts with a byte order mark',
  notUtf8: 'manifest is not valid UTF-8',
  carriageReturn: 'manifest contains a carriage return (only LF line endings are accepted)',
  control: 'manifest contains NUL or another control character',
  finalNewline: 'manifest does not end with a line feed',
  blankLine: 'manifest contains a blank line',
  whitespace: 'manifest entry has leading or trailing whitespace',
  optionLike: 'manifest entry starts with -',
  notPlainPath: 'manifest entry looks like a comment, quoted value, URL or drive-relative path',
  entryTooLong: 'manifest entry exceeds the path byte limit',
  lineCount: `manifest does not list exactly ${CAMPAIGN_SLOT_COUNT} report paths`,
});

const MANIFEST_CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F]/;
// `#` comments, quoting, `scheme:` URLs (two or more letters) and Windows
// drive-relative `C:name`, whose base would be a per-drive working directory.
const NOT_PLAIN_PATH = /^[#"']|["']$|^[A-Za-z][A-Za-z0-9+.-]+:|^[A-Za-z]:(?![\\/])/;

/** The path functions of one platform; `resolve` is only ever called with an absolute base. */
export const pathApiFor = (platform) => (platform === 'win32' ? win32 : posix);

/**
 * Parses one cohort manifest: strict UTF-8 without BOM, exactly 59 non-empty
 * LF-terminated lines, one report path per line, nothing else. A relative
 * entry resolves against `manifestDir` (the absolute directory holding the
 * manifest), never against the caller's working directory. Returns
 * `{ ok: true, paths }` in line order — order means nothing downstream — or
 * `{ ok: false, problem }` with a fixed `MANIFEST_PROBLEM` sentence.
 */
export function parseRetrievalManifest(
  bytes,
  { manifestDir, platform = 'posix', limits = RETRIEVAL_COMPARISON_LIMITS } = {},
) {
  const fail = (problem) => ({ ok: false, problem });
  const maxBytes = CAMPAIGN_SLOT_COUNT * (limits.maxPathBytes + 1);
  if (!Buffer.isBuffer(bytes)) return fail(MANIFEST_PROBLEM.unreadable);
  if (bytes.length > maxBytes) return fail(MANIFEST_PROBLEM.tooLarge);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return fail(MANIFEST_PROBLEM.bom);
  }
  let text;
  try {
    text = strictUtf8().decode(bytes);
  } catch {
    return fail(MANIFEST_PROBLEM.notUtf8);
  }
  if (text.includes('\r')) return fail(MANIFEST_PROBLEM.carriageReturn);
  if (MANIFEST_CONTROL.test(text)) return fail(MANIFEST_PROBLEM.control);
  if (!text.endsWith('\n')) return fail(MANIFEST_PROBLEM.finalNewline);

  const lines = text.slice(0, -1).split('\n');
  for (const line of lines) {
    if (line === '') return fail(MANIFEST_PROBLEM.blankLine);
    if (line !== line.trim()) return fail(MANIFEST_PROBLEM.whitespace);
    if (line.startsWith('-')) return fail(MANIFEST_PROBLEM.optionLike);
    if (NOT_PLAIN_PATH.test(line)) return fail(MANIFEST_PROBLEM.notPlainPath);
    if (Buffer.byteLength(line, 'utf8') > limits.maxPathBytes) {
      return fail(MANIFEST_PROBLEM.entryTooLong);
    }
  }
  if (lines.length !== CAMPAIGN_SLOT_COUNT) return fail(MANIFEST_PROBLEM.lineCount);

  const api = pathApiFor(platform);
  if (typeof manifestDir !== 'string' || !api.isAbsolute(manifestDir)) {
    return fail(MANIFEST_PROBLEM.unreadable);
  }
  return { ok: true, paths: lines.map((line) => api.resolve(manifestDir, line)) };
}

/**
 * The key two absolute paths are compared by when looking for a duplicate
 * within a cohort or a path shared across cohorts. String-only and
 * conservative: on Windows, separators are normalized, trailing dots and
 * spaces of each segment are dropped (Windows ignores them) and case is
 * folded, so more spellings collide, never fewer. No file system identity is
 * consulted: hard links, junctions, symlinks and 8.3 short names are not seen.
 */
export function retrievalPathKey(absolutePath, { platform = 'posix' } = {}) {
  if (platform === 'win32') {
    const normalized = win32.normalize(String(absolutePath));
    const segments = normalized.split('\\');
    const key = segments
      .map((segment, index) => (index === 0 ? segment : segment.replace(/[. ]+$/, '')))
      .join('\\')
      .toLowerCase();
    return key.length > 3 ? key.replace(/\\+$/, '') : key;
  }
  const key = posix.normalize(String(absolutePath));
  return key.length > 1 ? key.replace(/\/+$/, '') : key;
}

/**
 * `null` when every absolute path is distinct within its cohort and no path is
 * shared across cohorts (by `retrievalPathKey`); otherwise `'duplicate'` or
 * `'shared'`. Duplicates are checked first.
 */
export function findPathCollision({ artifacts, fallback }, { platform = 'posix' } = {}) {
  const keys = (paths) => paths.map((path) => retrievalPathKey(path, { platform }));
  const artifactKeys = keys(artifacts);
  const fallbackKeys = keys(fallback);
  for (const list of [artifactKeys, fallbackKeys]) {
    if (new Set(list).size !== list.length) return 'duplicate';
  }
  const artifactSet = new Set(artifactKeys);
  return fallbackKeys.some((key) => artifactSet.has(key)) ? 'shared' : null;
}

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
