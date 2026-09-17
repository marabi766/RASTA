/**
 * Slot accounting for the preregistered 59-slot campaign.
 *
 * Every report here is rendered by the real `formatCalibrationReport` from
 * real summaries (`summarizeCalibration`, `summarizeJestRun`), so the parser is
 * held to what the harness actually writes rather than to a hand-typed copy.
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

import {
  CAMPAIGN_SLOT_COUNT,
  FAILURE_CATEGORY_NAMES,
  SLOT_STATE,
  accountCampaign,
  classifySlotReport,
  formatAccounting,
  parseSlotReport,
  readCampaignSlot,
} from './aggregation-campaign-accounting-lib.mjs';
import {
  MAX_REPORT_PATHS,
  USAGE_ERROR,
  runAccountingCli,
} from './aggregation-campaign-accounting.mjs';
import {
  MAX_REPORT_MANIFEST_BYTES,
  REPORT_MANIFEST_PROBLEM,
  REPORT_PATH_LIMITS,
  exceedsPathBytes,
  findPathCollision,
  loadReportManifest,
  reportPathKey,
} from './aggregation-campaign-report-manifest-lib.mjs';
import {
  FAILURE_CATEGORY_PARTITION,
  INFRASTRUCTURE_CATEGORY,
  LAUNCHER,
  PROCESS_OUTCOME,
  calibrationProbeId,
  calibrationStressId,
  classifyFailures,
  diagnostic,
  formatCalibrationReport,
  missingEnvironmentDiagnostic,
  sealProbeOutcome,
  summarizeCalibration,
  summarizeJestRun,
} from './aggregation-evidence-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const temporaryDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'aggregation-campaign-accounting-test-'));
  temporaryDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Synthetic reports, rendered by the real harness code

const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const TOPOLOGY = Object.freeze({
  runner_os: '"Ubuntu 24.04.5 LTS"',
  runner_image: 'ubuntu24/20260907.300.1',
  kernel: '6.17.0-1022-azure',
  cpus: 4,
  memory_gib: '15.6',
  postgres_image: 'postgis/postgis:16-3.4',
  server_version: '16.4',
});

const validProbe = () =>
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

const invalidProbe = () => {
  const entry = diagnostic(
    [INFRASTRUCTURE_CATEGORY.backgroundWalContamination],
    'wal_sync per transaction outside bounds',
  );
  return sealProbeOutcome({ ...validProbe(), problems: [entry.text], diagnostics: [entry] });
};

/** A jest `--json` report with the given failure messages (none = a pass). */
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

const START = new Date('2026-09-16T00:00:00.000Z');
const END = new Date('2026-09-16T00:02:15.000Z');
const WAL = { walSync: 100, walRecords: 200, walWrite: 100, walBytes: 1000 };

/** One stress step summarized by the real `summarizeJestRun`. */
const stressRun = ({ messages = [], outcome = PROCESS_OUTCOME.completed, report = true } = {}) =>
  summarizeJestRun({
    step: { id: calibrationStressId(1), kind: 'jest-full' },
    result: {
      launcher: LAUNCHER.pnpm,
      outcome,
      exitCode: outcome === PROCESS_OUTCOME.completed ? (messages.length === 0 ? 0 : 1) : null,
      startedAt: START,
      endedAt: END,
    },
    report: report ? jestReport(messages) : null,
    walBefore: WAL,
    walAfter: { ...WAL, walSync: 700 },
    samples: null,
  });

const ENV_57014 = 'error: canceling statement due to statement timeout';
const ENV_JEST = 'thrown: "Exceeded timeout of 120000 ms for a test.';
const PRODUCT = '    > 212 |       expect(rows).toHaveLength(1);';
const DATABASE = 'PrismaClientKnownRequestError: P2002 unique constraint';
const UNKNOWN = 'TypeError: something unexpected';

const controlStep = (probe = sealProbeOutcome({ problems: [], diagnostics: [] })) => ({
  id: 'control',
  passed: probe.valid,
  probe,
  diagnostics: probe.diagnostics,
});

/** The results of a one-pair campaign, shaped as `runPlan` returns them. */
const oneSlotResults = ({ control, probe = validProbe(), probeError, stress = stressRun() }) => {
  const results = [controlStep(control)];
  if (probeError) {
    results.push({
      id: calibrationProbeId(1),
      passed: false,
      error: probeError.text,
      diagnostics: [probeError],
    });
  } else if (probe) {
    results.push({
      id: calibrationProbeId(1),
      passed: probe.valid,
      probe,
      diagnostics: probe.diagnostics,
    });
  }
  if (stress) results.push(stress);
  return results;
};

const render = ({ slot, commit = COMMIT, topology = TOPOLOGY, summary }) =>
  formatCalibrationReport({
    meta: {
      commit,
      generatedAt: `2026-09-16T00:00:${String(slot % 60).padStart(2, '0')}.000Z`,
      campaignSlot: slot,
    },
    topology,
    summary,
  });

const KIND = Object.freeze({
  pass: () => summarizeCalibration({ pairs: 1, results: oneSlotResults({}) }),
  event57014: () =>
    summarizeCalibration({
      pairs: 1,
      results: oneSlotResults({ stress: stressRun({ messages: [ENV_57014] }) }),
    }),
  eventBoth: () =>
    summarizeCalibration({
      pairs: 1,
      results: oneSlotResults({ stress: stressRun({ messages: [ENV_57014, ENV_JEST] }) }),
    }),
  product: () =>
    summarizeCalibration({
      pairs: 1,
      results: oneSlotResults({ stress: stressRun({ messages: [PRODUCT] }) }),
    }),
  mixed: () =>
    summarizeCalibration({
      pairs: 1,
      results: oneSlotResults({ stress: stressRun({ messages: [ENV_57014, PRODUCT] }) }),
    }),
  unknown: () =>
    summarizeCalibration({
      pairs: 1,
      results: oneSlotResults({ stress: stressRun({ messages: [UNKNOWN] }) }),
    }),
  database: () =>
    summarizeCalibration({
      pairs: 1,
      results: oneSlotResults({ stress: stressRun({ messages: [DATABASE] }) }),
    }),
  invalid: () =>
    summarizeCalibration({ pairs: 1, results: oneSlotResults({ probe: invalidProbe() }) }),
  inconclusive: () =>
    summarizeCalibration({
      pairs: 1,
      results: oneSlotResults({
        probeError: diagnostic(
          [INFRASTRUCTURE_CATEGORY.connectionFailure],
          'psql could not reach the server',
        ),
      }),
    }),
  controlInvalid: () =>
    summarizeCalibration({ pairs: 1, results: oneSlotResults({ control: invalidProbe() }) }),
  notRun: () => summarizeCalibration({ pairs: 1, results: oneSlotResults({ stress: null }) }),
  ranNo: () =>
    summarizeCalibration({
      pairs: 1,
      results: oneSlotResults({
        stress: {
          id: calibrationStressId(1),
          passed: false,
          error: 'the step could not measure',
          diagnostics: [
            diagnostic([INFRASTRUCTURE_CATEGORY.harnessError], 'the step could not measure'),
          ],
        },
      }),
    }),
  timedOut: () =>
    summarizeCalibration({
      pairs: 1,
      results: oneSlotResults({
        stress: stressRun({ outcome: PROCESS_OUTCOME.timedOut, report: false }),
      }),
    }),
  refused: () =>
    summarizeCalibration({
      pairs: 1,
      results: [],
      preflight: [missingEnvironmentDiagnostic(['PGHOST'])],
    }),
});

