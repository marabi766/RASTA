/**
 * Launch preflight bundle for the preregistered ADR-055 campaign.
 *
 * The workflow snapshot is the real committed draft, byte for byte. Every
 * launch record and image-cohort manifest here is **synthetic**: commits,
 * release names and dates are invented test values, and no real launch record
 * or manifest exists. Nothing needs Docker, PostgreSQL, GitHub or the network;
 * nothing is installed under `.github/workflows/`; files live only in temporary
 * directories that are removed afterwards.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  COHORT_MANIFEST_SCHEMA,
  MANIFEST_PROBLEM,
} from './aggregation-campaign-image-cohort-lib.mjs';
import {
  INPUT_STATE,
  LAUNCH_RECORD_ACKNOWLEDGMENTS,
  LAUNCH_RECORD_FIELDS,
  LAUNCH_RECORD_SCHEMA,
  LINK,
  MAX_RECORD_BYTES,
  PREFLIGHT_INPUT_LIMITS,
  PRIMARY_RETRIEVAL,
  RECORD_PROBLEM,
  checkPreflightBundle,
  formatPreflight,
  sha256Hex,
  validateLaunchRecord,
} from './aggregation-campaign-preflight-lib.mjs';
import { runPreflightCli } from './aggregation-campaign-preflight.mjs';
import { validateWorkflowDraft } from './aggregation-campaign-workflow-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const CLI = join(here, 'aggregation-campaign-preflight.mjs');
const LIB = join(here, 'aggregation-campaign-preflight-lib.mjs');
const DRAFT_PATH = join(
  repoRoot,
  'docs/evidence/adr-055/fresh-run-campaign-workflow-draft-2026-09-16.yaml.txt',
);
const DRAFT = readFileSync(DRAFT_PATH);
const BOM = String.fromCharCode(0xfeff);

const temporaryDirs = [];
function tempDir(prefix = 'aggregation-campaign-preflight-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Synthetic bundle

const COMMIT = 'f'.repeat(40);
const OTHER_COMMIT = '0'.repeat(40);
const NOW = new Date('2026-09-22T12:00:00Z');

const MANIFEST = Object.freeze({
  schema: COHORT_MANIFEST_SCHEMA,
  observed_at: '2026-09-20T08:00:00Z',
  runner_label: 'ubuntu-24.04',
  current_image_release: 'ubuntu24/20260914.310',
  current_image_published_at: '2026-09-15T09:00:00Z',
  previous_image_release: 'ubuntu24/20260907.300',
  previous_image_published_at: '2026-09-08T09:34:53Z',
  branch_c_on_topology_mismatch_acknowledged: true,
  campaign_commit: COMMIT,
});
const manifestBytes = (over = {}) =>
  Buffer.from(`${JSON.stringify({ ...MANIFEST, ...over }, null, 2)}\n`, 'utf8');
const MANIFEST_BYTES = manifestBytes();

const recordObject = ({ workflow = DRAFT, manifest = MANIFEST_BYTES, ...over } = {}) => ({
  schema: LAUNCH_RECORD_SCHEMA,
  campaign_commit: COMMIT,
  workflow_snapshot_sha256: sha256Hex(workflow),
  image_cohort_manifest_sha256: sha256Hex(manifest),
  require_run_attempt_one: true,
  rerun_retry_redispatch_ineligible_acknowledged: true,
  primary_retrieval: PRIMARY_RETRIEVAL,
  run_log_archive_fallback_acknowledged: true,
  fallback_not_artifact_byte_equality_acknowledged: true,
  retrieval_availability_not_proven_acknowledged: true,
  ...over,
});
const recordText = (options) => `${JSON.stringify(recordObject(options), null, 2)}\n`;
const recordBytes = (options) => Buffer.from(recordText(options), 'utf8');

/** A bundle from bytes; defaults are the valid synthetic bundle. */
const bundle = ({
  record,
  workflow = DRAFT,
  manifest = MANIFEST_BYTES,
  now = NOW,
  check = checkPreflightBundle,
} = {}) =>
  check({
    record: record === undefined ? { bytes: recordBytes() } : record,
    workflow: Buffer.isBuffer(workflow) ? { bytes: workflow } : workflow,
    manifest: Buffer.isBuffer(manifest) ? { bytes: manifest } : manifest,
    now,
  });
const withRecordText = (text, rest = {}) =>
  bundle({ record: { bytes: Buffer.from(text, 'utf8') }, ...rest });

const isComplete = (result) =>
  result.complete === true &&
  result.exitCode === 0 &&
  /^PREFLIGHT: COMPLETE$/m.test(formatPreflight(result));
