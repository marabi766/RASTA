/**
 * Runner/image cohort review for the preregistered 59-slot campaign.
 *
 * Every report is rendered by the real `formatCalibrationReport` from real
 * summaries. Every manifest here is **synthetic**: its release names, dates and
 * commit are invented test values, not observations of the real release state.
 * Nothing needs Docker, PostgreSQL, GitHub or the network; files live only in
 * temporary directories that are removed afterwards.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CAMPAIGN_SLOT_COUNT, accountCampaign } from './aggregation-campaign-accounting-lib.mjs';
import {
  COHORT_DECISION,
  COHORT_MANIFEST_FIELDS,
  COHORT_MANIFEST_SCHEMA,
  COHORT_PROBLEM,
  MANIFEST_PROBLEM,
  MAX_MANIFEST_BYTES,
  formatCohortReview,
  reviewImageCohort,
  validateCohortManifest,
} from './aggregation-campaign-image-cohort-lib.mjs';
import {
  MAX_REPORT_BYTES,
  MAX_REPORT_PATHS,
  USAGE_ERROR,
  runImageCohortCli,
} from './aggregation-campaign-image-cohort.mjs';
import {
  MAX_REPORT_MANIFEST_BYTES,
  REPORT_MANIFEST_PROBLEM,
} from './aggregation-campaign-report-manifest-lib.mjs';
import {
  LAUNCHER,
  PROCESS_OUTCOME,
  calibrationProbeId,
  calibrationStressId,
  formatCalibrationReport,
  missingEnvironmentDiagnostic,
  sealProbeOutcome,
  summarizeCalibration,
  summarizeJestRun,
} from './aggregation-evidence-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const CLI = join(here, 'aggregation-campaign-image-cohort.mjs');
const BOM = String.fromCharCode(0xfeff);

const temporaryDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'aggregation-campaign-image-cohort-test-'));
  temporaryDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Reports rendered by the real harness code

const COMMIT = 'd'.repeat(40);
const OTHER_COMMIT = 'e'.repeat(40);

/** Every field the harness captures, with the values of the committed induced artifact. */
const TOPOLOGY = Object.freeze({
  runner_os: '"Ubuntu 24.04.5 LTS"',
  runner_image: 'ubuntu24/20260907.300.1',
  kernel: '6.17.0-1022-azure',
  cpus: 4,
  memory_gib: '15.6',
  docker_storage_driver: 'overlay2',
  postgres_image: 'postgis/postgis:16-3.4',
  server_version: '16.4 (Debian 16.4-1.pgdg110+2)',
  fsync: 'on',
  synchronous_commit: 'on',
  wal_level: 'replica',
  wal_sync_method: 'fdatasync',
  full_page_writes: 'on',
  shared_buffers: '128MB',
  max_connections: '100',
  max_wal_size: '1GB',
  checkpoint_timeout: '5min',
});

/** One plausible drift per captured field (synthetic values). */
const DRIFT = Object.freeze({
  runner_os: '"Ubuntu 24.04.6 LTS"',
  runner_image: 'ubuntu24/20260914.310.1',
  kernel: '6.17.0-1023-azure',
  cpus: 2,
  memory_gib: '15.5',
  docker_storage_driver: 'vfs',
  postgres_image: 'postgis/postgis:16-3.5',
  server_version: '16.5 (Debian 16.5-1.pgdg110+1)',
  fsync: 'off',
  synchronous_commit: 'off',
  wal_level: 'logical',
  wal_sync_method: 'fsync',
  full_page_writes: 'off',
  shared_buffers: '256MB',
  max_connections: '200',
  max_wal_size: '2GB',
  checkpoint_timeout: '15min',
});

const probe = () =>
  sealProbeOutcome({
    transactions: 12000,
    failed: 0,
    tps: 200,
    latencyAverageMs: 5,
    walSyncDelta: 12000,
    walSyncPerSecond: 200,
    walSyncPerTransaction: 1.0,
    walRecordsPerTransaction: 2.0,
    minIntervalTps: 30,
    zeroCommitIntervals: 0,
    longestZeroCommitSeconds: 0,
    problems: [],
    diagnostics: [],
  });

const jestReport = (messages) => {
  const failed = messages.length;
  return {
    numTotalTests: 22,
    numPassedTests: 22 - failed,
    numFailedTests: failed,
    numTotalTestSuites: 1,
    numPassedTestSuites: failed === 0 ? 1 : 0,
    numFailedTestSuites: failed === 0 ? 0 : 1,
    numPendingTestSuites: 0,
    numRuntimeErrorTestSuites: 0,
    success: failed === 0,
    testResults: [
      {
        status: failed === 0 ? 'passed' : 'failed',
        assertionResults: [
          ...messages.map((message) => ({ status: 'failed', failureMessages: [message] })),
          ...Array.from({ length: 22 - failed }, () => ({ status: 'passed' })),
        ],
      },
    ],
  };
};

const WAL = { walSync: 100, walRecords: 200, walWrite: 100, walBytes: 1000 };
const measuredSummary = (messages) => {
  const control = sealProbeOutcome({ problems: [], diagnostics: [] });
  const pairProbe = probe();
  const stress = summarizeJestRun({
    step: { id: calibrationStressId(1), kind: 'jest-full' },
    result: {
      launcher: LAUNCHER.pnpm,
      outcome: PROCESS_OUTCOME.completed,
      exitCode: messages.length === 0 ? 0 : 1,
      startedAt: new Date('2026-09-16T00:00:00.000Z'),
      endedAt: new Date('2026-09-16T00:02:15.000Z'),
    },
    report: jestReport(messages),
    walBefore: WAL,
    walAfter: { ...WAL, walSync: 700 },
    samples: null,
  });
  return summarizeCalibration({
    pairs: 1,
    results: [
      { id: 'control', passed: control.valid, probe: control, diagnostics: control.diagnostics },
      {
        id: calibrationProbeId(1),
        passed: pairProbe.valid,
        probe: pairProbe,
        diagnostics: pairProbe.diagnostics,
      },
      stress,
    ],
  });
};

const ENV_57014 = 'error: canceling statement due to statement timeout';
const PRODUCT = '    > 212 |       expect(rows).toHaveLength(1);';

const SUMMARY = {
  pass: () => measuredSummary([]),
  event: () => measuredSummary([ENV_57014]),
  product: () => measuredSummary([PRODUCT]),
  refused: () =>
    summarizeCalibration({
      pairs: 1,
      results: [],
      preflight: [missingEnvironmentDiagnostic(['PGHOST'])],
    }),
};

const report = (slot, { kind = 'pass', commit = COMMIT, topology } = {}) =>
  formatCalibrationReport({
    meta: {
      commit,
      generatedAt: `2026-09-21T01:00:${String(slot % 60).padStart(2, '0')}.000Z`,
      campaignSlot: slot,
    },
    topology: topology ?? (kind === 'refused' ? { measured: 'no' } : TOPOLOGY),
    summary: SUMMARY[kind](),
  });

/** Slots 1..59, each a passing report unless overridden (null drops the slot). */
const campaign = (overrides = {}) => {
  const texts = [];
  for (let slot = 1; slot <= CAMPAIGN_SLOT_COUNT; slot += 1) {
    const over = overrides[slot];
    if (over === null) continue;
    texts.push(typeof over === 'string' ? over : report(slot, over));
  }
  return texts;
};

// ---------------------------------------------------------------------------
// Synthetic manifests

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
const manifestText = (over = {}) => `${JSON.stringify({ ...MANIFEST, ...over }, null, 2)}\n`;

