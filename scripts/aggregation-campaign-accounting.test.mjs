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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { runAccountingCli } from './aggregation-campaign-accounting.mjs';
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