const reportFor = (slot, kind = 'pass', over = {}) => {
  const topology = kind === 'refused' ? { measured: 'no' } : TOPOLOGY;
  return render({ slot, topology, summary: KIND[kind](), ...over });
};

/** Every slot 1..59 as a passing report, with per-slot overrides. */
const campaign = (overrides = {}) => {
  const texts = [];
  for (let slot = 1; slot <= CAMPAIGN_SLOT_COUNT; slot += 1) {
    const over = overrides[slot];
    if (over === null) continue;
    texts.push(
      typeof over === 'string' ? over : reportFor(slot, over?.kind ?? 'pass', over?.render),
    );
  }
  return texts;
};

const account = (texts) => accountCampaign(texts.map((text) => ({ text })));

/** Invariant assertions every accounting result must satisfy, whatever its inputs. */
const assertInvariant = (result) => {
  const { nonEvents, events, blockers, missing } = result.totals;
  assert.equal(nonEvents + events + blockers + missing, CAMPAIGN_SLOT_COUNT);
  assert.equal(result.slots.length, CAMPAIGN_SLOT_COUNT);
  assert.deepEqual(
    result.slots.map((entry) => entry.slot),
    Array.from({ length: CAMPAIGN_SLOT_COUNT }, (_, index) => index + 1),
  );
  for (const entry of result.slots) {
    assert.ok(
      Object.values(SLOT_STATE).includes(entry.state),
      `slot ${entry.slot} has a known state`,
    );
    assert.ok(
      entry.reason.length > 0 && entry.reason.length <= 120,
      `slot ${entry.slot} reason is bounded`,
    );
  }
  const text = formatAccounting(result);
  assert.match(
    text,
    new RegExp(
      `invariant: non-events \\+ events \\+ blockers \\+ missing = ${nonEvents} \\+ ${events} \\+ ${blockers} \\+ ${missing} = 59 \\(expected 59\\) holds`,
    ),
  );
  assert.equal(result.exitCode, result.complete ? 0 : 1);
};

const slotOf = (result, slot) => result.slots[slot - 1];

// ---------------------------------------------------------------------------
// Vocabulary

test('accounting: the failure partition is exactly the harness failure vocabulary', () => {
  assert.equal(CAMPAIGN_SLOT_COUNT, 59);
  const partitioned = [
    ...FAILURE_CATEGORY_PARTITION.environment,
    ...FAILURE_CATEGORY_PARTITION.productAssertion,
    ...FAILURE_CATEGORY_PARTITION.unclassified,
  ];
  assert.deepEqual([...partitioned].sort(), [...FAILURE_CATEGORY_NAMES].sort());
  assert.equal(new Set(partitioned).size, partitioned.length, 'no category sits in two groups');
  assert.deepEqual(Object.keys(classifyFailures([])), FAILURE_CATEGORY_NAMES);
  // The messages used below classify the way the tests rely on.
  assert.equal(classifyFailures([ENV_57014]).sqlstate57014, 1);
  assert.equal(classifyFailures([ENV_JEST]).jestTimeout, 1);
  assert.equal(classifyFailures([PRODUCT]).secondRowOrWindowCrossing, 1);
  assert.equal(classifyFailures([DATABASE]).otherDatabaseError, 1);
  assert.equal(classifyFailures([UNKNOWN]).other, 1);
});

// ---------------------------------------------------------------------------
// One report

test('accounting: real rendered reports parse, and the slot is read from content', () => {
  for (const kind of Object.keys(KIND)) {
    const parsed = parseSlotReport(reportFor(17, kind));
    assert.ok(parsed.ok, `${kind} must parse: ${parsed.reason}`);
    assert.equal(parsed.report.slot, 17);
    assert.equal(parsed.report.commit, COMMIT);
  }
  assert.deepEqual(readCampaignSlot(reportFor(1)), { slot: 1 });
  assert.deepEqual(readCampaignSlot(reportFor(59)), { slot: 59 });
});

test('accounting: § 5.2 classification — non-event, environment-only event, and every blocker', () => {
  const state = (kind) => classifySlotReport(parseSlotReport(reportFor(3, kind)).report);
  assert.deepEqual(state('pass'), {
    state: SLOT_STATE.nonEvent,
    reason: 'VALID pair; unchanged suite passed',
  });
  assert.equal(state('event57014').state, SLOT_STATE.event);
  assert.match(state('event57014').reason, /sqlstate57014=1 jestTimeout=0/);
  assert.equal(state('eventBoth').state, SLOT_STATE.event);

  const blockers = {
    product: /product-assertion failure/,
    mixed: /mixed product and environment failure/,
    unknown: /unclassified failure category/,
    database: /unclassified failure category/,
    invalid: /pair INVALID/,
    inconclusive: /pair INCONCLUSIVE/,
    controlInvalid: /control INVALID/,
    notRun: /stress suite did not run/,
    ranNo: /stress suite did not run/,
    timedOut: /stress process bound exceeded/,
    refused: /campaign preflight refused/,
  };
  for (const [kind, reason] of Object.entries(blockers)) {
    const found = state(kind);
    assert.equal(found.state, SLOT_STATE.blocker, `${kind} must be a blocker, got ${found.state}`);
    assert.match(found.reason, reason, kind);
  }
});

test('accounting: an environment category never promotes an ineligible slot to an event', () => {
  // The same 57014 failure, but the pair itself was not eligible.
  const base = reportFor(4, 'event57014');
  const invalidPair = base
    .replace('pair-1: outcome=VALID', 'pair-1: outcome=INVALID')
    .replace('outcomes: VALID=1 INVALID=0', 'outcomes: VALID=0 INVALID=1');
  assert.equal(classifySlotReport(parseSlotReport(invalidPair).report).state, SLOT_STATE.blocker);
  const bound = base.replace(
    /( {2}stress: ran=yes result=FAIL exit=1)/,
    '$1 (process bound exceeded)',
  );
  assert.notEqual(bound, base);
  assert.equal(classifySlotReport(parseSlotReport(bound).report).state, SLOT_STATE.blocker);
  const timeout = base.replace('  infrastructure: other=3', '  infrastructure: timeout=1 other=3');
  assert.notEqual(timeout, base);
  // The row and the totals disagree now, so the report does not even parse.
  assert.equal(parseSlotReport(timeout).ok, false);
});

