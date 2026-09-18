/**
 * Runner-image cohort review for the preregistered ADR-055 fresh-run campaign —
 * the pure half of `aggregation-campaign-image-cohort.mjs`.
 *
 * Launch-readiness row 9 asks whether the 59 slots ran on one comparable
 * runner/image cohort. The preregistration (§ 9.2) fixes the post-run test: if
 * the 59 reports do not all carry the same `topology:` line, the slots are not
 * comparable and § 6 Branch C applies. That test alone cannot say anything
 * about launch timing, so this review keeps two things apart:
 *
 * 1. **The pre-launch snapshot** — a small JSON manifest a human writes before
 *    launch: when the runner-image release state was observed, the current and
 *    previous `ubuntu24` releases with their publication times, the campaign
 *    commit, and an explicit acknowledgment that any topology mismatch forces
 *    Branch C. It is validated for shape and internal chronology only. Nothing
 *    here knows what the release state really was, and no rollout window or
 *    maximum age is invented. The `runs-on` label selects an image family, not
 *    an image version, so no snapshot can say which image a future job gets.
 * 2. **The post-run cohort** — the 59 reports, fed through the unchanged
 *    `accountCampaign` (and so `parseSlotReport`). Its byte-identical topology
 *    comparison and its commit comparison are reused, not re-implemented; this
 *    file never parses a topology line.
 *
 * Only a valid, acknowledged snapshot **and** a complete accounting with one
 * campaign commit equal to the manifest's and exactly one measured topology
 * yields `COHORT: CONSISTENT`. Everything else is `COHORT: BRANCH C`. That is
 * a comparability decision only: no threshold, p-value or event count is
 * interpreted, and event and non-event totals are not even printed.
 *
 * Diagnostics are fixed strings. No path, timestamp, commit, image value,
 * unknown field name or other supplied text ever reaches the output.
 */
import { accountCampaign } from './aggregation-campaign-accounting-lib.mjs';
import { CAMPAIGN_RUNNER } from './aggregation-campaign-workflow-lib.mjs';

/** The only manifest schema this review accepts. */
export const COHORT_MANIFEST_SCHEMA = 'adr-055-image-cohort-review/v1';

/** A manifest is a handful of short fields; anything larger is refused unread. */
export const MAX_MANIFEST_BYTES = 4 * 1024;

/** The manifest fields, all required, none optional. */
export const COHORT_MANIFEST_FIELDS = Object.freeze([
  'schema',
  'observed_at',
  'runner_label',
  'current_image_release',
  'current_image_published_at',
  'previous_image_release',
  'previous_image_published_at',
  'branch_c_on_topology_mismatch_acknowledged',
  'campaign_commit',
]);

/** Fixed manifest problems, in the order they are reported. */
export const MANIFEST_PROBLEM = Object.freeze({
  unreadable: 'manifest could not be read',
  tooLarge: 'manifest exceeds the byte limit',
  syntax: 'manifest is not one flat JSON object of strings and booleans',
  duplicate: 'manifest repeats a field',
  unknown: 'manifest has an unknown field',
  missing: 'manifest is missing a required field',
  type: 'manifest field has the wrong value type',
  schema: 'schema is not the supported identifier',
  observedAt: 'observed_at is not a whole-second UTC timestamp',
  observedFuture: 'observed_at is after the review time',
  runnerLabel: `runner_label is not ${CAMPAIGN_RUNNER}`,
  currentRelease: 'current_image_release is malformed',
  currentPublished: 'current_image_published_at is not a whole-second UTC timestamp',
  previousRelease: 'previous_image_release is malformed',
  previousPublished: 'previous_image_published_at is not a whole-second UTC timestamp',
  sameRelease: 'current and previous image releases are the same',
  releaseOrder: 'previous image release is not published before the current one',
  publishedAfterObservation: 'current image release is published after observed_at',
  acknowledgment: 'Branch C on topology mismatch is not acknowledged as true',
  commit: 'campaign_commit is not a full lowercase commit hash',
});