const isRejected = (result) =>
  result.complete === false &&
  result.exitCode === 1 &&
  /^PREFLIGHT: REJECTED$/m.test(formatPreflight(result)) &&
  !/^PREFLIGHT: COMPLETE$/m.test(formatPreflight(result));

/** Fixed shape, bounded lines, one decision, nothing supplied echoed. */
const assertSafeOutput = (text, forbidden = []) => {
  const lines = text.split('\n');
  assert.equal(lines.at(-1), '');
  assert.equal(lines.length, 13, 'fixed number of lines');
  for (const line of lines) assert.ok(line.length <= 260, 'every line is bounded');
  assert.equal((text.match(/^PREFLIGHT: /gm) ?? []).length, 1);
  assert.ok(!/[0-9a-f]{40}/i.test(text), 'no commit or digest is echoed');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), 'no timestamp is echoed');
  assert.ok(!/ubuntu24\//.test(text), 'no image value is echoed');
  assert.ok(!/[A-Za-z]:[\\/]|\/tmp\/|docs\/evidence/.test(text), 'no path is echoed');
  for (const value of forbidden) assert.ok(!text.includes(value), 'no supplied value is echoed');
  assert.match(
    text,
    /^scope: validates an offline launch bundle only; installs nothing, proves no live account or platform fact, and does not change the launch-readiness NO-GO verdict\.$/m,
  );
};

// ---------------------------------------------------------------------------
// The complete bundle

test('preflight: the committed draft, a synthetic manifest and a linked record are COMPLETE', () => {
  assert.equal(validateWorkflowDraft(DRAFT.toString('utf8')).ok, true);
  assert.deepEqual(Object.keys(recordObject()), [...LAUNCH_RECORD_FIELDS]);
  const result = bundle();
  assert.ok(isComplete(result));
  assert.deepEqual(result.record, { state: INPUT_STATE.read, accepted: true, problems: [] });
  assert.deepEqual(result.workflow, {
    state: INPUT_STATE.read,
    digest: LINK.match,
    contract: 'PASS',
    problemCount: 0,
  });
  assert.deepEqual(result.manifest, {
    state: INPUT_STATE.read,
    digest: LINK.match,
    accepted: true,
    problems: [],
  });
  assert.equal(result.commit, LINK.match);
  const text = formatPreflight(result);
  assertSafeOutput(text);
  assert.match(text, /policy: run_attempt must be 1; .* - ACKNOWLEDGED$/m);
  assert.match(text, /not proven here: that this workflow is installed; that GitHub never retries/);
  assert.equal(formatPreflight(bundle()), text, 'deterministic');
  // A compact spelling of the same record is the same record.
  assert.ok(isComplete(withRecordText(JSON.stringify(recordObject()))));
});

// ---------------------------------------------------------------------------
// Byte links

test('preflight: any byte change to the workflow or manifest breaks its digest link', () => {
  const draft = DRAFT.toString('utf8');
  const workflowVariants = {
    'extra trailing newline': Buffer.from(`${draft}\n`),
    'comment edited': Buffer.from(draft.replace('REVIEW DRAFT', 'REVIEW  DRAFT')),
    'trailing space on a comment': Buffer.from(
      draft.replace('NOT A WORKFLOW.', 'NOT A WORKFLOW. '),
    ),
    'CRLF line endings': Buffer.from(draft.replace(/\n/g, '\r\n')),
  };
  for (const [name, bytes] of Object.entries(workflowVariants)) {
    assert.notDeepEqual(bytes, DRAFT, name);
    const result = bundle({ workflow: bytes });
    assert.ok(isRejected(result), name);
    assert.equal(result.workflow.digest, LINK.mismatch, name);
    assert.equal(result.manifest.digest, LINK.match, name);
    assertSafeOutput(formatPreflight(result));
  }
  // The semantically harmless edits still pass the contract: only the link failed,
  // and re-recording their digest makes the bundle complete again.
  for (const name of ['extra trailing newline', 'comment edited', 'trailing space on a comment']) {
    const bytes = workflowVariants[name];
    assert.equal(bundle({ workflow: bytes }).workflow.contract, 'PASS', name);
    const relinked = bundle({
      workflow: bytes,
      record: { bytes: recordBytes({ workflow: bytes }) },
    });
    assert.ok(isComplete(relinked), `${name} relinked`);
  }
  // CRLF is not normalised: the validator refuses it too.
  assert.equal(
    bundle({ workflow: workflowVariants['CRLF line endings'] }).workflow.contract,
    'FAIL',
  );

  const manifestText = MANIFEST_BYTES.toString('utf8');
  const manifestVariants = {
    compact: Buffer.from(JSON.stringify(MANIFEST)),
    'CRLF line endings': Buffer.from(manifestText.replace(/\n/g, '\r\n')),
    'reordered fields': Buffer.from(
      `${JSON.stringify(Object.fromEntries(Object.entries(MANIFEST).reverse()), null, 2)}\n`,
    ),
    'no trailing newline': Buffer.from(manifestText.trimEnd()),
  };
  for (const [name, bytes] of Object.entries(manifestVariants)) {
    const result = bundle({ manifest: bytes });
    assert.ok(isRejected(result), name);
    assert.equal(result.manifest.digest, LINK.mismatch, name);
    assert.equal(result.manifest.accepted, true, `${name} is still a valid manifest`);
    assert.equal(result.commit, LINK.match, name);
    const relinked = bundle({
      manifest: bytes,
      record: { bytes: recordBytes({ manifest: bytes }) },
    });
    assert.ok(isComplete(relinked), `${name} relinked`);
  }

  // Swapped digests are two mismatches, not a match.
  const swapped = recordObject();
  [swapped.workflow_snapshot_sha256, swapped.image_cohort_manifest_sha256] = [
    swapped.image_cohort_manifest_sha256,
    swapped.workflow_snapshot_sha256,
  ];
  const result = withRecordText(JSON.stringify(swapped));
  assert.ok(isRejected(result));
  assert.equal(result.workflow.digest, LINK.mismatch);
  assert.equal(result.manifest.digest, LINK.mismatch);
});