test('accounting: truncated, edited or foreign reports do not parse', () => {
  const text = reportFor(9, 'event57014');
  const lines = text.split('\n');
  const broken = {
    'half a report': text.slice(0, Math.floor(text.length / 2)),
    'no trailing newline': text.slice(0, -1),
    'no footer': `${lines.slice(0, -2).join('\n')}\n`,
    'no distribution line': text.replace(/^ {2}stress_wall_s: .*\n/m, ''),
    'outcomes disagree': text.replace('outcomes: VALID=1', 'outcomes: VALID=0'),
    'stress summary disagrees': text.replace(
      'stress: passed=0 failed=1 of 1',
      'stress: passed=1 failed=0 of 1',
    ),
    'unknown failure key': text.replace('finalRow=0', 'finalRows=0'),
    'short commit': text.replace(COMMIT, 'abc1234'),
    'carriage returns': text.replace(/\n/g, '\r\n'),
    'two pairs': text.replace('pairs: 1;', 'pairs: 2;'),
    'foreign header': text.replace(
      /^ADR-055 paired calibration/,
      'AUD-004 aggregation stress proof',
    ),
    'injected line in row': text.replace(
      '  infrastructure: other=3',
      '  note: trust me\n  infrastructure: other=3',
    ),
  };
  for (const [name, variant] of Object.entries(broken)) {
    assert.notEqual(variant, text, `${name} must actually change the report`);
    assert.equal(parseSlotReport(variant).ok, false, `${name} must not parse`);
  }
});

// ---------------------------------------------------------------------------
// The campaign

test('accounting: a complete campaign accounts for all 59 slots and exits zero', () => {
  const allPass = account(campaign());
  assertInvariant(allPass);
  assert.deepEqual(allPass.totals, { nonEvents: 59, events: 0, blockers: 0, missing: 0 });
  assert.equal(allPass.complete, true);
  assert.equal(allPass.exitCode, 0);
  assert.match(formatAccounting(allPass), /accounting: COMPLETE/);

  // An event is not a problem for accounting: it is data, and the campaign is
  // still complete. Interpretation is not this tool's job.
  const withEvents = account(campaign({ 7: { kind: 'event57014' }, 41: { kind: 'eventBoth' } }));
  assertInvariant(withEvents);
  assert.deepEqual(withEvents.totals, { nonEvents: 57, events: 2, blockers: 0, missing: 0 });
  assert.equal(slotOf(withEvents, 7).state, SLOT_STATE.event);
  assert.equal(withEvents.exitCode, 0);
  const text = formatAccounting(withEvents);
  assert.equal((text.match(/^slot \d+: /gm) ?? []).length, 59);
  for (const forbidden of [/p-value/i, /threshold=/, /Branch [ABC]/, /CAPABLE/]) {
    assert.ok(!forbidden.test(text.replace(/no threshold, margin, p-value/, '')), `${forbidden}`);
  }
});

test('accounting: all four states at once, and a blocker makes the campaign non-zero', () => {
  const result = account(campaign({ 2: { kind: 'event57014' }, 3: { kind: 'product' }, 4: null }));
  assertInvariant(result);
  assert.equal(slotOf(result, 1).state, SLOT_STATE.nonEvent);
  assert.equal(slotOf(result, 2).state, SLOT_STATE.event);
  assert.equal(slotOf(result, 3).state, SLOT_STATE.blocker);
  assert.equal(slotOf(result, 4).state, SLOT_STATE.missing);
  assert.deepEqual(result.totals, { nonEvents: 56, events: 1, blockers: 1, missing: 1 });
  assert.equal(result.exitCode, 1);
  assert.match(formatAccounting(result), /accounting: INCOMPLETE/);

  // Each blocker kind alone keeps the campaign non-zero.
  for (const kind of [
    'invalid',
    'inconclusive',
    'notRun',
    'ranNo',
    'timedOut',
    'refused',
    'mixed',
    'unknown',
  ]) {
    const single = account(campaign({ 30: { kind } }));
    assertInvariant(single);
    assert.equal(slotOf(single, 30).state, SLOT_STATE.blocker, kind);
    assert.equal(single.exitCode, 1, `${kind} must exit non-zero`);
  }
});

test('accounting: input order and anything outside the content cannot change the result', () => {
  const texts = campaign({ 5: { kind: 'event57014' }, 6: { kind: 'invalid' }, 7: null });
  const baseline = formatAccounting(account(texts));
  // A deterministic permutation, several times over.
  let seed = 42;
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
    assert.equal(formatAccounting(account(shuffled)), baseline, `permutation ${round}`);
  }
  assert.equal(formatAccounting(account([...texts].reverse())), baseline);
});

test('accounting: a missing slot and an absent 59th input are missing, never assumed', () => {
  const result = account(campaign({ 13: null }));
  assertInvariant(result);
  assert.equal(slotOf(result, 13).state, SLOT_STATE.missing);
  assert.equal(slotOf(result, 13).reason, 'no report claims this slot');
  assert.ok(result.problems.includes('expected 59 report inputs, got 58'));
  assert.equal(result.exitCode, 1);

  const none = accountCampaign([]);
  assertInvariant(none);
  assert.equal(none.totals.missing, 59);
  assert.equal(none.exitCode, 1);
});

test('accounting: a duplicate slot claim is missing, whichever report came first', () => {
  // Slot 21 claims twice (the second copy is really meant for slot 22).
  const texts = campaign({ 22: reportFor(21, 'event57014') });
  const result = account(texts);
  assertInvariant(result);
  assert.equal(slotOf(result, 21).state, SLOT_STATE.missing);
  assert.equal(slotOf(result, 21).reason, 'claimed by 2 reports');
  assert.equal(slotOf(result, 22).state, SLOT_STATE.missing);
  assert.equal(result.exitCode, 1);
  assert.equal(formatAccounting(account([...texts].reverse())), formatAccounting(result));

  // Byte-identical duplicates are still two claims.
  const twins = account([...campaign(), reportFor(8)]);
  assertInvariant(twins);
  assert.equal(slotOf(twins, 8).reason, 'claimed by 2 reports');
  assert.ok(twins.problems.includes('expected 59 report inputs, got 60'));
  assert.equal(twins.exitCode, 1);
});

test('accounting: a missing, malformed, misplaced or out-of-range slot field is rejected', () => {
  const good = reportFor(10);
  const variants = {
    'no campaign_slot field': good.replace('campaign_slot=10\n', ''),
    'campaign_slot field malformed': good.replace('campaign_slot=10', 'campaign_slot=ten'),
    'campaign_slot field out of range': good.replace('campaign_slot=10', 'campaign_slot=60'),
    'campaign_slot field repeated': good.replace(
      'campaign_slot=10\n',
      'campaign_slot=10\ncampaign_slot=10\n',
    ),
    'campaign_slot field misplaced': good
      .replace('campaign_slot=10\n', '')
      .replace('campaign preflight: passed', 'campaign preflight: passed\ncampaign_slot=10'),
  };
  const extra = {
    'campaign_slot field malformed': [
      'campaign_slot=0',
      'campaign_slot=07',
      'campaign_slot=-3',
      'campaign_slot=unknown',
      'campaign_slot=1.0',
    ],
  };
  for (const [reason, text] of Object.entries(variants)) {
    assert.notEqual(text, good);
    assert.deepEqual(readCampaignSlot(text), { rejected: reason });
    const result = account([...campaign({ 10: null }), text]);
    assertInvariant(result);
    assert.equal(slotOf(result, 10).state, SLOT_STATE.missing, reason);
    assert.deepEqual(result.rejected, { [reason]: 1 });
    assert.ok(result.problems.includes('1 input(s) could not be assigned to a slot'));
    assert.equal(result.exitCode, 1);
  }
  for (const line of extra['campaign_slot field malformed']) {
    assert.deepEqual(readCampaignSlot(good.replace('campaign_slot=10', line)), {
      rejected: 'campaign_slot field malformed',
    });
  }
});