/** Fixed cohort problems, in the order they are reported. */
export const COHORT_PROBLEM = Object.freeze({
  accounting: 'slot accounting is incomplete (blocker, missing slot, rejected input or problem)',
  commitCount: 'reports do not carry exactly one campaign commit',
  commitMismatch: 'report commit differs from the manifest campaign_commit',
  topologyCount: 'reports do not carry exactly one measured topology',
});

/** The two results. Nothing in between. */
export const COHORT_DECISION = Object.freeze({
  consistent: 'CONSISTENT',
  branchC: 'BRANCH C',
});

const UTC_SECOND = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const COMMIT = /^[0-9a-f]{40}$/;
// The release-tag shape of the `ubuntu-24.04` image family (launch readiness § 2.4).
const IMAGE_RELEASE = /^ubuntu24\/\d{8}\.\d{1,6}$/;
const STRING_FIELDS = COHORT_MANIFEST_FIELDS.filter(
  (name) => name !== 'branch_c_on_topology_mismatch_acknowledged',
);

class ManifestSyntaxError extends Error {}
const syntax = () => {
  throw new ManifestSyntaxError('syntax');
};

/**
 * A flat JSON object of string and boolean values, read token by token so a
 * repeated field is seen in the raw text — `JSON.parse` would silently keep the
 * last one. Returns the name/value pairs in text order, or throws.
 */
function scanFlatObject(text) {
  let at = 0;
  const whitespace = () => {
    while (at < text.length && ' \t\r\n'.includes(text[at])) at += 1;
  };
  const expect = (char) => {
    whitespace();
    if (text[at] !== char) syntax();
    at += 1;
  };
  const string = () => {
    whitespace();
    if (text[at] !== '"') syntax();
    const start = at;
    at += 1;
    for (;;) {
      if (at >= text.length) syntax();
      const code = text.charCodeAt(at);
      if (code < 0x20) syntax();
      if (text[at] === '"') break;
      if (text[at] === '\\') {
        const escape = text[at + 1];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6))) syntax();
          at += 6;
        } else if (escape !== undefined && '"\\/bfnrt'.includes(escape)) {
          at += 2;
        } else {
          syntax();
        }
      } else {
        at += 1;
      }
    }
    at += 1;
    return JSON.parse(text.slice(start, at));
  };
  const value = () => {
    whitespace();
    if (text[at] === '"') return string();
    for (const [word, parsed] of [
      ['true', true],
      ['false', false],
    ]) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return parsed;
      }
    }
    return syntax();
  };

  const entries = [];
  expect('{');
  whitespace();
  if (text[at] === '}') {
    at += 1;
  } else {
    for (;;) {
      const name = string();
      expect(':');
      entries.push([name, value()]);
      whitespace();
      if (text[at] === ',') {
        at += 1;
        continue;
      }
      if (text[at] === '}') {
        at += 1;
        break;
      }
      syntax();
    }
  }
  whitespace();
  if (at !== text.length) syntax();
  return entries;
}

/**
 * The same flat-object reading for other ADR-055 records with the same
 * raw-JSON rules: `{ ok: true, entries }` in text order, or `{ ok: false }`.
 */
export function parseFlatJsonObject(text) {
  try {
    return { ok: true, entries: scanFlatObject(String(text)) };
  } catch (error) {
    if (!(error instanceof ManifestSyntaxError) && !(error instanceof SyntaxError)) throw error;
    return { ok: false };
  }
}

/** Milliseconds for a real whole-second UTC calendar instant, or `null`. */
function utcSecond(value) {
  const match = UTC_SECOND.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const back = new Date(ms);
  const same =
    back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day &&
    back.getUTCHours() === hour &&
    back.getUTCMinutes() === minute &&
    back.getUTCSeconds() === second;
  return same ? ms : null;
}

/**
 * Validates the pre-launch snapshot, given as `{ text }`, `{ unreadable: true }`
 * or `{ oversized: true }`. Returns `{ accepted, problems, commit }`:
 * `problems` are fixed strings in `MANIFEST_PROBLEM` order, and `commit` is the
 * validated campaign commit for comparison only — it is never printed.
 */