const review = (texts, { manifest = manifestText(), now = NOW, account } = {}) =>
  reviewImageCohort(
    { manifest: { text: manifest }, reports: texts.map((text) => ({ text })), now },
    account ? { account } : {},
  );

const isBranchC = (result) =>
  result.decision === COHORT_DECISION.branchC &&
  result.exitCode === 1 &&
  /^COHORT: BRANCH C$/m.test(formatCohortReview(result)) &&
  !/^COHORT: CONSISTENT$/m.test(formatCohortReview(result));

const isConsistent = (result) =>
  result.decision === COHORT_DECISION.consistent &&
  result.exitCode === 0 &&
  /^COHORT: CONSISTENT$/m.test(formatCohortReview(result)) &&
  !/BRANCH C$/m.test(formatCohortReview(result));

/** Every printed line is fixed text, counts or one digest — and bounded. */
const assertSafeOutput = (text, forbidden = []) => {
  const lines = text.split('\n');
  assert.equal(lines.at(-1), '', 'ends with one newline');
  assert.equal(lines.length, 11, 'fixed number of lines');
  for (const line of lines) assert.ok(line.length <= 320, 'every line is bounded');
  assert.equal((text.match(/^COHORT: /gm) ?? []).length, 1, 'exactly one decision line');
  for (const value of [COMMIT, OTHER_COMMIT, ...forbidden]) {
    assert.ok(!text.includes(value), 'no supplied value is echoed');
  }
  for (const value of Object.values(MANIFEST).filter((v) => typeof v === 'string')) {
    if (value === COHORT_MANIFEST_SCHEMA || value === 'ubuntu-24.04') continue;
    assert.ok(!text.includes(value), 'no manifest value is echoed');
  }
  assert.ok(!/ubuntu24\//.test(text), 'no image value is echoed');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), 'no timestamp is echoed');
  assert.ok(!/events=|non-events=|p-value=|threshold=/.test(text), 'no outcome is printed');
};

const problemsOf = (text, over) =>
  validateCohortManifest({ text: over === undefined ? text : manifestText(over) }, { now: NOW })
    .problems;

// ---------------------------------------------------------------------------
// The consistent cohort

test('cohort: the fixture topology is exactly the committed induced artifact line', () => {
  const committed = readFileSync(
    join(repoRoot, 'docs/evidence/adr-055/induced-calibration-0015cpu-github-2026-09-16.txt'),
    'utf8',
  )
    .split('\n')
    .find((line) => line.startsWith('topology: '));
  assert.equal(report(1).split('\n')[3], committed);
  assert.deepEqual(Object.keys(DRIFT), Object.keys(TOPOLOGY));
});

test('cohort: a clean 59-slot single-topology cohort with an accepted snapshot is CONSISTENT', () => {
  const result = review(campaign());
  assert.ok(isConsistent(result));
  assert.deepEqual(result.snapshot, { accepted: true, problems: [] });
  assert.equal(result.cohort.reports, 59);
  assert.equal(result.cohort.resolvedSlots, 59);
  assert.equal(result.cohort.commits, 1);
  assert.equal(result.cohort.commitMatchesManifest, true);
  assert.equal(result.cohort.measuredTopologies, 1);
  assert.match(result.cohort.topologyDigest, /^[0-9a-f]{16}$/);
  const text = formatCohortReview(result);
  assertSafeOutput(text);
  assert.match(text, /^pre-launch snapshot: ACCEPTED$/m);
  assert.match(text, /selects an image family, not an image version/);
  assert.match(text, /cannot guarantee which image any job receives/);
  assert.match(text, /launch-readiness row 9 is not verified by this output/);
  assert.match(text, /^ {2}measured_topologies=1 \(sha256:[0-9a-f]{16}\)/m);

  // Events are data, not a cohort problem, and their count is not shown.
  const withEvents = review(campaign({ 4: { kind: 'event' }, 40: { kind: 'event' } }));
  assert.ok(isConsistent(withEvents));
  assert.equal(formatCohortReview(withEvents), text, 'events do not change the cohort output');
});

test('cohort: input order cannot change the result', () => {
  const clean = campaign();
  const drifted = campaign({ 17: { topology: { ...TOPOLOGY, kernel: DRIFT.kernel } } });
  for (const texts of [clean, drifted]) {
    const baseline = formatCohortReview(review(texts));
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 5; round += 1) {
      const shuffled = [...texts];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      assert.equal(formatCohortReview(review(shuffled)), baseline, `permutation ${round}`);
    }
    assert.equal(formatCohortReview(review([...texts].reverse())), baseline);
  }
});

// ---------------------------------------------------------------------------
// Topology drift

test('cohort: one runner-image roll-forward forces Branch C, with no majority taken', () => {
  const rolled = { ...TOPOLOGY, runner_image: DRIFT.runner_image };
  for (const driftedSlots of [[59], [1, 2, 3], Array.from({ length: 29 }, (_, i) => i + 1)]) {
    const overrides = Object.fromEntries(driftedSlots.map((slot) => [slot, { topology: rolled }]));
    const result = review(campaign(overrides));
    assert.ok(isBranchC(result), `${driftedSlots.length} drifted slot(s)`);
    assert.equal(result.cohort.measuredTopologies, 2);
    assert.equal(result.cohort.topologyDigest, null);
    assert.equal(result.cohort.resolvedSlots, 0, 'no side of the split is kept');
    assert.deepEqual(result.cohort.problems, [
      COHORT_PROBLEM.accounting,
      COHORT_PROBLEM.topologyCount,
    ]);
    assert.equal(result.snapshot.accepted, true, 'the snapshot was fine; the cohort was not');
    assertSafeOutput(formatCohortReview(result), [DRIFT.runner_image]);
  }
  // The whole campaign on the new image is one cohort: the snapshot does not pin a version.
  const allRolled = review(
    campaign(
      Object.fromEntries(Array.from({ length: 59 }, (_, i) => [i + 1, { topology: rolled }])),
    ),
  );
  assert.ok(isConsistent(allRolled));
});

test('cohort: drift in every other captured topology field forces Branch C', () => {
  for (const key of Object.keys(TOPOLOGY)) {
    const result = review(campaign({ 31: { topology: { ...TOPOLOGY, [key]: DRIFT[key] } } }));
    assert.ok(isBranchC(result), `${key} drift must force Branch C`);
    assert.equal(result.cohort.measuredTopologies, 2, key);
  }
  // Order of the captured fields is part of the line too.
  const [first, second, ...rest] = Object.entries(TOPOLOGY);
  const reordered = Object.fromEntries([second, first, ...rest]);
  assert.ok(isBranchC(review(campaign({ 8: { topology: reordered } }))));
  // So is a field that disappears or appears.
  const { docker_storage_driver: _dropped, ...fewer } = TOPOLOGY;
  assert.ok(isBranchC(review(campaign({ 9: { topology: fewer } }))));
  assert.ok(isBranchC(review(campaign({ 10: { topology: { ...TOPOLOGY, extra: 'x' } } }))));
});

/**
 * Mutation-style checks. Each mutant is an accounting that compares less than
 * the real one; the drift tests above must tell them apart from the real review.
 */