test('accounting: a truncated report for a real slot is missing, never an event', () => {
  const truncated = reportFor(33, 'event57014');
  const result = account(campaign({ 33: truncated.slice(0, truncated.length - 40) }));
  assertInvariant(result);
  assert.equal(slotOf(result, 33).state, SLOT_STATE.missing);
  assert.match(slotOf(result, 33).reason, /^unparseable report: /);
  assert.equal(result.totals.events, 0);
  assert.equal(result.exitCode, 1);
});

test('accounting: an unexpected extra 60th input keeps the campaign non-zero', () => {
  const foreign = reportFor(5).replace('campaign_slot=5', 'campaign_slot=60');
  const result = account([...campaign(), foreign]);
  assertInvariant(result);
  assert.deepEqual(result.totals, { nonEvents: 59, events: 0, blockers: 0, missing: 0 });
  assert.ok(result.problems.includes('expected 59 report inputs, got 60'));
  assert.deepEqual(result.rejected, { 'campaign_slot field out of range': 1 });
  assert.equal(result.complete, false);
  assert.equal(result.exitCode, 1);
});

test('accounting: a commit mismatch makes every participating slot missing, with no majority', () => {
  const result = account(campaign({ 50: { render: { commit: OTHER_COMMIT } } }));
  assertInvariant(result);
  assert.equal(result.totals.missing, 59);
  assert.equal(slotOf(result, 1).reason, 'commit provenance differs across reports');
  assert.ok(result.problems.includes('commit differs across reports (2 values)'));
  assert.equal(result.exitCode, 1);
  assert.match(formatAccounting(result), /provenance: commits=2 /);
});

test('accounting: a topology mismatch makes measured slots missing; a refused slot stays a blocker', () => {
  const drifted = { ...TOPOLOGY, runner_image: 'ubuntu24/20260914.310.1' };
  const result = account(
    campaign({ 12: { render: { topology: drifted } }, 13: { kind: 'refused' } }),
  );
  assertInvariant(result);
  assert.equal(slotOf(result, 12).state, SLOT_STATE.missing);
  assert.equal(slotOf(result, 1).reason, 'topology provenance differs across reports');
  assert.equal(slotOf(result, 13).state, SLOT_STATE.blocker, 'a refusal measured no topology');
  assert.deepEqual(result.totals, { nonEvents: 0, events: 0, blockers: 1, missing: 58 });
  assert.ok(result.problems.includes('topology differs across reports (2 values)'));
  assert.equal(result.exitCode, 1);

  // With consistent topology the same refusal is simply one blocker.
  const consistent = account(campaign({ 13: { kind: 'refused' } }));
  assertInvariant(consistent);
  assert.deepEqual(consistent.totals, { nonEvents: 58, events: 0, blockers: 1, missing: 0 });
  assert.equal(consistent.exitCode, 1);
});

// ---------------------------------------------------------------------------
// The entry point

test('accounting CLI: explicit files in, every slot and totals out, exit codes fail closed', () => {
  const dir = tempDir();
  const write = (name, text) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  // File names deliberately disagree with content: content wins.
  const paths = campaign().map((text, index) => write(`slot-${59 - index}.txt`, text));

  const complete = runAccountingCli({ argv: ['--', ...paths] });
  assert.equal(complete.exitCode, 0);
  assert.match(complete.output, /accounting: COMPLETE/);
  assert.ok(!complete.output.includes(dir), 'no path reaches the output');

  // An unreadable input is counted, not named.
  const unreadable = runAccountingCli({
    argv: [...paths.slice(1), join(dir, 'does-not-exist.txt')],
  });
  assert.equal(unreadable.exitCode, 1);
  assert.match(unreadable.output, /rejected inputs: unreadable input=1/);
  assert.match(unreadable.output, /^slot 1: missing - no report claims this slot$/m);
  assert.ok(!unreadable.output.includes('does-not-exist'));

  assert.equal(runAccountingCli({ argv: [] }).exitCode, 2);
  assert.equal(runAccountingCli({ argv: ['--'] }).exitCode, 2);
  assert.equal(runAccountingCli({ argv: ['--json', ...paths] }).exitCode, 2);

  // The real entry point, as a process: its exit status is the result.
  const run = (args) =>
    spawnSync(process.execPath, [join(here, 'aggregation-campaign-accounting.mjs'), ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
  const ok = run(paths);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /totals: non-events=59 events=0 blockers=0 missing=0/);
  const incomplete = run(paths.slice(0, 58));
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stdout, /= 59 \(expected 59\) holds/);
});

test('accounting CLI: a committed pre-slot evidence artifact is rejected, and left untouched', () => {
  const path = join(
    repoRoot,
    'docs/evidence/adr-055/induced-calibration-0015cpu-github-2026-09-16.txt',
  );
  const before = readFileSync(path, 'utf8');
  const result = runAccountingCli({ argv: [path] });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /rejected inputs: no campaign_slot field=1/);
  assert.match(result.output, /totals: non-events=0 events=0 blockers=0 missing=59/);
  assert.equal(readFileSync(path, 'utf8'), before, 'accounting only reads');
});

// ---------------------------------------------------------------------------
// Report-path manifests: the shared bounded transport, then both input modes

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
const MANIFEST_PATH = `${RUN_DIR}/list.txt`;
const CALLER = '/work/elsewhere';
const MANIFEST_ARGV = Object.freeze(['--', '--reports-manifest', '../../runs/campaign/list.txt']);
/** Long relative report names; a name never matches the slot inside its report. */
const NAMES = Array.from(
  { length: CAMPAIGN_SLOT_COUNT },
  (_, index) =>
    `reports/secret-${'long-directory-segment-'.repeat(4)}/report-${String(58 - index).padStart(3, '0')}.txt`,
);

/**
 * A fake file system: `texts[i]` lives at `RUN_DIR/NAMES[i]`, and one manifest
 * lists `lines` (default: `NAMES`). Every size check and read is recorded.
 */
