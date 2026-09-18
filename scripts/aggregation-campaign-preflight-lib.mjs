/**
 * Launch preflight bundle for the preregistered ADR-055 fresh-run campaign —
 * the pure half of `aggregation-campaign-preflight.mjs`.
 *
 * Each earlier ADR-055 tool checks one launch-time input on its own: the
 * workflow validator a YAML file, the image-cohort review a release-snapshot
 * manifest. Nothing tied the file that will be installed to the manifest that
 * was reviewed, to the commit being launched, or to the retry and retrieval
 * policy the launch accepts. This bundle does, from bytes:
 *
 * - a **launch record** (a flat JSON object with fixed fields, enums and
 *   booleans) names the campaign commit and the SHA-256 of the exact workflow
 *   snapshot and image-cohort manifest bytes, and states the first-attempt,
 *   no-rerun and retrieval policy with all its known limits acknowledged;
 * - the **workflow snapshot** must hash to the recorded digest and pass the
 *   unchanged `validateWorkflowDraft`;
 * - the **image-cohort manifest** must hash to the recorded digest and pass the
 *   unchanged `validateCohortManifest` at an explicit review time, and its
 *   `campaign_commit` must equal the record's.
 *
 * Hashes are taken over the supplied bytes, never over decoded, trimmed or
 * re-serialised text, so a single changed byte, line ending or trailing
 * newline breaks the link.
 *
 * **What this cannot prove.** That the snapshot is, or will be, installed;
 * that GitHub never retries internally; that any future run has
 * `run_attempt` 1; that uploaded artifacts are reachable or a run-log archive
 * is available; that recovered log text equals artifact bytes; or that 59 jobs
 * were ever recovered. It validates an offline bundle and nothing live.
 *
 * Diagnostics are fixed strings and counts. No path, digest, commit,
 * timestamp, manifest value or file content ever reaches the output.
 */
import { createHash } from 'node:crypto';

import {
  MANIFEST_PROBLEM,
  MAX_MANIFEST_BYTES,
  parseFlatJsonObject,
  validateCohortManifest,
} from './aggregation-campaign-image-cohort-lib.mjs';
import { MAX_DRAFT_BYTES, validateWorkflowDraft } from './aggregation-campaign-workflow-lib.mjs';

/** The only launch-record schema this check accepts. */
export const LAUNCH_RECORD_SCHEMA = 'adr-055-launch-preflight-record/v1';

/** A record is a handful of short fields; anything larger is refused unread. */
export const MAX_RECORD_BYTES = 4 * 1024;

/** Byte bounds for the three inputs, checked before any read. */
export const PREFLIGHT_INPUT_LIMITS = Object.freeze({
  record: MAX_RECORD_BYTES,
  workflow: MAX_DRAFT_BYTES,
  manifest: MAX_MANIFEST_BYTES,
});

/** The one primary retrieval mode: the workflow's per-slot `if: always()` uploads. */
export const PRIMARY_RETRIEVAL = 'per-slot-uploaded-artifacts';

/** Booleans the record must state as JSON `true`, in report order. */
export const LAUNCH_RECORD_ACKNOWLEDGMENTS = Object.freeze([
  'require_run_attempt_one',
  'rerun_retry_redispatch_ineligible_acknowledged',
  'run_log_archive_fallback_acknowledged',
  'fallback_not_artifact_byte_equality_acknowledged',
  'retrieval_availability_not_proven_acknowledged',
]);

/** The record fields, all required, none optional. */
export const LAUNCH_RECORD_FIELDS = Object.freeze([
  'schema',
  'campaign_commit',
  'workflow_snapshot_sha256',
  'image_cohort_manifest_sha256',
  'require_run_attempt_one',
  'rerun_retry_redispatch_ineligible_acknowledged',
  'primary_retrieval',
  'run_log_archive_fallback_acknowledged',
  'fallback_not_artifact_byte_equality_acknowledged',
  'retrieval_availability_not_proven_acknowledged',
]);