test('preflight: the record commit must equal the manifest campaign_commit', () => {
  const recordOther = bundle({ record: { bytes: recordBytes({ campaign_commit: OTHER_COMMIT }) } });
  assert.ok(isRejected(recordOther));
  assert.equal(recordOther.commit, LINK.mismatch);
  assert.equal(recordOther.record.accepted, true);
  assert.equal(recordOther.manifest.accepted, true);
  assertSafeOutput(formatPreflight(recordOther), [OTHER_COMMIT]);

  const other = manifestBytes({ campaign_commit: OTHER_COMMIT });
  const manifestOther = bundle({
    manifest: other,
    record: { bytes: recordBytes({ manifest: other }) },
  });
  assert.ok(isRejected(manifestOther));
  assert.equal(manifestOther.manifest.digest, LINK.match);
  assert.equal(manifestOther.commit, LINK.mismatch);
  assert.match(
    formatPreflight(manifestOther),
    /^campaign commit linkage \(record vs manifest\): MISMATCH$/m,
  );
});

// ---------------------------------------------------------------------------
// The two reused validators

test('preflight: a linked workflow that violates the contract is rejected', () => {
  const draft = DRAFT.toString('utf8');
  const broken = {
    'fail-fast true': draft.replace(/^( +)fail-fast: false$/m, '$1fail-fast: true'),
    'wrong runner': draft.replace(/^( +)runs-on: ubuntu-24\.04$/m, '$1runs-on: ubuntu-latest'),
    'longer timeout': draft.replace(/^( +)timeout-minutes: 45$/m, '$1timeout-minutes: 60'),
    'dispatch trigger': draft.replace('on:\n  push:', 'on:\n  workflow_dispatch:\n  push:'),
    'no run_attempt guard': draft.replace('!= "1"', '!= "2"'),
    'slot 59 dropped': draft.replace(', 58, 59]', ', 58]'),
  };
  for (const [name, text] of Object.entries(broken)) {
    assert.notEqual(text, draft, `${name} must change the draft`);
    const bytes = Buffer.from(text);
    const result = bundle({ workflow: bytes, record: { bytes: recordBytes({ workflow: bytes }) } });
    assert.ok(isRejected(result), name);
    assert.equal(result.workflow.digest, LINK.match, name);
    assert.equal(result.workflow.contract, 'FAIL', name);
    assert.ok(result.workflow.problemCount > 0, name);
    assertSafeOutput(formatPreflight(result));
  }
  // Workflow problems are counted, never printed: they may carry line numbers or key names.
  const extraKey = Buffer.from(
    draft.replace('permissions:', 'secret_key_name_zz: x\npermissions:'),
  );
  const out = formatPreflight(
    bundle({ workflow: extraKey, record: { bytes: recordBytes({ workflow: extraKey }) } }),
  );
  assert.ok(!out.includes('secret_key_name_zz'));
});