function accountingFs(texts, options = {}) {
  const {
    lines = NAMES,
    manifest = manifestOf(lines),
    errors = new Set(),
    platform = 'linux',
    cwd = CALLER,
    manifestPath = MANIFEST_PATH,
  } = options;
  const reports = new Map(texts.map((text, index) => [`${RUN_DIR}/${NAMES[index]}`, text]));
  const calls = [];
  const missing = (path) => {
    throw new Error(`ENOENT secret ${path}`);
  };
  return {
    calls,
    paths: [...reports.keys()],
    reportReads: () => calls.filter(([kind]) => kind === 'report-read'),
    options: {
      platform,
      cwd,
      readText: (path) => {
        calls.push(['report-read', path]);
        if (errors.has(path) || !reports.has(path)) missing(path);
        return reports.get(path);
      },
      manifestSizeOf: (path) => {
        calls.push(['manifest-size', path]);
        if (errors.has(path) || path !== manifestPath) missing(path);
        return Object.hasOwn(options, 'manifestSize') ? options.manifestSize : manifest.length;
      },
      readManifestBytes: (path) => {
        calls.push(['manifest-read', path]);
        if (errors.has(path) || path !== manifestPath) missing(path);
        return Buffer.from(manifest);
      },
    },
  };
}

const runFs = (fs, argv = MANIFEST_ARGV) => runAccountingCli({ argv, ...fs.options });

/** Exit 2, one fixed reason plus the usage line, no report read and nothing supplied echoed. */
const assertUsageFailure = (result, reason, fs, label) => {
  assert.equal(result.exitCode, 2, label);
  const lines = result.output.split('\n');
  assert.equal(lines.length, 3, label);
  assert.equal(lines[0], reason, label);
  assert.match(lines[1], /^usage: node scripts\/aggregation-campaign-accounting\.mjs /, label);
  assert.deepEqual(fs.reportReads(), [], `${label}: no report is read`);
  assert.ok(
    !/secret|runs|work|list\.txt|ENOENT|EACCES|reports\/|\\|é/i.test(result.output),
    `${label}: nothing supplied is echoed`,
  );
};

test('report-path manifest: the shared load is bounded before and after reading and resolves from the manifest directory', () => {
  const lines = Array.from({ length: CAMPAIGN_SLOT_COUNT }, (_, i) => `r/${i}.txt`);
  const bytes = manifestOf(lines);
  const calls = [];
  const io = (size, content = bytes) => ({
    sizeOf: (path) => {
      calls.push(['size', path]);
      return size;
    },
    readBytes: (path) => {
      calls.push(['read', path]);
      return content;
    },
  });

  // The manifest path resolves from the caller; its lines from the manifest's own directory.
  assert.deepEqual(
    loadReportManifest('../m/list.txt', { ...io(bytes.length), cwd: '/work/caller' }),
    { ok: true, paths: lines.map((line) => `/work/m/${line}`) },
  );
  assert.deepEqual(calls, [
    ['size', '/work/m/list.txt'],
    ['read', '/work/m/list.txt'],
  ]);
  const windows = loadReportManifest('..\\m\\list.txt', {
    ...io(bytes.length, manifestOf(['Sub\\a.txt', 'D:\\x\\b.txt', ...lines.slice(2)])),
    cwd: 'C:\\work\\caller',
    platform: 'win32',
  });
  assert.deepEqual(windows.paths.slice(0, 3), [
    'C:\\work\\m\\Sub\\a.txt',
    'D:\\x\\b.txt',
    'C:\\work\\m\\r\\2.txt',
  ]);

  // Inclusive bounds: exactly the byte limit is read and accepted.
  const widest = manifestOf(
    Array.from(
      { length: CAMPAIGN_SLOT_COUNT },
      (_, i) => `${String(i).padStart(2, '0')}${'z'.repeat(REPORT_PATH_LIMITS.maxPathBytes - 2)}`,
    ),
  );
  assert.equal(widest.length, MAX_REPORT_MANIFEST_BYTES);
  assert.equal(MAX_REPORT_MANIFEST_BYTES, 59 * 1025);
  assert.equal(loadReportManifest('/m/list', { ...io(widest.length, widest), cwd: '/' }).ok, true);

  // A size that is too large, unknown or not a byte count refuses without reading.
  for (const size of [MAX_REPORT_MANIFEST_BYTES + 1, Number.NaN, undefined, null, '10', -1, 1.5]) {
    calls.length = 0;
    assert.deepEqual(
      loadReportManifest('/m/list', { ...io(size), cwd: '/' }),
      { ok: false, problem: REPORT_MANIFEST_PROBLEM.tooLarge },
      String(size),
    );
    assert.deepEqual(calls, [['size', '/m/list']], `${String(size)}: never read`);
  }
  // Growth after the size check is refused on the bytes actually read.
  assert.deepEqual(
    loadReportManifest('/m/list', {
      ...io(10, Buffer.alloc(MAX_REPORT_MANIFEST_BYTES + 1, 0x61)),
      cwd: '/',
    }),
    { ok: false, problem: REPORT_MANIFEST_PROBLEM.tooLarge },
  );
  // A size check or read that throws, or a read that returns no bytes, is unreadable.
  const thrown = () => {
    throw new Error('EACCES secret');
  };
  for (const broken of [
    { sizeOf: thrown, readBytes: () => bytes },
    { sizeOf: () => 10, readBytes: thrown },
    { sizeOf: () => 10, readBytes: () => 'r/0.txt\n' },
  ]) {
    assert.deepEqual(loadReportManifest('/m/list', { ...broken, cwd: '/' }), {
      ok: false,
      problem: REPORT_MANIFEST_PROBLEM.unreadable,
    });
  }

  // The path bound is inclusive and counts UTF-8 bytes.
  assert.equal(REPORT_PATH_LIMITS.maxPathBytes, 1024);
  assert.equal(exceedsPathBytes('a'.repeat(1024)), false);
  assert.equal(exceedsPathBytes('a'.repeat(1025)), true);
  assert.equal(exceedsPathBytes('é'.repeat(512)), false);
  assert.equal(exceedsPathBytes('é'.repeat(513)), true);

  // One path list: POSIX is exact after normalization; Windows is conservative.
  assert.equal(findPathCollision({ reports: ['/r/a', '/r/./a'] }), 'duplicate');
  assert.equal(findPathCollision({ reports: ['/r/a', '/r/x/../a/'] }), 'duplicate');
  assert.equal(findPathCollision({ reports: ['/r/a', '/r/A'] }), null);
  const win = { platform: 'win32' };
  for (const variant of [
    'c:\\R\\A.TXT',
    'C:/r/a.txt.',
    'C:\\r\\a.txt  ',
    'C:\\r.\\a.txt',
    'C:\\r \\a.txt',
    'C:\\r\\x\\..\\a.txt',
  ]) {
    assert.equal(reportPathKey(variant, win), reportPathKey('C:\\r\\a.txt', win), variant);
    assert.equal(findPathCollision({ reports: ['C:\\r\\a.txt', variant] }, win), 'duplicate');
  }
  assert.equal(findPathCollision({ reports: ['C:\\r\\a.txt', 'D:\\r\\a.txt'] }, win), null);
  assert.equal(findPathCollision({ one: ['/a'], two: ['/b', '/a/'] }), 'shared');
  assert.equal(findPathCollision({ one: ['/a', '/a'], two: ['/a'] }), 'duplicate');
});

