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
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  runImageCohortCli,
} from './aggregation-campaign-image-cohort.mjs';
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