test('preflight: a linked manifest that the image-cohort review rejects is rejected', () => {
  const cases = [
    [{ branch_c_on_topology_mismatch_acknowledged: false }, MANIFEST_PROBLEM.acknowledgment],
    [{ observed_at: '2026-09-22T12:00:01Z' }, MANIFEST_PROBLEM.observedFuture],
    [{ runner_label: 'ubuntu-latest' }, MANIFEST_PROBLEM.runnerLabel],
    [{ previous_image_release: MANIFEST.current_image_release }, MANIFEST_PROBLEM.sameRelease],
    [{ campaign_commit: 'abc' }, MANIFEST_PROBLEM.commit],
  ];
  for (const [over, problem] of cases) {
    const bytes = manifestBytes(over);
    const result = bundle({ manifest: bytes, record: { bytes: recordBytes({ manifest: bytes }) } });
    assert.ok(isRejected(result), problem);
    assert.equal(result.manifest.digest, LINK.match);
    assert.equal(result.manifest.accepted, false);
    assert.ok(result.manifest.problems.includes(problem), problem);
    assert.equal(result.commit, LINK.unchecked, 'no commit is taken from a rejected manifest');
    assertSafeOutput(formatPreflight(result), Object.values(over).map(String));
  }
  // The review time is explicit: without it the manifest cannot be accepted.
  const noClock = bundle({ now: null });
  assert.ok(isRejected(noClock));
  assert.deepEqual(noClock.manifest.problems, [MANIFEST_PROBLEM.observedFuture]);
  // A manifest with a raw duplicate field is refused by the reused scanner.
  const duplicate = Buffer.from(
    MANIFEST_BYTES.toString('utf8').replace('{\n', `{\n  "campaign_commit": "${COMMIT}",\n`),
  );
  const dup = bundle({
    manifest: duplicate,
    record: { bytes: recordBytes({ manifest: duplicate }) },
  });
  assert.deepEqual(dup.manifest.problems, [MANIFEST_PROBLEM.duplicate]);
});

// ---------------------------------------------------------------------------
// The launch record

test('record: every field missing, duplicated, unknown or mistyped is rejected', () => {
  const full = recordObject();
  const text = recordText();
  for (const name of LAUNCH_RECORD_FIELDS) {
    const { [name]: _removed, ...without } = full;
    assert.deepEqual(
      validateLaunchRecord(JSON.stringify(without)).problems,
      [RECORD_PROBLEM.missing],
      `missing ${name}`,
    );

    const duplicated = text.replace(
      '{\n',
      `{\n  ${JSON.stringify(name)}: ${JSON.stringify(full[name])},\n`,
    );
    assert.deepEqual(
      validateLaunchRecord(duplicated).problems,
      [RECORD_PROBLEM.duplicate],
      `duplicate ${name}`,
    );

    const mistyped = {
      ...full,
      [name]: typeof full[name] === 'boolean' ? String(full[name]) : true,
    };
    assert.deepEqual(
      validateLaunchRecord(JSON.stringify(mistyped)).problems,
      [RECORD_PROBLEM.type],
      `mistyped ${name}`,
    );

    for (const result of [
      withRecordText(JSON.stringify(without)),
      withRecordText(duplicated),
      withRecordText(JSON.stringify(mistyped)),
    ]) {
      assert.ok(isRejected(result), name);
      assert.equal(result.workflow.digest, LINK.unchecked, 'no link from a rejected record');
      assert.equal(result.commit, LINK.unchecked);
      assertSafeOutput(formatPreflight(result));
    }
  }
  // An escaped spelling of a field name is still that field.
  assert.deepEqual(
    validateLaunchRecord(text.replace('{\n', '{\n  "\\u0073chema": "x",\n')).problems,
    [RECORD_PROBLEM.duplicate],
  );
  const unknownField = 'account_id_zz';
  const unknown = withRecordText(JSON.stringify({ ...full, [unknownField]: 'run-123456789' }));
  assert.deepEqual(unknown.record.problems, [RECORD_PROBLEM.unknown]);
  assertSafeOutput(formatPreflight(unknown), [unknownField, 'run-123456789']);
  for (const extra of ['run_id', 'observed_at', 'image_version', 'billing_minutes']) {
    assert.deepEqual(validateLaunchRecord(JSON.stringify({ ...full, [extra]: 'x' })).problems, [
      RECORD_PROBLEM.unknown,
    ]);
  }
});