export function validateCohortManifest(input, { now } = {}) {
  const problems = new Set();
  const done = () => {
    const ordered = Object.values(MANIFEST_PROBLEM).filter((problem) => problems.has(problem));
    return { accepted: ordered.length === 0, problems: ordered, commit: null };
  };

  if (input?.oversized === true) {
    problems.add(MANIFEST_PROBLEM.tooLarge);
    return done();
  }
  if (!input || input.unreadable || typeof input.text !== 'string') {
    problems.add(MANIFEST_PROBLEM.unreadable);
    return done();
  }
  if (Buffer.byteLength(input.text, 'utf8') > MAX_MANIFEST_BYTES) {
    problems.add(MANIFEST_PROBLEM.tooLarge);
    return done();
  }

  let entries;
  try {
    entries = scanFlatObject(input.text);
  } catch (error) {
    if (!(error instanceof ManifestSyntaxError) && !(error instanceof SyntaxError)) throw error;
    problems.add(MANIFEST_PROBLEM.syntax);
    return done();
  }

  const fields = new Map();
  for (const [name, value] of entries) {
    if (fields.has(name)) problems.add(MANIFEST_PROBLEM.duplicate);
    else fields.set(name, value);
    if (!COHORT_MANIFEST_FIELDS.includes(name)) problems.add(MANIFEST_PROBLEM.unknown);
  }
  if (COHORT_MANIFEST_FIELDS.some((name) => !fields.has(name))) {
    problems.add(MANIFEST_PROBLEM.missing);
  }
  // A structural problem means no value can be trusted, not even the ones that look right.
  if (problems.size > 0) return done();
  if (
    STRING_FIELDS.some((name) => typeof fields.get(name) !== 'string') ||
    typeof fields.get('branch_c_on_topology_mismatch_acknowledged') !== 'boolean'
  ) {
    problems.add(MANIFEST_PROBLEM.type);
    return done();
  }

  const text = (name) => fields.get(name);
  if (text('schema') !== COHORT_MANIFEST_SCHEMA) problems.add(MANIFEST_PROBLEM.schema);
  if (text('runner_label') !== CAMPAIGN_RUNNER) problems.add(MANIFEST_PROBLEM.runnerLabel);

  const observed = utcSecond(text('observed_at'));
  const current = utcSecond(text('current_image_published_at'));
  const previous = utcSecond(text('previous_image_published_at'));
  if (observed === null) problems.add(MANIFEST_PROBLEM.observedAt);
  if (current === null) problems.add(MANIFEST_PROBLEM.currentPublished);
  if (previous === null) problems.add(MANIFEST_PROBLEM.previousPublished);
  const reviewTime = now instanceof Date ? now.getTime() : Number.NaN;
  // An unknown review time cannot place the observation before it: refuse.
  if (observed !== null && !(observed <= reviewTime)) {
    problems.add(MANIFEST_PROBLEM.observedFuture);
  }
  if (current !== null && previous !== null && !(previous < current)) {
    problems.add(MANIFEST_PROBLEM.releaseOrder);
  }
  if (current !== null && observed !== null && current > observed) {
    problems.add(MANIFEST_PROBLEM.publishedAfterObservation);
  }

  const currentRelease = text('current_image_release');
  const previousRelease = text('previous_image_release');
  if (!IMAGE_RELEASE.test(currentRelease)) problems.add(MANIFEST_PROBLEM.currentRelease);
  if (!IMAGE_RELEASE.test(previousRelease)) problems.add(MANIFEST_PROBLEM.previousRelease);
  if (currentRelease === previousRelease) {
    problems.add(MANIFEST_PROBLEM.sameRelease);
  }

  if (fields.get('branch_c_on_topology_mismatch_acknowledged') !== true) {
    problems.add(MANIFEST_PROBLEM.acknowledgment);
  }
  const commit = text('campaign_commit');
  if (!COMMIT.test(commit)) problems.add(MANIFEST_PROBLEM.commit);

  const result = done();
  return result.accepted ? { ...result, commit } : result;
}