test('cohort: a comparison blind to any one field, or a majority vote, would be caught', () => {
  const topologyLine = (topology) => report(1, { topology }).split('\n')[3];
  const withTopologyLine = (text, line) => {
    const lines = text.split('\n');
    lines[3] = line;
    return lines.join('\n');
  };

  for (const key of Object.keys(TOPOLOGY)) {
    const drifted = { ...TOPOLOGY, [key]: DRIFT[key] };
    const driftedLine = topologyLine(drifted);
    const baseLine = topologyLine(TOPOLOGY);
    // Mutant: the field is dropped from comparison (every value compares equal).
    const blind = (inputs) =>
      accountCampaign(
        inputs.map(({ text }) => ({
          text: text.split('\n')[3] === driftedLine ? withTopologyLine(text, baseLine) : text,
        })),
      );
    const texts = campaign({ 44: { topology: drifted } });
    assert.ok(isBranchC(review(texts)), `real review catches ${key}`);
    assert.ok(isConsistent(review(texts, { account: blind })), `mutant blind to ${key} differs`);
  }

  // Mutant: the most common topology wins and the minority is rewritten to it.
  const majority = (inputs) => {
    const lines = inputs.map(({ text }) => text.split('\n')[3]);
    const counts = new Map();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    const winner = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    return accountCampaign(inputs.map(({ text }) => ({ text: withTopologyLine(text, winner) })));
  };
  const split = campaign({
    5: { topology: { ...TOPOLOGY, runner_image: DRIFT.runner_image } },
    6: { topology: { ...TOPOLOGY, runner_image: DRIFT.runner_image } },
  });
  assert.ok(isBranchC(review(split)));
  assert.ok(isConsistent(review(split, { account: majority })), 'majority mutant differs');

  // A decision that trusted "complete" alone would pass these impossible accountings.
  const complete = accountCampaign(campaign().map((text) => ({ text })));
  for (const topologyDigests of [[], ['0'.repeat(16), '1'.repeat(16)]]) {
    const forged = () => ({ ...complete, provenance: { ...complete.provenance, topologyDigests } });
    assert.ok(isBranchC(review(campaign(), { account: forged })), `${topologyDigests.length}`);
  }
  for (const commits of [[], [COMMIT, OTHER_COMMIT], [OTHER_COMMIT]]) {
    const forged = () => ({ ...complete, provenance: { ...complete.provenance, commits } });
    assert.ok(isBranchC(review(campaign(), { account: forged })), `${commits.length} commit(s)`);
  }
});

// ---------------------------------------------------------------------------
// Commit, blockers, missing and malformed reports

test('cohort: a commit that differs from the manifest, or across reports, forces Branch C', () => {
  const mismatch = review(campaign(), {
    manifest: manifestText({ campaign_commit: OTHER_COMMIT }),
  });
  assert.ok(isBranchC(mismatch));
  assert.equal(mismatch.cohort.accountingComplete, true);
  assert.deepEqual(mismatch.cohort.problems, [COHORT_PROBLEM.commitMismatch]);
  assert.equal(mismatch.cohort.commitMatchesManifest, false);
  assertSafeOutput(formatCohortReview(mismatch));
  assert.match(formatCohortReview(mismatch), /manifest_commit_match=no/);

  const mixed = review(campaign({ 12: { commit: OTHER_COMMIT } }));
  assert.ok(isBranchC(mixed));
  assert.deepEqual(mixed.cohort.problems, [COHORT_PROBLEM.accounting, COHORT_PROBLEM.commitCount]);
  assertSafeOutput(formatCohortReview(mixed));
});

test('cohort: refused or unmeasured topology, blockers, missing, duplicate or malformed reports force Branch C', () => {
  const cases = {
    'refused slot': campaign({ 3: { kind: 'refused' } }),
    'topology capture error': campaign({ 3: { topology: { error: 'timeout' } } }),
    'product blocker': campaign({ 3: { kind: 'product' } }),
    'missing slot': campaign({ 3: null }),
    'duplicate slot': campaign({ 3: report(4) }),
    'byte-identical extra copy': [...campaign(), report(9)],
    'malformed report': campaign({ 3: report(3).slice(0, 500) }),
    'report without a slot': campaign({ 3: report(3).replace('campaign_slot=3\n', '') }),
    'foreign 60th input': [...campaign(), 'not a report\n'],
    'no reports at all': [],
  };
  for (const [name, texts] of Object.entries(cases)) {
    const result = review(texts);
    assert.ok(isBranchC(result), name);
    assert.equal(result.cohort.accountingComplete, false, name);
    assert.ok(result.cohort.problems.includes(COHORT_PROBLEM.accounting), name);
    assertSafeOutput(formatCohortReview(result));
  }
  // A campaign refused everywhere measured no topology at all.
  const allRefused = review(
    campaign(
      Object.fromEntries(Array.from({ length: 59 }, (_, i) => [i + 1, { kind: 'refused' }])),
    ),
  );
  assert.ok(isBranchC(allRefused));
  assert.equal(allRefused.cohort.measuredTopologies, 0);
  assert.ok(allRefused.cohort.problems.includes(COHORT_PROBLEM.topologyCount));

  const unreadable = reviewImageCohort({
    manifest: { text: manifestText() },
    reports: [...campaign({ 3: null }).map((text) => ({ text })), { unreadable: true }],
    now: NOW,
  });
  assert.ok(isBranchC(unreadable));
  assert.equal(unreadable.cohort.rejectedInputs, 1);
});

// ---------------------------------------------------------------------------
// The manifest

test('manifest: the synthetic snapshot is accepted and its field list is exactly the contract', () => {
  assert.deepEqual(Object.keys(MANIFEST), [...COHORT_MANIFEST_FIELDS]);
  assert.deepEqual(problemsOf(manifestText()), []);
  // Compact and whitespace-heavy spellings of the same object are the same manifest.
  assert.deepEqual(problemsOf(JSON.stringify(MANIFEST)), []);
  assert.deepEqual(problemsOf(`\r\n\t${JSON.stringify(MANIFEST, null, '\t')}\r\n`), []);
  // An escaped spelling of a known field name is still that field.
  assert.deepEqual(problemsOf(manifestText().replace('"schema"', '"\\u0073chema"')), []);
});