test('accounting CLI: explicit paths keep their accounting; syntax and duplicates exit 2 before any read', () => {
  const texts = campaign();
  const fs = accountingFs(texts);
  const explicit = runAccountingCli({ argv: ['--', ...fs.paths], ...fs.options });
  assert.equal(explicit.exitCode, 0);
  assert.equal(explicit.output, formatAccounting(account(texts)));
  assert.equal(fs.reportReads().length, CAMPAIGN_SLOT_COUNT);
  assert.equal(
    fs.calls.length,
    CAMPAIGN_SLOT_COUNT,
    'explicit paths never touch a manifest reader',
  );

  // Fewer readable inputs still run the unchanged accounting and report the missing slots.
  const partial = accountingFs(texts);
  const fewer = runAccountingCli({
    argv: [...partial.paths.slice(1), `${RUN_DIR}/reports/secret-absent.txt`],
    ...partial.options,
  });
  assert.equal(fewer.exitCode, 1);
  assert.equal(
    fewer.output,
    formatAccounting(
      accountCampaign([...texts.slice(1).map((text) => ({ text })), { unreadable: true }]),
    ),
  );
  assert.match(fewer.output, /^slot 1: missing - no report claims this slot$/m);
  const short = accountingFs(texts);
  const twenty = runAccountingCli({ argv: short.paths.slice(0, 20), ...short.options });
  assert.equal(twenty.exitCode, 1);
  assert.equal(twenty.output, formatAccounting(account(texts.slice(0, 20))));

  // Bounds are inclusive: a 1024-byte path and the maximum path count are still accounted.
  const edge = accountingFs(texts);
  const at = runAccountingCli({ argv: [`/${'s'.repeat(1023)}`], ...edge.options });
  assert.equal(at.exitCode, 1);
  assert.match(at.output, /rejected inputs: unreadable input=1/);
  assert.equal(MAX_REPORT_PATHS, 128);
  const many = accountingFs(texts);
  const atLimit = runAccountingCli({
    argv: Array.from({ length: MAX_REPORT_PATHS }, (_, i) => `/absent/${i}.txt`),
    ...many.options,
  });
  assert.equal(atLimit.exitCode, 1);
  assert.equal(many.reportReads().length, MAX_REPORT_PATHS);

  // POSIX paths that differ only in case are different files, so both are read.
  const posixCase = accountingFs(texts);
  const distinct = runAccountingCli({
    argv: ['/r/Report.txt', '/r/report.txt'],
    ...posixCase.options,
  });
  assert.equal(distinct.exitCode, 1);
  assert.equal(posixCase.reportReads().length, 2);

  const cases = [
    ['overlong path', [`/${'secret'.repeat(171)}`], USAGE_ERROR.pathTooLong],
    ['overlong multibyte path', ['é'.repeat(513)], USAGE_ERROR.pathTooLong],
    [
      'too many paths',
      Array.from({ length: MAX_REPORT_PATHS + 1 }, (_, i) => `secret-${i}.txt`),
      USAGE_ERROR.tooManyPaths,
    ],
    ['duplicate', ['secret/a.txt', './secret/a.txt'], USAGE_ERROR.duplicatePath],
    [
      'duplicate absolute',
      [`${CALLER}/secret/a.txt`, 'secret/b/../a.txt'],
      USAGE_ERROR.duplicatePath,
    ],
    ['empty path', ['secret.txt', ''], USAGE_ERROR.emptyPath],
    ['late separator', ['secret.txt', '--', 'other.txt'], USAGE_ERROR.lateSeparator],
    ['option-like path', ['secret.txt', '-secret.txt'], USAGE_ERROR.unknownOption],
    ['unknown option echoes nothing', ['--json=secret', 'secret.txt'], USAGE_ERROR.unknownOption],
    ['no path', [], USAGE_ERROR.noReport],
    ['only separators', ['--', '--'], USAGE_ERROR.noReport],
  ];
  const windows = { platform: 'win32', cwd: 'C:\\Work\\Caller' };
  for (const [a, b] of [
    ['C:\\Runs\\Report.txt', 'c:\\runs\\report.TXT'],
    ['C:\\runs\\report.txt', 'C:\\runs\\report.txt.'],
    ['C:\\runs\\report.txt', 'C:\\runs\\report.txt  '],
    ['C:\\runs \\report.txt', 'C:\\runs\\report.txt'],
    ['..\\Runs\\report.txt', 'C:/work/runs/REPORT.txt'],
    ['reports.\\a.txt', 'C:\\work\\caller\\reports\\a.txt'],
  ]) {
    cases.push([`Windows ${a} ~ ${b}`, [a, b], USAGE_ERROR.duplicatePath, windows]);
  }
  for (const [label, argv, reason, over] of cases) {
    const probe = accountingFs(texts, over);
    assertUsageFailure(runAccountingCli({ argv, ...probe.options }), reason, probe, label);
    assert.deepEqual(probe.calls, [], `${label}: no file access at all`);
  }
});