test('record: every false acknowledgment, bad enum, digest, commit or schema is rejected', () => {
  const problemFor = {
    require_run_attempt_one: RECORD_PROBLEM.runAttempt,
    rerun_retry_redispatch_ineligible_acknowledged: RECORD_PROBLEM.rerun,
    run_log_archive_fallback_acknowledged: RECORD_PROBLEM.fallback,
    fallback_not_artifact_byte_equality_acknowledged: RECORD_PROBLEM.byteEquality,
    retrieval_availability_not_proven_acknowledged: RECORD_PROBLEM.availability,
  };
  assert.deepEqual(Object.keys(problemFor), [...LAUNCH_RECORD_ACKNOWLEDGMENTS]);
  for (const [name, problem] of Object.entries(problemFor)) {
    const result = bundle({ record: { bytes: recordBytes({ [name]: false }) } });
    assert.ok(isRejected(result), name);
    assert.deepEqual(result.record.problems, [problem]);
    assert.match(formatPreflight(result), /- NOT ESTABLISHED$/m);
  }
  const values = [
    [{ primary_retrieval: 'run-log-archive-recovery' }, RECORD_PROBLEM.primaryRetrieval],
    [{ primary_retrieval: 'PER-SLOT-UPLOADED-ARTIFACTS' }, RECORD_PROBLEM.primaryRetrieval],
    [{ primary_retrieval: `${PRIMARY_RETRIEVAL} ` }, RECORD_PROBLEM.primaryRetrieval],
    [{ schema: 'adr-055-launch-preflight-record/v2' }, RECORD_PROBLEM.schema],
    [{ campaign_commit: COMMIT.toUpperCase() }, RECORD_PROBLEM.commit],
    [{ campaign_commit: COMMIT.slice(0, 7) }, RECORD_PROBLEM.commit],
    [{ workflow_snapshot_sha256: sha256Hex(DRAFT).toUpperCase() }, RECORD_PROBLEM.workflowDigest],
    [{ workflow_snapshot_sha256: sha256Hex(DRAFT).slice(1) }, RECORD_PROBLEM.workflowDigest],
    [{ workflow_snapshot_sha256: `sha256:${sha256Hex(DRAFT)}` }, RECORD_PROBLEM.workflowDigest],
    [{ image_cohort_manifest_sha256: 'z'.repeat(64) }, RECORD_PROBLEM.manifestDigest],
    [{ image_cohort_manifest_sha256: '' }, RECORD_PROBLEM.manifestDigest],
  ];
  for (const [over, problem] of values) {
    const result = bundle({ record: { bytes: recordBytes(over) } });
    assert.ok(isRejected(result), problem);
    assert.deepEqual(result.record.problems, [problem]);
    // The fixed enum itself is printed; any other supplied value is not.
    const supplied = Object.values(over).filter(
      (value) => value.length > 8 && !value.startsWith(PRIMARY_RETRIEVAL),
    );
    assertSafeOutput(formatPreflight(result), supplied);
  }
  // Several at once come back in the fixed order.
  assert.deepEqual(
    validateLaunchRecord(
      JSON.stringify(
        recordObject({ primary_retrieval: 'x', require_run_attempt_one: false, schema: 'x' }),
      ),
    ).problems,
    [RECORD_PROBLEM.schema, RECORD_PROBLEM.runAttempt, RECORD_PROBLEM.primaryRetrieval],
  );
  assert.equal(validateLaunchRecord(recordText({ schema: 'x' })).record, null);
});

test('record: BOM, comments, trailing data, nesting and non-JSON values are rejected', () => {
  const text = recordText();
  const cases = {
    BOM: `${BOM}${text}`,
    'line comment': `// launch\n${text}`,
    'block comment': text.replace('{\n', '{ /* launch */\n'),
    'trailing data': `${text}{}`,
    'trailing comma': text.replace(/\n}\n$/, ',\n}\n'),
    'nested object': JSON.stringify(
      recordObject({ primary_retrieval: { mode: PRIMARY_RETRIEVAL } }),
    ),
    'array value': JSON.stringify(recordObject({ campaign_commit: [COMMIT] })),
    'number value': JSON.stringify(recordObject({ require_run_attempt_one: 1 })),
    'null value': JSON.stringify(recordObject({ require_run_attempt_one: null })),
    'top-level array': `[${text}]`,
    'single quotes': text.replace('"schema"', "'schema'"),
    'raw tab in string': text.replace(PRIMARY_RETRIEVAL, `${PRIMARY_RETRIEVAL}\t`),
    empty: '',
  };
  for (const [name, variant] of Object.entries(cases)) {
    assert.deepEqual(validateLaunchRecord(variant).problems, [RECORD_PROBLEM.syntax], name);
    assert.ok(isRejected(withRecordText(variant)), name);
  }
  const notUtf8 = bundle({ record: { bytes: Buffer.from([0x7b, 0xff, 0x7d]) } });
  assert.deepEqual(notUtf8.record, {
    state: INPUT_STATE.notUtf8,
    accepted: false,
    problems: [RECORD_PROBLEM.encoding],
  });
  const tooBig = Buffer.from(text.replace('{\n', `{${' '.repeat(MAX_RECORD_BYTES)}\n`));
  assert.deepEqual(bundle({ record: { bytes: tooBig } }).record.problems, [
    RECORD_PROBLEM.tooLarge,
  ]);
  assert.deepEqual(bundle({ record: { unreadable: true } }).record.problems, [
    RECORD_PROBLEM.unreadable,
  ]);
  assert.deepEqual(bundle({ record: { oversized: true } }).record.problems, [
    RECORD_PROBLEM.tooLarge,
  ]);
  assert.deepEqual(bundle({ record: null }).record.problems, [RECORD_PROBLEM.unreadable]);

  const badWorkflow = bundle({ workflow: Buffer.from([0x6e, 0x61, 0xc3]) });
  assert.equal(badWorkflow.workflow.state, INPUT_STATE.notUtf8);
  assert.equal(badWorkflow.workflow.contract, LINK.unchecked);
  assert.ok(isRejected(badWorkflow));
  const oversizedWorkflow = bundle({
    workflow: Buffer.alloc(PREFLIGHT_INPUT_LIMITS.workflow + 1, 0x20),
  });
  assert.equal(oversizedWorkflow.workflow.state, INPUT_STATE.oversized);
  assert.equal(oversizedWorkflow.workflow.digest, LINK.unchecked);
  const unreadableManifest = bundle({ manifest: { unreadable: true } });
  assert.equal(unreadableManifest.manifest.state, INPUT_STATE.unreadable);
  assert.deepEqual(unreadableManifest.manifest.problems, [MANIFEST_PROBLEM.unreadable]);
  const bomManifest = Buffer.concat([Buffer.from(BOM), MANIFEST_BYTES]);
  const bom = bundle({
    manifest: bomManifest,
    record: { bytes: recordBytes({ manifest: bomManifest }) },
  });
  assert.equal(bom.manifest.digest, LINK.match);
  assert.deepEqual(bom.manifest.problems, [MANIFEST_PROBLEM.syntax]);
});