test('manifest: invalid JSON, duplicate, unknown, missing or mistyped fields are rejected', () => {
  const full = manifestText();
  const cases = [
    [MANIFEST_PROBLEM.syntax, ''],
    [MANIFEST_PROBLEM.syntax, 'null'],
    [MANIFEST_PROBLEM.syntax, `[${JSON.stringify(MANIFEST)}]`],
    [MANIFEST_PROBLEM.syntax, `${BOM}${full}`],
    [MANIFEST_PROBLEM.syntax, full.replace(/\n}\n$/, ',\n}\n')],
    [MANIFEST_PROBLEM.syntax, `${full}{}`],
    [MANIFEST_PROBLEM.syntax, `// note\n${full}`],
    [MANIFEST_PROBLEM.syntax, full.replace('"schema"', "'schema'")],
    [MANIFEST_PROBLEM.syntax, full.replace('true', 'TRUE')],
    [MANIFEST_PROBLEM.syntax, full.replace('true', '1')],
    [MANIFEST_PROBLEM.syntax, full.replace('true', 'null')],
    [MANIFEST_PROBLEM.syntax, manifestText({ runner_label: { name: 'ubuntu-24.04' } })],
    [MANIFEST_PROBLEM.syntax, manifestText({ campaign_commit: [COMMIT] })],
    [MANIFEST_PROBLEM.syntax, full.replace('ubuntu-24.04', 'ubuntu-24.04\\x')],
    [MANIFEST_PROBLEM.syntax, full.replace('ubuntu-24.04', 'ubuntu-24.04\t')],
    [MANIFEST_PROBLEM.duplicate, full.replace('{\n', `{\n  "campaign_commit": "${COMMIT}",\n`)],
    [MANIFEST_PROBLEM.duplicate, full.replace('{\n', '{\n  "\\u0073chema": "x",\n')],
    [MANIFEST_PROBLEM.unknown, manifestText({ run_url: 'https://example.invalid/secret' })],
    [MANIFEST_PROBLEM.missing, JSON.stringify({ ...MANIFEST, previous_image_release: undefined })],
    [MANIFEST_PROBLEM.missing, '{}'],
    [MANIFEST_PROBLEM.type, manifestText({ branch_c_on_topology_mismatch_acknowledged: 'true' })],
    [MANIFEST_PROBLEM.type, manifestText({ schema: false })],
  ];
  for (const [problem, text] of cases) {
    const problems = problemsOf(text);
    assert.ok(problems.includes(problem), `${problem}: got ${problems.join(' | ')}`);
    assert.ok(problems.every((p) => Object.values(MANIFEST_PROBLEM).includes(p)));
    const result = reviewImageCohort({
      manifest: { text },
      reports: campaign().map((t) => ({ text: t })),
      now: NOW,
    });
    assert.ok(isBranchC(result), problem);
    assert.equal(result.snapshot.accepted, false);
    assert.equal(result.cohort.commitMatchesManifest, false);
    assertSafeOutput(formatCohortReview(result), ['run_url', 'example.invalid', 'secret']);
  }
  // A structural problem rejects before any value check, so nothing else is reported.
  assert.deepEqual(
    problemsOf(manifestText({ extra: 'x', schema: 'wrong', campaign_commit: 'short' })),
    [MANIFEST_PROBLEM.unknown],
  );

  assert.deepEqual(validateCohortManifest({ unreadable: true }).problems, [
    MANIFEST_PROBLEM.unreadable,
  ]);
  assert.deepEqual(validateCohortManifest(undefined).problems, [MANIFEST_PROBLEM.unreadable]);
  assert.deepEqual(validateCohortManifest({ oversized: true }).problems, [
    MANIFEST_PROBLEM.tooLarge,
  ]);
  const padded = full.replace('{\n', `{${' '.repeat(MAX_MANIFEST_BYTES)}\n`);
  assert.deepEqual(problemsOf(padded), [MANIFEST_PROBLEM.tooLarge]);
});

test('manifest: values, UTC form, chronology and review time are checked fail-closed', () => {
  const cases = [
    [MANIFEST_PROBLEM.schema, { schema: 'adr-055-image-cohort-review/v2' }],
    [MANIFEST_PROBLEM.runnerLabel, { runner_label: 'ubuntu-latest' }],
    [MANIFEST_PROBLEM.runnerLabel, { runner_label: 'Ubuntu-24.04' }],
    [MANIFEST_PROBLEM.observedAt, { observed_at: '2026-09-20T08:00:00+00:00' }],
    [MANIFEST_PROBLEM.observedAt, { observed_at: '2026-09-20T08:00:00.000Z' }],
    [MANIFEST_PROBLEM.observedAt, { observed_at: '2026-09-20T08:00:00z' }],
    [MANIFEST_PROBLEM.observedAt, { observed_at: '2026-09-20 08:00:00Z' }],
    [MANIFEST_PROBLEM.observedAt, { observed_at: '2026-02-30T08:00:00Z' }],
    [MANIFEST_PROBLEM.observedAt, { observed_at: '2026-09-20T24:00:00Z' }],
    [MANIFEST_PROBLEM.observedAt, { observed_at: '2026-09-20T08:00:60Z' }],
    [MANIFEST_PROBLEM.observedAt, { observed_at: '0099-09-20T08:00:00Z' }],
    [MANIFEST_PROBLEM.observedFuture, { observed_at: '2026-09-22T12:00:01Z' }],
    [MANIFEST_PROBLEM.currentPublished, { current_image_published_at: '2026-09-15' }],
    [MANIFEST_PROBLEM.previousPublished, { previous_image_published_at: '1757323493' }],
    [MANIFEST_PROBLEM.currentRelease, { current_image_release: 'ubuntu24/latest' }],
    [MANIFEST_PROBLEM.currentRelease, { current_image_release: 'ubuntu22/20260914.310' }],
    [MANIFEST_PROBLEM.currentRelease, { current_image_release: 'ubuntu24/20260914.310 ' }],
    [MANIFEST_PROBLEM.previousRelease, { previous_image_release: 'ubuntu24/20260907.300.1\n' }],
    [MANIFEST_PROBLEM.sameRelease, { previous_image_release: MANIFEST.current_image_release }],
    [MANIFEST_PROBLEM.releaseOrder, { previous_image_published_at: '2026-09-15T09:00:00Z' }],
    [MANIFEST_PROBLEM.releaseOrder, { previous_image_published_at: '2026-09-16T09:00:00Z' }],
    [
      MANIFEST_PROBLEM.publishedAfterObservation,
      { current_image_published_at: '2026-09-20T08:00:01Z' },
    ],
    [MANIFEST_PROBLEM.acknowledgment, { branch_c_on_topology_mismatch_acknowledged: false }],
    [MANIFEST_PROBLEM.commit, { campaign_commit: COMMIT.slice(0, 7) }],
    [MANIFEST_PROBLEM.commit, { campaign_commit: COMMIT.toUpperCase() }],
  ];
  for (const [problem, over] of cases) {
    const problems = problemsOf(undefined, over);
    assert.ok(problems.includes(problem), `${problem}: got ${problems.join(' | ')}`);
    const result = review(campaign(), { manifest: manifestText(over) });
    assert.ok(isBranchC(result), problem);
    assertSafeOutput(formatCohortReview(result), Object.values(over).map(String));
  }
  // Boundaries that are allowed: observation at the review time, publication at the observation.
  assert.deepEqual(problemsOf(undefined, { observed_at: '2026-09-22T12:00:00Z' }), []);
  assert.deepEqual(problemsOf(undefined, { current_image_published_at: MANIFEST.observed_at }), []);
  // The validated commit is handed on only from an accepted snapshot.
  assert.equal(validateCohortManifest({ text: manifestText() }, { now: NOW }).commit, COMMIT);
  const refusedAck = manifestText({ branch_c_on_topology_mismatch_acknowledged: false });
  assert.equal(validateCohortManifest({ text: refusedAck }, { now: NOW }).commit, null);
  // Without a review time the observation cannot be placed before it.
  assert.deepEqual(validateCohortManifest({ text: manifestText() }).problems, [
    MANIFEST_PROBLEM.observedFuture,
  ]);
  assert.deepEqual(
    validateCohortManifest({ text: manifestText() }, { now: new Date(Number.NaN) }).problems,
    [MANIFEST_PROBLEM.observedFuture],
  );
  // Problems come back in the fixed order, however many there are.
  const many = problemsOf(undefined, {
    campaign_commit: 'x',
    branch_c_on_topology_mismatch_acknowledged: false,
    schema: 'x',
    observed_at: 'x',
  });
  assert.deepEqual(many, [
    MANIFEST_PROBLEM.schema,
    MANIFEST_PROBLEM.observedAt,
    MANIFEST_PROBLEM.acknowledgment,
    MANIFEST_PROBLEM.commit,
  ]);
});

test('manifest: an absent Branch C acknowledgment forces Branch C even for a clean cohort', () => {
  const { branch_c_on_topology_mismatch_acknowledged: _ack, ...withoutAck } = MANIFEST;
  for (const text of [
    manifestText({ branch_c_on_topology_mismatch_acknowledged: false }),
    JSON.stringify(withoutAck),
  ]) {
    const result = review(campaign(), { manifest: text });
    assert.ok(isBranchC(result));
    assert.equal(result.cohort.accountingComplete, true);
    assert.equal(result.cohort.measuredTopologies, 1);
    assert.match(formatCohortReview(result), /^pre-launch snapshot: REJECTED$/m);
  }
});