test('accounting CLI manifest: 59 long relative paths in any order give exactly the explicit accounting', () => {
  const texts = campaign();
  assert.ok(NAMES.every((name) => Buffer.byteLength(`${RUN_DIR}/${name}`) > 120));
  const explicitFs = accountingFs(texts);
  const explicit = runAccountingCli({ argv: explicitFs.paths, ...explicitFs.options });

  const fs = accountingFs(texts, { lines: shuffled(NAMES, 7) });
  const viaManifest = runFs(fs);
  assert.equal(viaManifest.exitCode, 0);
  assert.equal(viaManifest.output, explicit.output);
  assert.equal(viaManifest.output, formatAccounting(account(texts)));
  // One size check, then one read of the manifest, before any report; each listed report once.
  assert.deepEqual(fs.calls.slice(0, 2), [
    ['manifest-size', MANIFEST_PATH],
    ['manifest-read', MANIFEST_PATH],
  ]);
  assert.equal(fs.calls.length, 2 + CAMPAIGN_SLOT_COUNT);
  assert.deepEqual(
    fs
      .reportReads()
      .map(([, path]) => path)
      .sort(),
    [...fs.paths].sort(),
  );

  // Absolute and `./` lines, no forwarded separator: the same result.
  const mixed = accountingFs(texts, {
    lines: NAMES.map((name, i) => (i % 2 === 0 ? `./${name}` : `${RUN_DIR}/${name}`)),
  });
  assert.equal(runFs(mixed, ['--reports-manifest', MANIFEST_PATH]).output, explicit.output);

  // Domain failures are unchanged: a blocker, a duplicate slot claim, a foreign commit and an
  // unreadable listed report are accounted exactly as with explicit paths, and exit 1.
  const failing = campaign({
    7: { kind: 'product' },
    9: reportFor(8),
    30: { render: { commit: OTHER_COMMIT } },
  });
  const unreadable = new Set([`${RUN_DIR}/${NAMES[40]}`]);
  const badManifest = accountingFs(failing, { lines: shuffled(NAMES, 3), errors: unreadable });
  const badExplicit = accountingFs(failing, { errors: unreadable });
  const bad = runFs(badManifest);
  assert.equal(bad.exitCode, 1);
  assert.equal(
    bad.output,
    runAccountingCli({ argv: badExplicit.paths, ...badExplicit.options }).output,
  );
  assert.match(bad.output, /unreadable input=1/);
  assert.match(bad.output, /accounting: INCOMPLETE/);
  assert.equal(badManifest.reportReads().length, CAMPAIGN_SLOT_COUNT);
  for (const text of [viaManifest.output, bad.output]) {
    assert.ok(!/secret|runs|work|list\.txt|ENOENT|reports\//.test(text), 'no path is printed');
  }
});

test('accounting CLI manifest: grammar, size, read and duplicate failures exit 2 with zero report reads', () => {
  const texts = campaign();
  const P = REPORT_MANIFEST_PROBLEM;
  const body = manifestOf(NAMES).toString('utf8');
  const withLine = (line, at = 30) => {
    const copy = [...NAMES];
    copy[at] = line;
    return manifestOf(copy);
  };
  const grammar = [
    ['missing final LF', Buffer.from(body.slice(0, -1)), P.finalNewline],
    ['empty', Buffer.alloc(0), P.finalNewline],
    ['CRLF', Buffer.from(body.replaceAll('\n', `${CR}\n`)), P.carriageReturn],
    ['BOM', Buffer.concat([BOM_BYTES, manifestOf(NAMES)]), P.bom],
    [
      'invalid UTF-8',
      Buffer.concat([manifestOf(NAMES.slice(1)), Buffer.from([0x61, 0xff, 0x0a])]),
      P.notUtf8,
    ],
    ['NUL', withLine(`secret${NUL}.txt`), P.control],
    ['tab', withLine(`secret${TAB}.txt`), P.control],
    ['DEL', withLine(`secret${DEL}`), P.control],
    ['blank line', withLine(''), P.blankLine],
    ['leading space', withLine(' secret.txt'), P.whitespace],
    ['trailing space', withLine('secret.txt '), P.whitespace],
    ['option-like', withLine('--secret'), P.optionLike],
    ['comment', withLine('# secret'), P.notPlainPath],
    ['quoted', withLine('"secret.txt"'), P.notPlainPath],
    ['URL', withLine('https://secret.invalid/r.txt'), P.notPlainPath],
    ['drive-relative', withLine('C:secret.txt'), P.notPlainPath],
    ['overlong entry', withLine('s'.repeat(1025)), P.entryTooLong],
    ['58 lines', manifestOf(NAMES.slice(1)), P.lineCount],
    ['60 lines', manifestOf([...NAMES, 'reports/secret-extra.txt']), P.lineCount],
  ];
  const failures = [
    ...grammar.map(([label, manifest, problem]) => [
      label,
      { manifest },
      `reports manifest: ${problem}`,
    ]),
    [
      'oversized',
      { manifestSize: MAX_REPORT_MANIFEST_BYTES + 1 },
      `reports manifest: ${P.tooLarge}`,
      true,
    ],
    ['unknown size', { manifestSize: Number.NaN }, `reports manifest: ${P.tooLarge}`, true],
    ['no size', { manifestSize: undefined }, `reports manifest: ${P.tooLarge}`, true],
    [
      'grown after the size check',
      { manifest: Buffer.alloc(MAX_REPORT_MANIFEST_BYTES + 1, 0x61), manifestSize: 10 },
      `reports manifest: ${P.tooLarge}`,
    ],
    ['unreadable', { errors: new Set([MANIFEST_PATH]) }, `reports manifest: ${P.unreadable}`, true],
    ['duplicate line', { lines: [...NAMES.slice(1), NAMES[5]] }, USAGE_ERROR.duplicatePath],
    [
      'duplicate ./ line',
      { lines: [...NAMES.slice(1), `./${NAMES[5]}`] },
      USAGE_ERROR.duplicatePath,
    ],
    [
      'duplicate after normalization',
      { lines: [...NAMES.slice(1), `${RUN_DIR}/x/../${NAMES[5]}`] },
      USAGE_ERROR.duplicatePath,
    ],
  ];
  const winManifest = 'D:\\Runs\\List.txt';
  for (const variant of [
    'REPORTS\\A.TXT',
    'reports\\a.txt.',
    'reports.\\a.txt',
    'reports \\a.txt',
    'd:/runs/reports/a.txt',
    'reports/a.txt',
  ]) {
    failures.push([
      `Windows ${variant}`,
      {
        lines: [...NAMES.slice(2), 'reports\\a.txt', variant],
        platform: 'win32',
        cwd: 'C:\\Work',
        manifestPath: winManifest,
        argv: ['--reports-manifest', winManifest],
      },
      USAGE_ERROR.duplicatePath,
    ]);
  }
  for (const [label, over, reason, unread] of failures) {
    const fs = accountingFs(texts, over);
    assertUsageFailure(runFs(fs, over.argv), reason, fs, label);
    if (unread) {
      assert.ok(!fs.calls.some(([kind]) => kind === 'manifest-read'), `${label}: manifest unread`);
    }
  }

  // The same case-only spelling under POSIX is two files: both are read, and accounting decides.
  const posixCase = accountingFs(texts, {
    lines: [...NAMES.slice(2), 'reports/a.txt', 'REPORTS/A.TXT'],
  });
  assert.equal(runFs(posixCase).exitCode, 1);
  assert.equal(posixCase.reportReads().length, CAMPAIGN_SLOT_COUNT);
});

test('accounting CLI manifest: option errors exit 2 before any manifest or report access', () => {
  const cases = [
    ['mixed, path first', ['secret.txt', '--reports-manifest', 'list.txt'], USAGE_ERROR.mixedModes],
    [
      'mixed, manifest first',
      ['--reports-manifest', 'list.txt', 'secret.txt'],
      USAGE_ERROR.extraArgument,
    ],
    [
      'repeated',
      ['--reports-manifest', 'list.txt', '--reports-manifest', 'secret.txt'],
      USAGE_ERROR.repeatedOption,
    ],
    ['missing value', ['--', '--reports-manifest'], USAGE_ERROR.manifestValue],
    ['empty value', ['--reports-manifest', ''], USAGE_ERROR.manifestValue],
    ['option-like value', ['--reports-manifest', '--secret'], USAGE_ERROR.manifestValue],
    ['dash value', ['--reports-manifest', '-'], USAGE_ERROR.manifestValue],
    ['separator value', ['--reports-manifest', '--', 'list.txt'], USAGE_ERROR.manifestValue],
    ['inline value', ['--reports-manifest=secret.txt'], USAGE_ERROR.inlineValue],
    ['inline empty value', ['--reports-manifest='], USAGE_ERROR.inlineValue],
    ['unknown option', ['--reports', 'secret.txt'], USAGE_ERROR.unknownOption],
    ['near miss', ['--report-manifest', 'secret.txt'], USAGE_ERROR.unknownOption],
    ['short option', ['-m', 'secret.txt'], USAGE_ERROR.unknownOption],
    [
      'extra values',
      ['--reports-manifest', 'list.txt', 'secret.txt', 'more.txt'],
      USAGE_ERROR.extraArgument,
    ],
    ['extra option', ['--reports-manifest', 'list.txt', '--json'], USAGE_ERROR.unknownOption],
    ['late separator', ['--reports-manifest', 'list.txt', '--'], USAGE_ERROR.lateSeparator],
    [
      'overlong manifest path',
      ['--reports-manifest', `secret${'s'.repeat(1019)}`],
      USAGE_ERROR.pathTooLong,
    ],
  ];
  for (const [label, argv, reason] of cases) {
    const fs = accountingFs(campaign());
    assertUsageFailure(runFs(fs, argv), reason, fs, label);
    assert.deepEqual(fs.calls, [], `${label}: no file access at all`);
  }
  // A 1024-byte manifest path is accepted syntax: only then is the manifest itself consulted.
  const edge = accountingFs(campaign());
  const at = runFs(edge, ['--reports-manifest', `/${'s'.repeat(1023)}`]);
  assertUsageFailure(at, `reports manifest: ${REPORT_MANIFEST_PROBLEM.unreadable}`, edge, 'edge');
  assert.deepEqual(
    edge.calls.map(([kind]) => kind),
    ['manifest-size'],
  );
});

test('accounting stays manual and read-only, and shares the manifest contract rather than the comparator', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['account:aggregation-campaign'],
    'node scripts/aggregation-campaign-accounting.mjs',
  );
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name === 'account:aggregation-campaign') continue;
    assert.ok(!command.includes('aggregation-campaign-accounting'), name);
    assert.ok(!command.includes('account:aggregation-campaign'), name);
  }
  for (const file of [
    '.github/workflows/ci.yml',
    'scripts/run-test-phases.mjs',
    'scripts/test-phases-lib.mjs',
    'scripts/check-test-phases.mjs',
  ]) {
    const text = readFileSync(join(repoRoot, file), 'utf8');
    assert.ok(!text.includes('aggregation-campaign-accounting'), file);
    assert.ok(!text.includes('account:aggregation-campaign'), file);
    assert.ok(!text.includes('report-manifest'), file);
  }
  assert.deepEqual(readdirSync(join(repoRoot, '.github', 'workflows')), ['ci.yml']);

  const specifiers = (text) =>
    [...text.matchAll(/^(?:import .*|\}) from '([^']+)';$/gm)].map((m) => m[1]).sort();
  const cli = readFileSync(join(here, 'aggregation-campaign-accounting.mjs'), 'utf8');
  const manifestLib = readFileSync(
    join(here, 'aggregation-campaign-report-manifest-lib.mjs'),
    'utf8',
  );
  assert.deepEqual(specifiers(cli), [
    './aggregation-campaign-accounting-lib.mjs',
    './aggregation-campaign-log-recovery-lib.mjs',
    './aggregation-campaign-report-manifest-lib.mjs',
    'node:fs',
    'node:path',
    'node:url',
  ]);
  assert.deepEqual(specifiers(manifestLib), [
    './aggregation-campaign-accounting-lib.mjs',
    'node:path',
  ]);
  assert.ok(
    !readFileSync(join(here, 'aggregation-campaign-accounting-lib.mjs'), 'utf8').includes(
      'report-manifest',
    ),
    'no cycle: the accounting library does not import the manifest contract',
  );
  assert.match(cli, /^import \{ readFileSync, statSync \} from 'node:fs';$/m);
  for (const text of [cli, manifestLib]) {
    assert.ok(!/writeFile|mkdir|rename|unlink|rmSync|readdir|opendir|globSync|fetch\(/.test(text));
  }
});