/** Fixed record problems, in the order they are reported. */
export const RECORD_PROBLEM = Object.freeze({
  unreadable: 'record could not be read',
  tooLarge: 'record exceeds the byte limit',
  encoding: 'record is not valid UTF-8',
  syntax: 'record is not one flat JSON object of strings and booleans',
  duplicate: 'record repeats a field',
  unknown: 'record has an unknown field',
  missing: 'record is missing a required field',
  type: 'record field has the wrong value type',
  schema: 'schema is not the supported identifier',
  commit: 'campaign_commit is not a full lowercase commit hash',
  workflowDigest: 'workflow_snapshot_sha256 is not a lowercase SHA-256 digest',
  manifestDigest: 'image_cohort_manifest_sha256 is not a lowercase SHA-256 digest',
  runAttempt: 'require_run_attempt_one is not true',
  rerun: 'rerun_retry_redispatch_ineligible_acknowledged is not true',
  primaryRetrieval: `primary_retrieval is not ${PRIMARY_RETRIEVAL}`,
  fallback: 'run_log_archive_fallback_acknowledged is not true',
  byteEquality: 'fallback_not_artifact_byte_equality_acknowledged is not true',
  availability: 'retrieval_availability_not_proven_acknowledged is not true',
});

const ACKNOWLEDGMENT_PROBLEM = Object.freeze({
  require_run_attempt_one: RECORD_PROBLEM.runAttempt,
  rerun_retry_redispatch_ineligible_acknowledged: RECORD_PROBLEM.rerun,
  run_log_archive_fallback_acknowledged: RECORD_PROBLEM.fallback,
  fallback_not_artifact_byte_equality_acknowledged: RECORD_PROBLEM.byteEquality,
  retrieval_availability_not_proven_acknowledged: RECORD_PROBLEM.availability,
});

/** How an input file was obtained; `read` is the only state that is checked further. */
export const INPUT_STATE = Object.freeze({
  read: 'READ',
  unreadable: 'UNREADABLE',
  oversized: 'OVERSIZED',
  notUtf8: 'NOT UTF-8',
});

/** A three-valued link: established, broken, or not checkable because an input failed. */
export const LINK = Object.freeze({
  match: 'MATCH',
  mismatch: 'MISMATCH',
  unchecked: 'UNCHECKED',
});

const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STRING_FIELDS = Object.freeze([
  'schema',
  'campaign_commit',
  'workflow_snapshot_sha256',
  'image_cohort_manifest_sha256',
  'primary_retrieval',
]);

/** SHA-256 of exactly these bytes, lowercase hex. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * One input as `{ state, bytes, text }`. `input` is `{ bytes }`,
 * `{ unreadable: true }` or `{ oversized: true }`. Bytes over `limit` count as
 * oversized; bytes that are not strict UTF-8 are never handed to a validator.
 * A BOM is kept in the text, so validators see and refuse it.
 */
function obtain(input, limit) {
  if (input?.oversized === true) return { state: INPUT_STATE.oversized };
  if (!input || input.unreadable || !(input.bytes instanceof Uint8Array)) {
    return { state: INPUT_STATE.unreadable };
  }
  if (input.bytes.byteLength > limit) return { state: INPUT_STATE.oversized };
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.bytes);
    return { state: INPUT_STATE.read, bytes: input.bytes, text };
  } catch {
    return { state: INPUT_STATE.notUtf8, bytes: input.bytes };
  }
}

/**
 * Validates the launch record text. Returns `{ accepted, problems, record }`:
 * `problems` are fixed strings in `RECORD_PROBLEM` order, and `record` holds
 * the validated linkage values only when accepted — for comparison, never for
 * printing.
 */