test('cohort: diagnostics are deterministic, bounded and carry no supplied content', () => {
  const secret = 'ghp_' + 'Z'.repeat(36);
  const hostile = [
    manifestText({ [secret]: secret }),
    manifestText({ campaign_commit: secret }),
    manifestText({ current_image_release: `ubuntu24/${secret}` }),
    `{"schema": "${secret}", "schema": "${secret}"}`,
    `${'{'.repeat(64)}${secret}`,
  ];
  for (const text of hostile) {
    const first = formatCohortReview(review(campaign({ 2: null }), { manifest: text }));
    const second = formatCohortReview(review(campaign({ 2: null }), { manifest: text }));
    assert.equal(first, second);
    assertSafeOutput(first, [secret, 'ghp_']);
  }
  // The combined worst case still has the fixed shape.
  const worst = review([...campaign({ 3: { commit: OTHER_COMMIT } }), 'junk'], {
    manifest: manifestText({ schema: 'x', observed_at: 'x', campaign_commit: 'x' }),
  });
  assertSafeOutput(formatCohortReview(worst));
});

// ---------------------------------------------------------------------------
// The entry point

test('cohort CLI: usage errors exit 2 and read nothing', () => {
  const read = [];
  const io = {
    sizeOf: (path) => {
      read.push(path);
      return 10;
    },
    readText: (path) => {
      read.push(path);
      return '';
    },
    now: NOW,
  };
  for (const argv of [
    [],
    ['--'],
    ['manifest.json'],
    ['--', 'manifest.json'],
    ['--manifest', 'm.json', 'r.txt'],
    ['m.json', '-', 'r.txt'],
    ['m.json', ...Array.from({ length: MAX_REPORT_PATHS + 1 }, (_, i) => `r${i}.txt`)],
  ]) {
    const result = runImageCohortCli({ argv, ...io });
    assert.equal(result.exitCode, 2, JSON.stringify(argv.slice(0, 3)));
    assert.match(result.output, /^usage: /m);
    assert.ok(!result.output.includes('m.json') && !result.output.includes('manifest.json'));
  }
  assert.deepEqual(read, [], 'a usage error reads no file');
  assert.equal(MAX_REPORT_BYTES, 32 * 1024);
});

test('cohort CLI: explicit files in, one decision out, nothing written or named', () => {
  const dir = tempDir();
  const write = (name, text) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const manifest = write('launch-snapshot.json', manifestText());
  // File names deliberately disagree with content: content wins.
  const paths = campaign().map((text, index) => write(`slot-${59 - index}.txt`, text));
  const before = readdirSync(dir).sort();

  const ok = runImageCohortCli({ argv: ['--', manifest, ...paths], now: NOW });
  assert.equal(ok.exitCode, 0);
  assert.match(ok.output, /^COHORT: CONSISTENT$/m);
  assert.ok(!ok.output.includes(dir) && !ok.output.includes('slot-'));
  assertSafeOutput(ok.output);

  // An unreadable manifest or report is counted, not named.
  const noManifest = runImageCohortCli({
    argv: [join(dir, 'absent.json'), ...paths],
    now: NOW,
  });
  assert.equal(noManifest.exitCode, 1);
  assert.match(noManifest.output, /snapshot problems: manifest could not be read$/m);
  assert.ok(!noManifest.output.includes('absent'));
  const noReport = runImageCohortCli({
    argv: [manifest, ...paths.slice(1), join(dir, 'absent.txt')],
    now: NOW,
  });
  assert.equal(noReport.exitCode, 1);
  assert.match(noReport.output, /rejected_inputs=1/);
  assert.match(noReport.output, /^COHORT: BRANCH C$/m);

  // Oversized files are never read.
  const reads = [];
  const oversized = runImageCohortCli({
    argv: [manifest, ...paths],
    now: NOW,
    sizeOf: (path) => (path === manifest || path === paths[0] ? 10 ** 9 : 100),
    readText: (path) => {
      reads.push(path);
      return readFileSync(path, 'utf8');
    },
  });
  assert.equal(oversized.exitCode, 1);
  assert.match(oversized.output, /manifest exceeds the byte limit/);
  assert.match(oversized.output, /rejected_inputs=1/);
  assert.ok(!reads.includes(manifest) && !reads.includes(paths[0]));

  // A read that fails after a successful size check is unreadable, not fatal.
  const flaky = runImageCohortCli({
    argv: [manifest, ...paths],
    now: NOW,
    readText: () => {
      throw new Error(`EACCES: ${dir}`);
    },
  });
  assert.equal(flaky.exitCode, 1);
  assert.ok(!flaky.output.includes(dir) && !flaky.output.includes('EACCES'));

  // The real entry point, as a process: its exit status is the decision.
  const run = (args) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
  // A spawned process reads the real clock, so its synthetic snapshot is safely in the past.
  const pastManifest = write(
    'past-snapshot.json',
    manifestText({
      observed_at: '2026-01-15T00:00:00Z',
      current_image_release: 'ubuntu24/20260112.100',
      current_image_published_at: '2026-01-13T00:00:00Z',
      previous_image_release: 'ubuntu24/20260105.90',
      previous_image_published_at: '2026-01-06T00:00:00Z',
    }),
  );
  const consistent = run([pastManifest, ...paths]);
  assert.equal(consistent.status, 0, consistent.stderr);
  assert.match(consistent.stdout, /^COHORT: CONSISTENT$/m);
  assert.equal(consistent.stderr, '');
  const drift = write(
    'slot-drift.txt',
    report(1, { topology: { ...TOPOLOGY, runner_image: DRIFT.runner_image } }),
  );
  const branchC = run([pastManifest, drift, ...paths.slice(1)]);
  assert.equal(branchC.status, 1);
  assert.match(branchC.stdout, /^COHORT: BRANCH C$/m);
  assert.equal(run([]).status, 2);
  assert.equal(run(['--', manifest]).status, 2);
  assert.equal(run(['--json', manifest, ...paths]).status, 2);

  assert.deepEqual(
    readdirSync(dir).sort(),
    [...before, 'past-snapshot.json', 'slot-drift.txt'].sort(),
    'the review writes nothing',
  );
});

// ---------------------------------------------------------------------------
// Report-path manifests: a second way to name the 59 reports, distinct from the JSON review manifest

const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const DEL = String.fromCharCode(127);
const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);
const manifestOf = (lines) => Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8');