/**
 * The whole review: the snapshot, then the unchanged accounting over the
 * reports, then the one decision. `reports` are `{ text }` or
 * `{ unreadable: true }`, exactly as `accountCampaign` takes them.
 *
 * `account` exists so a test can substitute a deliberately broken comparison
 * and prove the tests would notice; the CLI never passes it.
 */
export function reviewImageCohort(
  { manifest, reports, now } = {},
  { account = accountCampaign } = {},
) {
  const snapshot = validateCohortManifest(manifest, { now });
  const accounting = account(Array.isArray(reports) ? reports : []);
  const { commits, topologyDigests } = accounting.provenance;

  const problems = [];
  if (!accounting.complete) problems.push(COHORT_PROBLEM.accounting);
  if (commits.length !== 1) problems.push(COHORT_PROBLEM.commitCount);
  if (commits.length === 1 && snapshot.accepted && commits[0] !== snapshot.commit) {
    problems.push(COHORT_PROBLEM.commitMismatch);
  }
  if (topologyDigests.length !== 1) problems.push(COHORT_PROBLEM.topologyCount);

  const consistent = snapshot.accepted && problems.length === 0;
  return {
    snapshot: { accepted: snapshot.accepted, problems: snapshot.problems },
    cohort: {
      reports: accounting.inputs,
      accountingComplete: accounting.complete,
      resolvedSlots: accounting.totals.nonEvents + accounting.totals.events,
      blockers: accounting.totals.blockers,
      missing: accounting.totals.missing,
      rejectedInputs: Object.values(accounting.rejected).reduce((sum, n) => sum + n, 0),
      commits: commits.length,
      commitMatchesManifest:
        snapshot.accepted && commits.length === 1 && commits[0] === snapshot.commit,
      measuredTopologies: topologyDigests.length,
      topologyDigest: topologyDigests.length === 1 ? topologyDigests[0] : null,
      problems,
    },
    decision: consistent ? COHORT_DECISION.consistent : COHORT_DECISION.branchC,
    exitCode: consistent ? 0 : 1,
  };
}

/** The review as text. Every line is fixed apart from counts and one digest. */
export function formatCohortReview(result) {
  const { snapshot, cohort } = result;
  const list = (items) => (items.length === 0 ? 'none' : items.join('; '));
  const lines = [
    'ADR-055 runner-image cohort review - pre-launch snapshot plus post-run report comparison; job conclusions, file names and input order are never read',
    `pre-launch snapshot: ${snapshot.accepted ? 'ACCEPTED' : 'REJECTED'}`,
    `  snapshot problems: ${list(snapshot.problems)}`,
    `  limit: runs-on ${CAMPAIGN_RUNNER} selects an image family, not an image version; the snapshot records the release state seen before launch and cannot guarantee which image any job receives`,
    `post-run cohort: reports=${cohort.reports} accounting=${
      cohort.accountingComplete ? 'COMPLETE' : 'INCOMPLETE'
    } resolved_slots=${cohort.resolvedSlots} blockers=${cohort.blockers} missing=${
      cohort.missing
    } rejected_inputs=${cohort.rejectedInputs}`,
    `  commits=${cohort.commits} manifest_commit_match=${cohort.commitMatchesManifest ? 'yes' : 'no'}`,
    `  measured_topologies=${cohort.measuredTopologies}${
      cohort.topologyDigest ? ` (sha256:${cohort.topologyDigest})` : ''
    } - compared byte-for-byte by the unchanged slot accounting`,
    `  cohort problems: ${list(cohort.problems)}`,
    `COHORT: ${result.decision}`,
    'scope: a runner/image cohort and comparability decision only (preregistration § 6 and § 9.2); no threshold, p-value or event interpretation is applied, and launch-readiness row 9 is not verified by this output.',
  ];
  return `${lines.join('\n')}\n`;
}