export function validateLaunchRecord(text) {
  const problems = new Set();
  const done = (record = null) => {
    const ordered = Object.values(RECORD_PROBLEM).filter((problem) => problems.has(problem));
    return {
      accepted: ordered.length === 0,
      problems: ordered,
      record: ordered.length === 0 ? record : null,
    };
  };

  const parsed = parseFlatJsonObject(text);
  if (!parsed.ok) {
    problems.add(RECORD_PROBLEM.syntax);
    return done();
  }
  const fields = new Map();
  for (const [name, value] of parsed.entries) {
    if (fields.has(name)) problems.add(RECORD_PROBLEM.duplicate);
    else fields.set(name, value);
    if (!LAUNCH_RECORD_FIELDS.includes(name)) problems.add(RECORD_PROBLEM.unknown);
  }
  if (LAUNCH_RECORD_FIELDS.some((name) => !fields.has(name))) problems.add(RECORD_PROBLEM.missing);
  // A structural problem means no value can be trusted, not even the ones that look right.
  if (problems.size > 0) return done();
  if (
    STRING_FIELDS.some((name) => typeof fields.get(name) !== 'string') ||
    LAUNCH_RECORD_ACKNOWLEDGMENTS.some((name) => typeof fields.get(name) !== 'boolean')
  ) {
    problems.add(RECORD_PROBLEM.type);
    return done();
  }

  if (fields.get('schema') !== LAUNCH_RECORD_SCHEMA) problems.add(RECORD_PROBLEM.schema);
  if (!COMMIT.test(fields.get('campaign_commit'))) problems.add(RECORD_PROBLEM.commit);
  if (!SHA256.test(fields.get('workflow_snapshot_sha256'))) {
    problems.add(RECORD_PROBLEM.workflowDigest);
  }
  if (!SHA256.test(fields.get('image_cohort_manifest_sha256'))) {
    problems.add(RECORD_PROBLEM.manifestDigest);
  }
  for (const name of LAUNCH_RECORD_ACKNOWLEDGMENTS) {
    if (fields.get(name) !== true) problems.add(ACKNOWLEDGMENT_PROBLEM[name]);
  }
  if (fields.get('primary_retrieval') !== PRIMARY_RETRIEVAL) {
    problems.add(RECORD_PROBLEM.primaryRetrieval);
  }

  return done({
    commit: fields.get('campaign_commit'),
    workflowDigest: fields.get('workflow_snapshot_sha256'),
    manifestDigest: fields.get('image_cohort_manifest_sha256'),
  });
}

/** Link state of an exact-bytes digest against the record's, or unchecked. */
function digestLink(obtained, expected) {
  if (obtained.state === INPUT_STATE.unreadable || obtained.state === INPUT_STATE.oversized) {
    return LINK.unchecked;
  }
  if (typeof expected !== 'string' || !SHA256.test(expected)) return LINK.unchecked;
  return sha256Hex(obtained.bytes) === expected ? LINK.match : LINK.mismatch;
}

/**
 * The whole preflight. `record`, `workflow` and `manifest` are each
 * `{ bytes }`, `{ unreadable: true }` or `{ oversized: true }`; `now` is the
 * explicit review time for the manifest's chronology.
 */