const shuffled = (items, seed = 11) => {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const RUN_DIR = '/runs/campaign';
const LIST_PATH = `${RUN_DIR}/list.txt`;
const REVIEW_PATH = '/runs/launch/snapshot.json';
const CALLER = '/work/elsewhere';
const LIST_ARGV = Object.freeze([
  '--',
  REVIEW_PATH,
  '--reports-manifest',
  '../../runs/campaign/list.txt',
]);
/** Long relative report names; a name never matches the slot inside its report. */
const NAMES = Array.from(
  { length: CAMPAIGN_SLOT_COUNT },
  (_, index) =>
    `reports/secret-${'long-directory-segment-'.repeat(4)}/report-${String(58 - index).padStart(3, '0')}.txt`,
);

/**
 * A fake file system: the JSON review manifest at `REVIEW_PATH`, `texts[i]` at
 * `RUN_DIR/NAMES[i]`, and one report-path manifest listing `lines`. Every size
 * check and read is recorded under its kind.
 */
function cohortFs(texts, options = {}) {
  const {
    lines = NAMES,
    list = manifestOf(lines),
    review = manifestText(),
    extraFiles = [],
    errors = new Set(),
    platform = 'linux',
    cwd = CALLER,
    listPath = LIST_PATH,
  } = options;
  const files = new Map([
    [REVIEW_PATH, review],
    ...texts.map((text, index) => [`${RUN_DIR}/${NAMES[index]}`, text]),
    ...extraFiles,
  ]);
  const calls = [];
  const missing = (path) => {
    throw new Error(`ENOENT secret ${path}`);
  };
  const kindOf = (path) => (path === REVIEW_PATH ? 'review' : 'report');
  return {
    calls,
    paths: texts.map((_, index) => `${RUN_DIR}/${NAMES[index]}`),
    kinds: () => calls.map(([kind]) => kind),
    reviewOrReportAccess: () => calls.filter(([kind]) => !kind.startsWith('list')),
    options: {
      platform,
      cwd,
      now: NOW,
      sizeOf: (path) => {
        calls.push([`${kindOf(path)}-size`, path]);
        if (errors.has(path) || !files.has(path)) missing(path);
        if (path === REVIEW_PATH && Object.hasOwn(options, 'reviewSize')) {
          return options.reviewSize;
        }
        return Buffer.byteLength(files.get(path));
      },
      readText: (path) => {
        calls.push([`${kindOf(path)}-read`, path]);
        if (errors.has(path) || !files.has(path)) missing(path);
        return files.get(path);
      },
      reportsManifestSizeOf: (path) => {
        calls.push(['list-size', path]);
        if (errors.has(path) || path !== listPath) missing(path);
        return Object.hasOwn(options, 'listSize') ? options.listSize : list.length;
      },
      readReportsManifestBytes: (path) => {
        calls.push(['list-read', path]);
        if (errors.has(path) || path !== listPath) missing(path);
        return Buffer.from(list);
      },
    },
  };
}

const runCohortFs = (fs, argv = LIST_ARGV) => runImageCohortCli({ argv, ...fs.options });

/** Exit 2, one fixed reason plus the usage line, nothing else read and nothing supplied echoed. */
const assertCohortUsage = (result, reason, fs, label) => {
  assert.equal(result.exitCode, 2, label);
  const lines = result.output.split('\n');
  assert.equal(lines.length, 3, label);
  assert.equal(lines[0], reason, label);
  assert.match(lines[1], /^usage: node scripts\/aggregation-campaign-image-cohort\.mjs /, label);
  assert.deepEqual(fs.reviewOrReportAccess(), [], `${label}: neither manifest nor report is read`);
  assert.ok(
    !/secret|runs|work|list\.txt|snapshot|ENOENT|reports\/|\\|é/i.test(result.output),
    `${label}: nothing supplied is echoed`,
  );
};

test('cohort CLI manifest: the JSON review manifest stays first and distinct; listed reports give exactly the explicit decision', () => {
  const texts = campaign();
  const explicitFs = cohortFs(texts);
  const explicit = runImageCohortCli({
    argv: [REVIEW_PATH, ...explicitFs.paths],
    ...explicitFs.options,
  });
  assert.ok(isConsistent(review(texts)));
  assert.equal(explicit.output, formatCohortReview(review(texts)));

  const fs = cohortFs(texts, { lines: shuffled(NAMES, 9) });
  const viaList = runCohortFs(fs);
  assert.equal(viaList.exitCode, 0);
  assert.equal(viaList.output, explicit.output);
  assertSafeOutput(viaList.output, ['secret', '/runs/', 'list.txt']);
  // The report-path manifest first, then the review manifest and the reports exactly as before.
  assert.deepEqual(fs.kinds().slice(0, 4), [
    'list-size',
    'list-read',
    'review-size',
    'review-read',
  ]);
  assert.deepEqual(
    fs.kinds().slice(4),
    Array.from({ length: CAMPAIGN_SLOT_COUNT }, () => ['report-size', 'report-read']).flat(),
  );

  // Unchanged Branch C results: drift, a snapshot the JSON validator rejects, an oversized
  // review manifest that is never read, an unreadable listed report.
  const drifted = campaign({ 3: { topology: { ...TOPOLOGY, runner_image: DRIFT.runner_image } } });
  const variants = [
    ['drift', drifted, {}],
    ['rejected snapshot', texts, { review: manifestText({ schema: 'x' }) }],
    ['oversized review manifest', texts, { reviewSize: MAX_MANIFEST_BYTES + 1 }],
    ['unreadable report', texts, { errors: new Set([`${RUN_DIR}/${NAMES[12]}`]) }],
  ];
  for (const [label, cohortTexts, over] of variants) {
    const listed = cohortFs(cohortTexts, { ...over, lines: shuffled(NAMES, 4) });
    const named = cohortFs(cohortTexts, over);
    const a = runCohortFs(listed);
    const b = runImageCohortCli({ argv: [REVIEW_PATH, ...named.paths], ...named.options });
    assert.equal(a.exitCode, 1, label);
    assert.match(a.output, /^COHORT: BRANCH C$/m, label);
    assert.equal(a.output, b.output, label);
    assertSafeOutput(a.output, ['secret', '/runs/', 'list.txt']);
    if (label === 'oversized review manifest') {
      assert.match(a.output, /manifest exceeds the byte limit/);
      assert.ok(!listed.kinds().includes('review-read'), 'the oversized review manifest is unread');
    }
  }

  // The two manifests are not interchangeable. A path list given as the review manifest is a
  // snapshot the JSON validator rejects (exit 1); a JSON snapshot given as the report-path
  // manifest breaks the path-list grammar (exit 2) before anything else is read.
  const swappedReview = cohortFs(texts, {
    extraFiles: [[LIST_PATH, manifestOf(NAMES).toString()]],
  });
  const listAsReview = runCohortFs(swappedReview, [LIST_PATH, '--reports-manifest', LIST_PATH]);
  assert.equal(listAsReview.exitCode, 1);
  assert.match(listAsReview.output, /^pre-launch snapshot: REJECTED$/m);
  assert.match(listAsReview.output, /^COHORT: BRANCH C$/m);
  const jsonAsList = cohortFs(texts, { list: Buffer.from(manifestText()), listPath: REVIEW_PATH });
  assertCohortUsage(
    runCohortFs(jsonAsList, [REVIEW_PATH, '--reports-manifest', REVIEW_PATH]),
    `reports manifest: ${REPORT_MANIFEST_PROBLEM.whitespace}`,
    jsonAsList,
    'JSON snapshot as a path list',
  );

  // Explicit, incomplete input keeps its Branch C result.
  const short = cohortFs(texts);
  const incomplete = runImageCohortCli({
    argv: [REVIEW_PATH, ...short.paths.slice(1)],
    ...short.options,
  });
  assert.equal(incomplete.exitCode, 1);
  assert.equal(incomplete.output, formatCohortReview(review(texts.slice(1))));
});

test('cohort CLI manifest: every report-path manifest failure exits 2 before the review manifest or any report is read', () => {
  const texts = campaign();
  const P = REPORT_MANIFEST_PROBLEM;
  const body = manifestOf(NAMES).toString('utf8');
  const withLine = (line, at = 30) => {
    const copy = [...NAMES];
    copy[at] = line;
    return manifestOf(copy);
  };
  const failures = [
    ['missing final LF', { list: Buffer.from(body.slice(0, -1)) }, P.finalNewline],
    ['CRLF', { list: Buffer.from(body.replaceAll('\n', `${CR}\n`)) }, P.carriageReturn],
    ['BOM', { list: Buffer.concat([BOM_BYTES, manifestOf(NAMES)]) }, P.bom],
    [
      'invalid UTF-8',
      { list: Buffer.concat([manifestOf(NAMES.slice(1)), Buffer.from([0xc3, 0x0a])]) },
      P.notUtf8,
    ],
    ['NUL', { list: withLine(`secret${NUL}.txt`) }, P.control],
    ['tab', { list: withLine(`secret${TAB}.txt`) }, P.control],
    ['DEL', { list: withLine(`secret${DEL}`) }, P.control],
    ['blank line', { list: withLine('') }, P.blankLine],
    ['padded line', { list: withLine(' secret.txt') }, P.whitespace],
    ['option-like', { list: withLine('-secret') }, P.optionLike],
    ['comment', { list: withLine('#secret') }, P.notPlainPath],
    ['quoted', { list: withLine("'secret.txt'") }, P.notPlainPath],
    ['URL', { list: withLine('file:///secret.txt') }, P.notPlainPath],
    ['drive-relative', { list: withLine('D:secret.txt') }, P.notPlainPath],
    ['overlong entry', { list: withLine('é'.repeat(513)) }, P.entryTooLong],
    ['58 lines', { list: manifestOf(NAMES.slice(1)) }, P.lineCount],
    ['60 lines', { list: manifestOf([...NAMES, 'secret.txt']) }, P.lineCount],
    ['oversized', { listSize: MAX_REPORT_MANIFEST_BYTES + 1 }, P.tooLarge, true],
    ['unknown size', { listSize: Number.NaN }, P.tooLarge, true],
    ['no size', { listSize: undefined }, P.tooLarge, true],
    [
      'grown after the size check',
      { list: Buffer.alloc(MAX_REPORT_MANIFEST_BYTES + 1, 0x61), listSize: 10 },
      P.tooLarge,
    ],
    ['unreadable', { errors: new Set([LIST_PATH]) }, P.unreadable, true],
  ].map(([label, over, problem, unread]) => [label, over, `reports manifest: ${problem}`, unread]);
  failures.push(
    ['duplicate line', { lines: [...NAMES.slice(1), NAMES[5]] }, USAGE_ERROR.duplicatePath],
    [
      'duplicate after normalization',
      { lines: [...NAMES.slice(1), `../campaign/${NAMES[5]}`] },
      USAGE_ERROR.duplicatePath,
    ],
  );
  const winList = 'D:\\Runs\\List.txt';
  for (const variant of [
    'REPORTS\\A.TXT',
    'reports\\a.txt.',
    'reports. \\a.txt',
    'd:/runs/reports/a.txt',
  ]) {
    failures.push([
      `Windows ${variant}`,
      {
        lines: [...NAMES.slice(2), 'reports\\a.txt', variant],
        platform: 'win32',
        cwd: 'C:\\Work',
        listPath: winList,
        argv: ['C:\\Launch\\snapshot.json', '--reports-manifest', winList],
      },
      USAGE_ERROR.duplicatePath,
    ]);
  }
  for (const [label, over, reason, unread] of failures) {
    const fs = cohortFs(texts, over);
    assertCohortUsage(runCohortFs(fs, over.argv), reason, fs, label);
    if (unread) assert.ok(!fs.kinds().includes('list-read'), `${label}: path list unread`);
  }
});

test('cohort CLI: option errors and explicit-path tightening exit 2 before any file access', () => {
  const texts = campaign();
  const long = `secret${'s'.repeat(1019)}`;
  const cases = [
    ['no argument', [], USAGE_ERROR.noManifest],
    ['only a separator', ['--'], USAGE_ERROR.noManifest],
    ['no report', ['--', 'm.json'], USAGE_ERROR.noReport],
    [
      'option before the review manifest',
      ['--reports-manifest', 'list.txt'],
      USAGE_ERROR.optionBeforeManifest,
    ],
    [
      'option before the review manifest, then it',
      ['--', '--reports-manifest', 'list.txt', 'm.json'],
      USAGE_ERROR.optionBeforeManifest,
    ],
    [
      'mixed, reports first',
      ['m.json', 'r.txt', '--reports-manifest', 'list.txt'],
      USAGE_ERROR.mixedModes,
    ],
    [
      'mixed, manifest first',
      ['m.json', '--reports-manifest', 'list.txt', 'r.txt'],
      USAGE_ERROR.extraArgument,
    ],
    [
      'repeated',
      ['m.json', '--reports-manifest', 'list.txt', '--reports-manifest', 'list.txt'],
      USAGE_ERROR.repeatedOption,
    ],
    ['missing value', ['m.json', '--reports-manifest'], USAGE_ERROR.manifestValue],
    ['empty value', ['m.json', '--reports-manifest', ''], USAGE_ERROR.manifestValue],
    ['option-like value', ['m.json', '--reports-manifest', '--secret'], USAGE_ERROR.manifestValue],
    ['inline value', ['m.json', '--reports-manifest=secret.txt'], USAGE_ERROR.inlineValue],
    ['unknown option', ['m.json', '--reports', 'secret.txt'], USAGE_ERROR.unknownOption],
    [
      'extra option',
      ['m.json', '--reports-manifest', 'list.txt', '--json'],
      USAGE_ERROR.unknownOption,
    ],
    [
      'extra values',
      ['m.json', '--reports-manifest', 'list.txt', 'a.txt', 'b.txt'],
      USAGE_ERROR.extraArgument,
    ],
    ['late separator', ['m.json', '--', 'r.txt'], USAGE_ERROR.lateSeparator],
    [
      'late separator after the list',
      ['m.json', '--reports-manifest', 'list.txt', '--'],
      USAGE_ERROR.lateSeparator,
    ],
    ['overlong list path', ['m.json', '--reports-manifest', long], USAGE_ERROR.pathTooLong],
    ['overlong review manifest path', [long, 'r.txt'], USAGE_ERROR.pathTooLong],
    ['overlong report path', ['m.json', 'r.txt', long], USAGE_ERROR.pathTooLong],
    ['empty review manifest path', ['', 'r.txt'], USAGE_ERROR.emptyPath],
    ['empty report path', ['m.json', ''], USAGE_ERROR.emptyPath],
    [
      'too many reports',
      ['m.json', ...Array.from({ length: MAX_REPORT_PATHS + 1 }, (_, i) => `r${i}.txt`)],
      USAGE_ERROR.tooManyPaths,
    ],
    [
      'duplicate report',
      ['m.json', 'secret/r.txt', `${CALLER}/secret/x/../r.txt`],
      USAGE_ERROR.duplicatePath,
    ],
  ];
  const windows = { platform: 'win32', cwd: 'C:\\Work' };
  for (const [a, b] of [
    ['C:\\Runs\\R.txt', 'c:/runs/r.TXT'],
    ['C:\\runs\\r.txt', 'C:\\runs\\r.txt. .'],
    ['runs\\r.txt', 'C:\\WORK\\RUNS.\\r.txt'],
  ]) {
    cases.push([`Windows ${a} ~ ${b}`, ['m.json', a, b], USAGE_ERROR.duplicatePath, windows]);
  }
  for (const [label, argv, reason, over] of cases) {
    const fs = cohortFs(texts, over);
    assertCohortUsage(runCohortFs(fs, argv), reason, fs, label);
    assert.deepEqual(fs.calls, [], `${label}: no file access at all`);
  }

  // Inclusive bounds: the maximum report count and a 1024-byte path are still reviewed (Branch C).
  const many = cohortFs(texts);
  const atLimit = runCohortFs(many, [
    REVIEW_PATH,
    ...Array.from({ length: MAX_REPORT_PATHS }, (_, i) => `/absent/${i}.txt`),
  ]);
  assert.equal(atLimit.exitCode, 1);
  assert.match(atLimit.output, /^COHORT: BRANCH C$/m);
  const edge = cohortFs(texts);
  const atBound = runCohortFs(edge, [REVIEW_PATH, `/${'s'.repeat(1023)}`]);
  assert.equal(atBound.exitCode, 1);
  // POSIX case-only variants are different files.
  const posixCase = cohortFs(texts);
  assert.equal(runCohortFs(posixCase, [REVIEW_PATH, '/r/A.txt', '/r/a.txt']).exitCode, 1);
  assert.equal(posixCase.kinds().filter((kind) => kind === 'report-size').length, 2);
});

test('the cohort review stays manual and read-only, and shares the manifest contract rather than the comparator', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['review:aggregation-campaign-image-cohort'],
    'node scripts/aggregation-campaign-image-cohort.mjs',
  );
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name === 'review:aggregation-campaign-image-cohort') continue;
    assert.ok(!command.includes('aggregation-campaign-image-cohort'), name);
    assert.ok(!command.includes('review:aggregation-campaign-image-cohort'), name);
  }
  for (const file of [
    '.github/workflows/ci.yml',
    'scripts/run-test-phases.mjs',
    'scripts/test-phases-lib.mjs',
    'scripts/check-test-phases.mjs',
  ]) {
    const text = readFileSync(join(repoRoot, file), 'utf8');
    assert.ok(!text.includes('aggregation-campaign-image-cohort'), file);
    assert.ok(!text.includes('review:aggregation-campaign-image-cohort'), file);
    assert.ok(!text.includes('report-manifest'), file);
  }
  assert.deepEqual(readdirSync(join(repoRoot, '.github', 'workflows')), ['ci.yml']);

  const specifiers = (text) =>
    [...text.matchAll(/^(?:import .*|\}) from '([^']+)';$/gm)].map((m) => m[1]).sort();
  const cli = readFileSync(CLI, 'utf8');
  assert.deepEqual(specifiers(cli), [
    './aggregation-campaign-image-cohort-lib.mjs',
    './aggregation-campaign-log-recovery-lib.mjs',
    './aggregation-campaign-report-manifest-lib.mjs',
    'node:fs',
    'node:path',
    'node:url',
  ]);
  assert.match(cli, /^import \{ readFileSync, statSync \} from 'node:fs';$/m);
  assert.ok(!/writeFile|mkdir|rename|unlink|rmSync|readdir|opendir|globSync|fetch\(/.test(cli));
  // The JSON review manifest keeps its own bound and validator.
  assert.equal(MAX_MANIFEST_BYTES, 4 * 1024);
  assert.notEqual(MAX_MANIFEST_BYTES, MAX_REPORT_MANIFEST_BYTES);
});