test('preflight: diagnostics are deterministic, bounded and leak nothing supplied', () => {
  const secret = 'ghp_' + 'Q'.repeat(36);
  const hostile = [
    JSON.stringify({ ...recordObject(), [secret]: secret }),
    JSON.stringify(recordObject({ primary_retrieval: secret })),
    JSON.stringify(recordObject({ campaign_commit: secret })),
    `{"schema": "${secret}", "schema": "${secret}"}`,
    `${'['.repeat(128)}${secret}`,
  ];
  for (const text of hostile) {
    const first = formatPreflight(
      withRecordText(text, { manifest: manifestBytes({ runner_label: secret }) }),
    );
    const second = formatPreflight(
      withRecordText(text, { manifest: manifestBytes({ runner_label: secret }) }),
    );
    assert.equal(first, second);
    assertSafeOutput(first, [secret, 'ghp_']);
  }
});

// ---------------------------------------------------------------------------
// Mutation-style checks against the real library source

/**
 * Bundles whose expected result is fixed. A mutant of the library that gets
 * any of them wrong is caught.
 */
function scenarios() {
  const draft = DRAFT.toString('utf8');
  const brokenWorkflow = Buffer.from(draft.replace(/^( +)fail-fast: false$/m, '$1fail-fast: true'));
  const unacknowledgedManifest = manifestBytes({
    branch_c_on_topology_mismatch_acknowledged: false,
  });
  const crlfManifest = Buffer.from(MANIFEST_BYTES.toString('utf8').replace(/\n/g, '\r\n'));
  const list = [
    { name: 'valid', complete: true, options: {} },
    { name: 'workflow digest', complete: false, options: { workflow: Buffer.from(`${draft}\n`) } },
    {
      name: 'manifest digest',
      complete: false,
      options: { manifest: Buffer.from(JSON.stringify(MANIFEST)) },
    },
    { name: 'manifest CRLF bytes', complete: false, options: { manifest: crlfManifest } },
    {
      name: 'commit linkage',
      complete: false,
      options: { record: { bytes: recordBytes({ campaign_commit: OTHER_COMMIT }) } },
    },
    {
      name: 'workflow validation',
      complete: false,
      options: {
        workflow: brokenWorkflow,
        record: { bytes: recordBytes({ workflow: brokenWorkflow }) },
      },
    },
    {
      name: 'manifest validation',
      complete: false,
      options: {
        manifest: unacknowledgedManifest,
        record: { bytes: recordBytes({ manifest: unacknowledgedManifest }) },
      },
    },
    {
      name: 'primary retrieval',
      complete: false,
      options: { record: { bytes: recordBytes({ primary_retrieval: 'artifacts' }) } },
    },
  ];
  for (const name of LAUNCH_RECORD_ACKNOWLEDGMENTS) {
    list.push({
      name: `acknowledgment ${name}`,
      complete: false,
      options: { record: { bytes: recordBytes({ [name]: false }) } },
    });
  }
  return list;
}