export function checkPreflightBundle({ record, workflow, manifest, now } = {}) {
  const recordInput = obtain(record, PREFLIGHT_INPUT_LIMITS.record);
  const workflowInput = obtain(workflow, PREFLIGHT_INPUT_LIMITS.workflow);
  const manifestInput = obtain(manifest, PREFLIGHT_INPUT_LIMITS.manifest);

  let recordResult;
  if (recordInput.state === INPUT_STATE.read) {
    recordResult = validateLaunchRecord(recordInput.text);
  } else {
    const problem = {
      [INPUT_STATE.unreadable]: RECORD_PROBLEM.unreadable,
      [INPUT_STATE.oversized]: RECORD_PROBLEM.tooLarge,
      [INPUT_STATE.notUtf8]: RECORD_PROBLEM.encoding,
    }[recordInput.state];
    recordResult = { accepted: false, problems: [problem], record: null };
  }
  const linked = recordResult.record;

  const workflowDigest = digestLink(workflowInput, linked?.workflowDigest);
  const workflowCheck =
    workflowInput.state === INPUT_STATE.read ? validateWorkflowDraft(workflowInput.text) : null;
  const workflowValid = workflowCheck !== null && workflowCheck.ok === true;

  const manifestDigest = digestLink(manifestInput, linked?.manifestDigest);
  let manifestCheck = null;
  if (manifestInput.state === INPUT_STATE.read) {
    manifestCheck = validateCohortManifest({ text: manifestInput.text }, { now });
  } else if (manifestInput.state === INPUT_STATE.oversized) {
    manifestCheck = validateCohortManifest({ oversized: true }, { now });
  } else if (manifestInput.state === INPUT_STATE.unreadable) {
    manifestCheck = validateCohortManifest({ unreadable: true }, { now });
  }
  const manifestAccepted = manifestCheck !== null && manifestCheck.accepted === true;

  let commitLink = LINK.unchecked;
  if (linked !== null && manifestAccepted) {
    commitLink = manifestCheck.commit === linked.commit ? LINK.match : LINK.mismatch;
  }

  const complete =
    recordResult.accepted &&
    workflowDigest === LINK.match &&
    workflowValid &&
    manifestDigest === LINK.match &&
    manifestAccepted &&
    commitLink === LINK.match;

  return {
    record: {
      state: recordInput.state,
      accepted: recordResult.accepted,
      problems: recordResult.problems,
    },
    workflow: {
      state: workflowInput.state,
      digest: workflowDigest,
      contract: workflowCheck === null ? LINK.unchecked : workflowValid ? 'PASS' : 'FAIL',
      problemCount: workflowCheck === null ? 0 : workflowCheck.problems.length,
    },
    manifest: {
      state: manifestInput.state,
      digest: manifestDigest,
      accepted: manifestAccepted,
      // Only the image-cohort review's own fixed vocabulary is ever passed on.
      problems: (manifestCheck?.problems ?? []).filter((problem) =>
        Object.values(MANIFEST_PROBLEM).includes(problem),
      ),
    },
    commit: commitLink,
    complete,
    exitCode: complete ? 0 : 1,
  };
}

/** The preflight as text. Every line is fixed apart from states and counts. */
export function formatPreflight(result) {
  const list = (items) => (items.length === 0 ? 'none' : items.join('; '));
  const { record, workflow, manifest } = result;
  const lines = [
    'ADR-055 launch preflight bundle check - offline; three named inputs only; nothing installed, pushed, dispatched or downloaded',
    `launch record: input=${record.state} ${record.accepted ? 'ACCEPTED' : 'REJECTED'}`,
    `  record problems: ${list(record.problems)}`,
    `workflow snapshot: input=${workflow.state} digest=${workflow.digest} contract=${workflow.contract} problems=${workflow.problemCount}`,
    `image-cohort manifest: input=${manifest.state} digest=${manifest.digest} ${
      manifest.accepted ? 'ACCEPTED' : 'REJECTED'
    }`,
    `  manifest problems: ${list(manifest.problems)}`,
    `campaign commit linkage (record vs manifest): ${result.commit}`,
    `policy: run_attempt must be 1; any rerun, retry or re-dispatch is ineligible - ${
      record.accepted ? 'ACKNOWLEDGED' : 'NOT ESTABLISHED'
    }`,
    `retrieval: primary ${PRIMARY_RETRIEVAL} (the workflow's per-slot uploads); fallback run-log archive recovery - limits ${
      record.accepted ? 'ACKNOWLEDGED' : 'NOT ESTABLISHED'
    }`,
    'not proven here: that this workflow is installed; that GitHub never retries internally; that any run has run_attempt 1; artifact reachability; archive availability; recovered-log equality with artifact bytes; a 59-job recovery',
    `PREFLIGHT: ${result.complete ? 'COMPLETE' : 'REJECTED'}`,
    'scope: validates an offline launch bundle only; installs nothing, proves no live account or platform fact, and does not change the launch-readiness NO-GO verdict.',
  ];
  return `${lines.join('\n')}\n`;
}