test('accounting (spawned package command): a report-path manifest carries 59 long paths; COMPLETE, blocker, exit 2; nothing written', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const [program, script, ...rest] = pkg.scripts['account:aggregation-campaign'].split(' ');
  assert.equal(program, 'node');
  assert.deepEqual(rest, []);
  const scriptPath = join(repoRoot, script);

  const root = mkdtempSync(join(tmpdir(), 'aggregation-campaign-accounting-manifest-test-'));
  temporaryDirs.push(root);
  assert.ok(!resolve(root).startsWith(repoRoot));
  const segment = `private-reports-${'long-directory-segment-'.repeat(5)}`.slice(0, 90);
  const reportDir = join(root, segment);
  const callerDir = join(root, 'caller');
  for (const dir of [reportDir, callerDir]) mkdirSync(dir);

  // File names deliberately disagree with content and the listing order is shuffled.
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

  const manifest = join(root, 'reports.manifest');
  const malformed = join(root, 'malformed.manifest');
  writeFileSync(manifest, manifestOf(shuffled(names, 5).map((name) => `${segment}/${name}`)));
  writeFileSync(
    malformed,
    Buffer.from(manifestOf(names).toString('utf8').replaceAll('\n', `${CR}\n`)),
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
  const leaks = [root, 'private', 'long-directory', '.manifest', repoRoot, 'caller', 'ENOENT'];
  const assertNoLeak = (text) => {
    for (const leak of leaks) assert.ok(!text.includes(leak), 'nothing supplied is echoed');
  };

  // Relative manifest path from a different working directory; relative lines from the manifest.
  const complete = run(['--', '--reports-manifest', '../reports.manifest']);
  assert.equal(complete.status, 0, complete.stdout);
  assert.match(complete.stdout, /accounting: COMPLETE/);
  assert.match(complete.stdout, /totals: non-events=59 events=0 blockers=0 missing=0/);
  assert.equal(complete.stdout, formatAccounting(account(texts)));
  assertNoLeak(complete.stdout);

  // A product failure in one report is an unchanged domain result: a blocker, exit 1.
  const target = paths[20];
  const original = readFileSync(target);
  const slot = Number(/campaign_slot=(\d+)/.exec(original.toString('utf8'))[1]);
  writeFileSync(target, reportFor(slot, 'product'));
  const blocker = run(['--reports-manifest', manifest]);
  assert.equal(blocker.status, 1);
  assert.match(blocker.stdout, /totals: non-events=58 events=0 blockers=1 missing=0/);
  assertNoLeak(blocker.stdout);
  writeFileSync(target, original);

  const broken = run(['--', '--reports-manifest', malformed]);
  assert.equal(broken.status, 2);
  assert.equal(
    broken.stdout.split('\n')[0],
    `reports manifest: ${REPORT_MANIFEST_PROBLEM.carriageReturn}`,
  );
  assertNoLeak(broken.stdout);

  const restored = run(['--reports-manifest', manifest]);
  assert.equal(restored.status, 0);
  assert.equal(restored.stdout, complete.stdout);
});