const failuresUnder = (check) =>
  scenarios()
    .filter(({ complete, options }) => bundle({ ...options, check }).complete !== complete)
    .map(({ name }) => name);

test('preflight: bypassing a digest link, commit linkage, a validator or an acknowledgment is caught', async () => {
  assert.deepEqual(
    failuresUnder(checkPreflightBundle),
    [],
    'the real library passes every scenario',
  );

  const source = readFileSync(LIB, 'utf8');
  const absolute = (name) => pathToFileURL(join(here, name)).href;
  const importable = source
    .replace(
      "'./aggregation-campaign-image-cohort-lib.mjs'",
      `'${absolute('aggregation-campaign-image-cohort-lib.mjs')}'`,
    )
    .replace(
      "'./aggregation-campaign-workflow-lib.mjs'",
      `'${absolute('aggregation-campaign-workflow-lib.mjs')}'`,
    );
  assert.notEqual(importable, source);

  const mutants = [
    ['workflow digest link bypassed', '    workflowDigest === LINK.match &&\n', ''],
    ['manifest digest link bypassed', '    manifestDigest === LINK.match &&\n', ''],
    [
      'digest over normalised text',
      'sha256Hex(obtained.bytes) === expected',
      "sha256Hex(obtained.text === undefined ? obtained.bytes : obtained.text.replace(/\\r\\n/g, '\\n').trimEnd() + '\\n') === expected",
    ],
    ['commit linkage bypassed', '    commitLink === LINK.match;\n', '    true;\n'],
    ['workflow result ignored', '    workflowValid &&\n', ''],
    [
      'workflow validator bypassed',
      'validateWorkflowDraft(workflowInput.text)',
      '({ ok: true, problems: [] })',
    ],
    [
      'manifest validator bypassed',
      'validateCohortManifest({ text: manifestInput.text }, { now })',
      '({ accepted: true, problems: [], commit: JSON.parse(manifestInput.text).campaign_commit })',
    ],
    [
      'acknowledgments not checked',
      '    if (fields.get(name) !== true) problems.add(ACKNOWLEDGMENT_PROBLEM[name]);\n',
      '',
    ],
    [
      'primary retrieval not checked',
      "  if (fields.get('primary_retrieval') !== PRIMARY_RETRIEVAL) {\n    problems.add(RECORD_PROBLEM.primaryRetrieval);\n  }\n",
      '',
    ],
    // Dropping one name from the acknowledgment list (the field list still requires it).
    ...LAUNCH_RECORD_ACKNOWLEDGMENTS.map((name) => [`acknowledgment ${name} dropped`, null, null]),
  ];

  const dir = tempDir('aggregation-campaign-preflight-mutant-');
  let index = 0;
  for (const [name, from, to] of mutants) {
    let mutated;
    if (to === null) {
      // Drop one name from the acknowledgment list only (not from the field list).
      const ackName = name.replace(/^acknowledgment /, '').replace(/ dropped$/, '');
      const start = importable.indexOf('export const LAUNCH_RECORD_ACKNOWLEDGMENTS');
      const end = importable.indexOf(']);', start);
      const block = importable.slice(start, end);
      assert.ok(block.includes(`  '${ackName}',\n`), name);
      mutated =
        importable.slice(0, start) + block.replace(`  '${ackName}',\n`, '') + importable.slice(end);
    } else {
      assert.ok(importable.includes(from), `mutation target present: ${name}`);
      mutated = importable.replace(from, to);
    }
    assert.notEqual(mutated, importable, name);
    const file = join(dir, `mutant-${(index += 1)}.mjs`);
    writeFileSync(file, mutated);
    const mutant = await import(pathToFileURL(file).href);
    const failures = failuresUnder(mutant.checkPreflightBundle);
    assert.ok(failures.length > 0, `mutant "${name}" must be caught`);
  }
});

// ---------------------------------------------------------------------------
// The entry point

test('preflight CLI: argument errors exit 2 and read nothing', () => {
  const touched = [];
  const io = {
    sizeOf: (path) => {
      touched.push(path);
      return 1;
    },
    readBytes: (path) => {
      touched.push(path);
      return Buffer.from('');
    },
    now: NOW,
  };
  for (const argv of [
    [],
    ['--'],
    ['record.json'],
    ['record.json', 'workflow.yml'],
    ['record.json', 'workflow.yml', 'manifest.json', 'extra.json'],
    ['--record', 'record.json', 'workflow.yml', 'manifest.json'],
    ['record.json', '-', 'manifest.json'],
  ]) {
    const result = runPreflightCli({ argv, ...io });
    assert.equal(result.exitCode, 2, JSON.stringify(argv));
    assert.match(result.output, /^usage: /m);
    assert.ok(!/record\.json|workflow\.yml|manifest\.json/.test(result.output));
  }
  assert.deepEqual(touched, [], 'a usage error reads no file');
  assert.equal(runPreflightCli({ argv: ['--', 'a', 'b', 'c'], ...io }).exitCode, 1);
});