test('cohort review (spawned package command): a report-path manifest carries 59 long paths; CONSISTENT, BRANCH C, exit 2; nothing written', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const [program, script, ...rest] =
    pkg.scripts['review:aggregation-campaign-image-cohort'].split(' ');
  assert.equal(program, 'node');
  assert.deepEqual(rest, []);
  const scriptPath = join(repoRoot, script);

  const root = mkdtempSync(join(tmpdir(), 'aggregation-campaign-image-cohort-manifest-test-'));
  temporaryDirs.push(root);
  assert.ok(!resolve(root).startsWith(repoRoot));
  const segment = `private-reports-${'long-directory-segment-'.repeat(5)}`.slice(0, 90);
  const reportDir = join(root, segment);
  const callerDir = join(root, 'caller');
  for (const dir of [reportDir, callerDir]) mkdirSync(dir);

  const texts = campaign();
  const names = texts.map((text, i) => {
    const name = `private-campaign-report-${String(58 - i).padStart(2, '0')}.txt`;
    writeFileSync(join(reportDir, name), text);
    return name;
  });
  const paths = names.map((name) => join(reportDir, name));
  for (const path of paths) assert.ok(path.length < 250, 'each path is under classic MAX_PATH');
  const individually = paths.reduce((total, path) => total + path.length + 3, 0);
  assert.ok(individually > 8191, 'passed one by one, the paths exceed the cmd.exe limit');

  // A spawned process reads the real clock, so its synthetic snapshot is safely in the past.
  const snapshotPath = join(root, 'private-snapshot.json');
  writeFileSync(
    snapshotPath,
    manifestText({
      observed_at: '2026-01-15T00:00:00Z',
      current_image_release: 'ubuntu24/20260112.100',
      current_image_published_at: '2026-01-13T00:00:00Z',
      previous_image_release: 'ubuntu24/20260105.90',
      previous_image_published_at: '2026-01-06T00:00:00Z',
    }),
  );
  const list = join(root, 'reports.manifest');
  const malformed = join(root, 'malformed.manifest');
  writeFileSync(list, manifestOf(shuffled(names, 13).map((name) => `${segment}/${name}`)));
  writeFileSync(
    malformed,
    manifestOf(
      [...names.slice(1), names[1]].map((name, i) => `${segment}/${i === 58 ? './' : ''}${name}`),
    ),
  );

  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return [[full, 'dir'], ...walk(full)];
      const stats = statSync(full);
      return [[full, stats.size, stats.mtimeMs, readFileSync(full).toString('base64')]];
    });
  const snapshot = () => walk(root).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const run = (args) => {
    const around = snapshot();
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf8',
      cwd: callerDir,
      timeout: 60_000,
    });
    assert.deepEqual(snapshot(), around, 'the run created, removed or changed nothing');
    assert.equal(result.stderr, '');
    return result;
  };
  const leaks = [
    root,
    'private',
    'long-directory',
    '.manifest',
    'snapshot.json',
    repoRoot,
    'caller',
  ];

  // Relative paths from a different working directory; relative lines from the list's directory.
  const consistent = run([
    '--',
    '../private-snapshot.json',
    '--reports-manifest',
    '../reports.manifest',
  ]);
  assert.equal(consistent.status, 0, consistent.stdout);
  assert.match(consistent.stdout, /^COHORT: CONSISTENT$/m);
  assertSafeOutput(consistent.stdout, leaks);

  // One drifted report is the unchanged domain result: Branch C, exit 1.
  const target = paths[33];
  const original = readFileSync(target);
  const slot = Number(/campaign_slot=(\d+)/.exec(original.toString('utf8'))[1]);
  writeFileSync(
    target,
    report(slot, { topology: { ...TOPOLOGY, runner_image: DRIFT.runner_image } }),
  );
  const branchC = run([snapshotPath, '--reports-manifest', list]);
  assert.equal(branchC.status, 1);
  assert.match(branchC.stdout, /^COHORT: BRANCH C$/m);
  assertSafeOutput(branchC.stdout, leaks);
  writeFileSync(target, original);

  // A path list with a repeated report is refused before anything else is read.
  const refused = run(['--', snapshotPath, '--reports-manifest', malformed]);
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout.split('\n')[0], USAGE_ERROR.duplicatePath);
  for (const leak of leaks) assert.ok(!refused.stdout.includes(leak));
  const crlf = join(callerDir, 'crlf-list');
  writeFileSync(crlf, Buffer.from(manifestOf(names).toString('utf8').replaceAll('\n', `${CR}\n`)));
  const grammar = run([snapshotPath, '--reports-manifest', 'crlf-list']);
  assert.equal(grammar.status, 2);
  assert.equal(
    grammar.stdout.split('\n')[0],
    `reports manifest: ${REPORT_MANIFEST_PROBLEM.carriageReturn}`,
  );
  for (const leak of leaks) assert.ok(!grammar.stdout.includes(leak));

  const restored = run([snapshotPath, '--reports-manifest', list]);
  assert.equal(restored.status, 0);
  assert.equal(restored.stdout, consistent.stdout);
});