test('preflight CLI: three explicit files in, one decision out, nothing written or named', () => {
  const dir = tempDir();
  const write = (name, bytes) => {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  };
  const workflow = write('adr-055-fresh-run-first-pair.yml', DRAFT);
  const manifest = write('image-cohort.json', MANIFEST_BYTES);
  const record = write('launch-record.json', recordBytes());
  const before = readdirSync(dir).sort();

  const ok = runPreflightCli({ argv: ['--', record, workflow, manifest], now: NOW });
  assert.equal(ok.exitCode, 0);
  assert.match(ok.output, /^PREFLIGHT: COMPLETE$/m);
  assertSafeOutput(ok.output, [dir, 'launch-record', 'image-cohort.json']);

  // Order matters: the inputs are positional, never guessed from content or names.
  const swapped = runPreflightCli({ argv: [record, manifest, workflow], now: NOW });
  assert.equal(swapped.exitCode, 1);

  // An unreadable input is a state, not a name.
  const missing = runPreflightCli({ argv: [record, join(dir, 'absent.yml'), manifest], now: NOW });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.output, /^workflow snapshot: input=UNREADABLE digest=UNCHECKED/m);
  assertSafeOutput(missing.output, ['absent']);

  // Oversized inputs are never read.
  const reads = [];
  const oversized = runPreflightCli({
    argv: [record, workflow, manifest],
    now: NOW,
    sizeOf: (path) => (path === workflow ? PREFLIGHT_INPUT_LIMITS.workflow + 1 : 10),
    readBytes: (path) => {
      reads.push(path);
      return readFileSync(path);
    },
  });
  assert.equal(oversized.exitCode, 1);
  assert.match(
    oversized.output,
    /^workflow snapshot: input=OVERSIZED digest=UNCHECKED contract=UNCHECKED/m,
  );
  assert.deepEqual(reads.sort(), [manifest, record].sort());
  for (const [target, limit] of [
    [record, PREFLIGHT_INPUT_LIMITS.record],
    [manifest, PREFLIGHT_INPUT_LIMITS.manifest],
  ]) {
    const seen = [];
    const result = runPreflightCli({
      argv: [record, workflow, manifest],
      now: NOW,
      sizeOf: (path) => (path === target ? limit + 1 : 10),
      readBytes: (path) => {
        seen.push(path);
        return readFileSync(path);
      },
    });
    assert.equal(result.exitCode, 1);
    assert.ok(!seen.includes(target), 'the oversized file is not read');
  }

  // A failing read after a successful size check is unreadable, and leaks nothing.
  const flaky = runPreflightCli({
    argv: [record, workflow, manifest],
    now: NOW,
    readBytes: () => {
      throw new Error(`EACCES: ${dir}`);
    },
  });
  assert.equal(flaky.exitCode, 1);
  assertSafeOutput(flaky.output, [dir, 'EACCES']);

  // The real entry point, as a process, on the real clock with a past synthetic snapshot.
  const pastManifestBytes = manifestBytes({
    observed_at: '2026-01-15T00:00:00Z',
    current_image_release: 'ubuntu24/20260112.100',
    current_image_published_at: '2026-01-13T00:00:00Z',
    previous_image_release: 'ubuntu24/20260105.90',
    previous_image_published_at: '2026-01-06T00:00:00Z',
  });
  const pastManifest = write('past-image-cohort.json', pastManifestBytes);
  const pastRecord = write('past-launch-record.json', recordBytes({ manifest: pastManifestBytes }));
  const run = (args) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
  const complete = run([pastRecord, workflow, pastManifest]);
  assert.equal(complete.status, 0, complete.stderr);
  assert.match(complete.stdout, /^PREFLIGHT: COMPLETE$/m);
  assert.equal(complete.stderr, '');
  const rejected = run([record, workflow, pastManifest]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /^PREFLIGHT: REJECTED$/m);
  assert.equal(run([]).status, 2);
  assert.equal(run(['--', pastRecord, workflow]).status, 2);
  assert.equal(run(['--json', pastRecord, workflow, pastManifest]).status, 2);

  assert.deepEqual(
    readdirSync(dir).sort(),
    [...before, 'past-image-cohort.json', 'past-launch-record.json'].sort(),
    'the check writes nothing',
  );
  assert.deepEqual(readFileSync(DRAFT_PATH), DRAFT, 'the committed draft is only read');
});
