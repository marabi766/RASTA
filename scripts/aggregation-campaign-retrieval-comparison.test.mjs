/**
 * Byte comparison of two campaign retrievals: downloaded artifact reports and
 * reports materialized from job logs.
 *
 * Every report is rendered by the real `formatCalibrationReport` from real
 * summaries; every commit, topology, timestamp and path is a **synthetic** test
 * value. No live artifact or log was compared. Nothing needs Docker,
 * PostgreSQL, GitHub or the network; the only real files live in a temporary
 * directory outside the repository, which is removed afterwards.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CAMPAIGN_SLOT_COUNT, parseSlotReport } from './aggregation-campaign-accounting-lib.mjs';
import {
  LAUNCHER,
  PROCESS_OUTCOME,
  calibrationProbeId,
  calibrationStressId,
  formatCalibrationReport,
  sealProbeOutcome,
  summarizeCalibration,
  summarizeJestRun,
} from './aggregation-evidence-lib.mjs';
import { LOG_RECOVERY_LIMITS } from './aggregation-campaign-log-recovery-lib.mjs';
import {
  COHORT_INPUT_PROBLEM,
  COMPARISON_DECISION,
  RETRIEVAL_COMPARISON_LIMITS,
  compareRetrievals,
  formatRetrievalComparison,
  validateRetrievalCohort,
} from './aggregation-campaign-retrieval-comparison-lib.mjs';
import {
  USAGE_ERROR,
  parseComparisonArgs,
  runRetrievalComparisonCli,
} from './aggregation-campaign-retrieval-comparison.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const CLI = join(here, 'aggregation-campaign-retrieval-comparison.mjs');

const temporaryDirs = [];
after(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Synthetic reports rendered by the real harness code

const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const TOPOLOGY = Object.freeze({
  runner_os: '"Ubuntu 24.04.5 LTS"',
  runner_image: 'ubuntu24/20260907.300.1',
  kernel: '6.17.0-1022-azure',
  cpus: 4,
  memory_gib: '15.6',
});
const KERNEL_DRIFT = '6.17.0-1023-azure';

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
const summary = (messages) => {
  const control = sealProbeOutcome({ problems: [], diagnostics: [] });
  const pairProbe = sealProbeOutcome({
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

const KINDS = {
  pass: [],
  event: ['error: canceling statement due to statement timeout'],
  product: ['    > 212 |       expect(rows).toHaveLength(1);'],
};

const reportText = (slot, { kind = 'pass', commit = COMMIT, topology = TOPOLOGY, second } = {}) =>
  formatCalibrationReport({
    meta: {
      commit,
      generatedAt: `2026-09-21T01:00:${String(second ?? slot % 60).padStart(2, '0')}.000Z`,
      campaignSlot: slot,
    },
    topology,
    summary: summary(KINDS[kind]),
  });

/** Slots 1..59 as independent byte buffers; an override is options, text or `null` (dropped). */
const cohort = (overrides = {}) => {
  const out = [];
  for (let slot = 1; slot <= CAMPAIGN_SLOT_COUNT; slot += 1) {
    const over = overrides[slot];
    if (over === null) continue;
    const text = typeof over === 'string' ? over : reportText(slot, over);
    out.push(Buffer.from(text, 'utf8'));
  }
  return out;
};

const inputs = (buffers) =>
  buffers.map((bytes) => (Buffer.isBuffer(bytes) ? { bytes: Buffer.from(bytes) } : bytes));

const compare = (artifacts, fallback) =>
  compareRetrievals({ artifacts: inputs(artifacts), fallback: inputs(fallback) });

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

/** Changes exactly one byte at `index`. */
const flipByte = (buffer, index, delta = 1) => {
  const copy = Buffer.from(buffer);
  copy[index] = (copy[index] + delta) & 0xff;
  return copy;
};

/** Output is fixed lines, counts and fixed sentences — nothing supplied. */
const assertSafeOutput = (text, forbidden = []) => {
  const lines = text.split('\n');
  assert.equal(lines.at(-1), '', 'ends with one newline');
  assert.equal(lines.length, 9, 'fixed number of lines');
  for (const line of lines) assert.ok(line.length <= 240, 'every line is bounded');
  assert.equal((text.match(/^COMPARISON: /gm) ?? []).length, 1, 'exactly one decision line');
  for (const value of [
    COMMIT,
    OTHER_COMMIT,
    TOPOLOGY.kernel,
    KERNEL_DRIFT,
    TOPOLOGY.runner_image,
    'topology:',
    'generated=',
    'sha256',
    'slot-',
    'campaign_slot',
    ...forbidden,
  ]) {
    assert.ok(!text.includes(value), 'no supplied value is echoed');
  }
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), 'no timestamp is echoed');
  assert.ok(!/\bslot \d+/.test(text), 'no slot identity is echoed');
  assert.ok(!/events=|non-events=|threshold/.test(text), 'no outcome is interpreted');
};

const decisionOf = (result) => {
  const text = formatRetrievalComparison(result);
  assert.equal(
    (text.match(/^COMPARISON: (MATCH|DIFFERENT|REJECTED)$/m) ?? [])[1],
    result.decision,
    'the printed decision is the result decision',
  );
  assert.equal(result.exitCode, result.decision === COMPARISON_DECISION.match ? 0 : 1);
  return result.decision;
};

// ---------------------------------------------------------------------------
// MATCH

test('comparison: two complete, byte-identical 59-slot cohorts MATCH', () => {
  const artifacts = cohort({ 4: { kind: 'event' }, 40: { kind: 'event' } });
  const fallback = cohort({ 4: { kind: 'event' }, 40: { kind: 'event' } });
  const result = compare(artifacts, fallback);
  assert.equal(decisionOf(result), COMPARISON_DECISION.match);
  assert.deepEqual(result.comparison, { compared: 59, identical: 59, different: 0 });
  for (const side of [result.artifacts, result.fallback]) {
    assert.deepEqual(side, {
      accepted: true,
      problems: [],
      inputs: 59,
      read: 59,
      accountingComplete: true,
    });
  }
  const text = formatRetrievalComparison(result);
  assertSafeOutput(text);
  assert.equal(
    text,
    [
      'ADR-055 campaign retrieval comparison - exact report bytes per parsed slot; paths, file names, input order and job conclusions are never read',
      'artifacts cohort: ACCEPTED inputs=59 read=59 accounting=COMPLETE',
      '  artifacts problems: none',
      'fallback cohort: ACCEPTED inputs=59 read=59 accounting=COMPLETE',
      '  fallback problems: none',
      'comparison: slots_compared=59 identical=59 different=0',
      'COMPARISON: MATCH',
      'scope: equality of the supplied bytes only; it does not show that either source is authentic, retrievable, fresh, from attempt 1 or from an authorized run, and it verifies no launch-readiness row.',
      '',
    ].join('\n'),
  );
});

test('comparison: input order on either side, and cohort labels, cannot change the decision', () => {
  const base = cohort();
  const edited = cohort({ 17: { second: 58 } });
  const truncated = cohort({ 9: reportText(9).slice(0, -1) });
  for (const [a, b] of [
    [base, base],
    [base, edited],
    [base, truncated],
  ]) {
    const baseline = formatRetrievalComparison(compare(a, b));
    for (const seed of [3, 7, 19, 101]) {
      assert.equal(
        formatRetrievalComparison(compare(shuffled(a, seed), shuffled(b, seed * 5 + 1))),
        baseline,
        'shuffled inputs give identical output',
      );
    }
    const forward = compare(a, b);
    const swapped = compare(b, a);
    assert.equal(swapped.decision, forward.decision, 'swapped labels give the same decision');
    assert.deepEqual(swapped.comparison, forward.comparison);
    assert.deepEqual(swapped.artifacts, forward.fallback, 'cohort diagnostics swap with labels');
    assert.deepEqual(swapped.fallback, forward.artifacts);
  }
});

// ---------------------------------------------------------------------------
// DIFFERENT — exact bytes, not parsed fields

test('comparison: a one-byte difference in any one slot is DIFFERENT, with no slot named', () => {
  for (const slot of [1, 17, 59]) {
    const second = slot % 60;
    const fallback = cohort({ [slot]: { second: second % 10 === 9 ? second - 1 : second + 1 } });
    const artifacts = cohort();
    const index = artifacts.findIndex(
      (bytes) => parseSlotReport(bytes.toString()).report.slot === slot,
    );
    assert.equal(
      artifacts[index].length,
      fallback[index].length,
      'the edited report has the same length',
    );
    const differing = [...artifacts[index]].filter((byte, i) => byte !== fallback[index][i]);
    assert.equal(differing.length, 1, 'exactly one byte differs');

    const result = compare(artifacts, fallback);
    assert.equal(decisionOf(result), COMPARISON_DECISION.different);
    assert.deepEqual(result.comparison, { compared: 59, identical: 58, different: 1 });
    const text = formatRetrievalComparison(result);
    assertSafeOutput(text, slot === 17 ? ['17'] : []);
    assert.match(text, /^comparison: slots_compared=59 identical=58 different=1$/m);
  }
});

test('comparison: reports equal in every parsed field but different in bytes are DIFFERENT', () => {
  const artifacts = cohort();
  // Only the unparsed `generated=` value and one prose line differ.
  const fallback = cohort({ 12: reportText(12, { second: 0 }) });
  fallback[20] = Buffer.from(
    reportText(21).replace('No threshold, no margin', 'No threshold, no margiN'),
    'utf8',
  );
  assert.notEqual(fallback[20].toString('utf8'), reportText(21));
  for (const index of [11, 20]) {
    const a = parseSlotReport(artifacts[index].toString('utf8'));
    const b = parseSlotReport(fallback[index].toString('utf8'));
    assert.equal(a.ok, true);
    assert.deepEqual(b, a, 'the strict parser sees identical reports');
    assert.ok(!artifacts[index].equals(fallback[index]));
  }
  const result = compare(artifacts, fallback);
  assert.equal(decisionOf(result), COMPARISON_DECISION.different);
  assert.deepEqual(result.comparison, { compared: 59, identical: 57, different: 2 });

  // A different commit or topology on a whole, internally consistent side is a byte difference too.
  const otherCommit = cohort(
    Object.fromEntries(Array.from({ length: 59 }, (_, i) => [i + 1, { commit: OTHER_COMMIT }])),
  );
  const drifted = cohort(
    Object.fromEntries(
      Array.from({ length: 59 }, (_, i) => [
        i + 1,
        { topology: { ...TOPOLOGY, kernel: KERNEL_DRIFT } },
      ]),
    ),
  );
  for (const other of [otherCommit, drifted]) {
    const across = compare(artifacts, other);
    assert.equal(decisionOf(across), COMPARISON_DECISION.different);
    assert.deepEqual(across.comparison, { compared: 59, identical: 0, different: 59 });
    assertSafeOutput(formatRetrievalComparison(across));
  }

  // Equal bytes in distinct buffer objects match: identity plays no part.
  assert.equal(compare(cohort(), cohort()).decision, COMPARISON_DECISION.match);
});

test('comparison: no single-byte change of a report can still MATCH', () => {
  const artifacts = cohort();
  const target = artifacts.findIndex(
    (bytes) => parseSlotReport(bytes.toString()).report.slot === 30,
  );
  const { length } = artifacts[target];
  let different = 0;
  let rejected = 0;
  for (let index = 0; index < length; index += 13) {
    const fallback = artifacts.map((bytes) => Buffer.from(bytes));
    fallback[target] = flipByte(artifacts[target], index);
    const { decision, exitCode } = compare(artifacts, fallback);
    assert.notEqual(decision, COMPARISON_DECISION.match, `byte ${index}`);
    assert.equal(exitCode, 1);
    if (decision === COMPARISON_DECISION.different) different += 1;
    else rejected += 1;
  }
  assert.ok(different > 0, 'some edits keep a valid report and are a byte difference');
  assert.ok(rejected > 0, 'some edits break the report and reject the cohort');
});

// ---------------------------------------------------------------------------
// REJECTED — each cohort alone

/** Cohort defects, each applied to one side only. */
const DEFECTS = {
  crlf: {
    make: () => cohort({ 8: reportText(8).replaceAll('\n', '\r\n') }),
    problems: [COHORT_INPUT_PROBLEM.accounting, COHORT_INPUT_PROBLEM.binding],
  },
  missingFinalNewline: {
    make: () => cohort({ 8: reportText(8).slice(0, -1) }),
    problems: [COHORT_INPUT_PROBLEM.accounting, COHORT_INPUT_PROBLEM.binding],
  },
  bom: {
    make: () => cohort({ 8: `﻿${reportText(8)}` }),
    problems: [COHORT_INPUT_PROBLEM.accounting, COHORT_INPUT_PROBLEM.binding],
  },
  duplicate: {
    make: () => cohort({ 8: reportText(9) }),
    problems: [COHORT_INPUT_PROBLEM.accounting, COHORT_INPUT_PROBLEM.binding],
  },
  missingSlot: {
    make: () => cohort({ 8: null }),
    problems: [COHORT_INPUT_PROBLEM.count],
  },
  extraReport: {
    make: () => [...cohort(), Buffer.from(reportText(9), 'utf8')],
    problems: [COHORT_INPUT_PROBLEM.count],
  },
  malformed: {
    make: () => cohort({ 8: reportText(8).replace('outcomes: ', 'outcome: ') }),
    problems: [COHORT_INPUT_PROBLEM.accounting, COHORT_INPUT_PROBLEM.binding],
  },
  blocker: {
    make: () => cohort({ 8: { kind: 'product' } }),
    problems: [COHORT_INPUT_PROBLEM.accounting],
  },
  commitInconsistent: {
    make: () => cohort({ 8: { commit: OTHER_COMMIT } }),
    problems: [COHORT_INPUT_PROBLEM.accounting, COHORT_INPUT_PROBLEM.commit],
  },
  topologyInconsistent: {
    make: () => cohort({ 8: { topology: { ...TOPOLOGY, kernel: KERNEL_DRIFT } } }),
    problems: [COHORT_INPUT_PROBLEM.accounting, COHORT_INPUT_PROBLEM.topology],
  },
  oversized: {
    make: () => [{ oversized: true }, ...cohort({ 8: null })],
    problems: [
      COHORT_INPUT_PROBLEM.oversized,
      COHORT_INPUT_PROBLEM.accounting,
      COHORT_INPUT_PROBLEM.binding,
    ],
  },
  oversizedBytes: {
    make: () => [
      Buffer.alloc(LOG_RECOVERY_LIMITS.maxCandidateBytes + 1, 0x61),
      ...cohort({ 8: null }),
    ],
    problems: [
      COHORT_INPUT_PROBLEM.oversized,
      COHORT_INPUT_PROBLEM.accounting,
      COHORT_INPUT_PROBLEM.binding,
    ],
  },
  unreadable: {
    make: () => [{ unreadable: true }, ...cohort({ 8: null })],
    problems: [
      COHORT_INPUT_PROBLEM.unreadable,
      COHORT_INPUT_PROBLEM.accounting,
      COHORT_INPUT_PROBLEM.binding,
    ],
  },
  notUtf8: {
    make: () => [
      Buffer.concat([Buffer.from(reportText(8), 'utf8').subarray(0, 40), Buffer.from([0xff])]),
      ...cohort({ 8: null }),
    ],
    problems: [
      COHORT_INPUT_PROBLEM.notUtf8,
      COHORT_INPUT_PROBLEM.accounting,
      COHORT_INPUT_PROBLEM.binding,
    ],
  },
};

test('comparison: every cohort defect REJECTS on either side, independently, and is never compared', () => {
  const clean = cohort();
  for (const [name, defect] of Object.entries(DEFECTS)) {
    for (const side of ['artifacts', 'fallback']) {
      const bad = defect.make();
      const result = side === 'artifacts' ? compare(bad, cohort()) : compare(cohort(), bad);
      const other = side === 'artifacts' ? 'fallback' : 'artifacts';
      assert.equal(decisionOf(result), COMPARISON_DECISION.rejected, `${name} on ${side}`);
      assert.equal(result.comparison, null, `${name}: nothing is compared`);
      assert.equal(result[side].accepted, false);
      assert.deepEqual(result[side].problems, defect.problems, `${name} problems on ${side}`);
      assert.deepEqual(result[other], {
        accepted: true,
        problems: [],
        inputs: 59,
        read: 59,
        accountingComplete: true,
      });
      const text = formatRetrievalComparison(result);
      assertSafeOutput(text);
      assert.match(
        text,
        /^comparison: not performed - both cohorts must be complete and valid; sources are never mixed$/m,
      );
    }
    // The same defect on both sides is still REJECTED, even where the bytes are identical.
    const both = compare(defect.make(), defect.make());
    assert.equal(decisionOf(both), COMPARISON_DECISION.rejected, `${name} on both sides`);
  }
  assert.equal(compare(clean, clean).decision, COMPARISON_DECISION.match);
});

test('comparison: a cohort validates alone; a report from the other side cannot complete it', () => {
  // A mixed set: 58 artifact reports plus one report that exists only on the fallback side.
  const artifacts = cohort({ 33: null });
  const mixed = [...artifacts, Buffer.from(reportText(33), 'utf8')];
  assert.equal(compare(artifacts, cohort()).decision, COMPARISON_DECISION.rejected);
  assert.equal(validateRetrievalCohort(inputs(artifacts)).accepted, false);
  assert.deepEqual(validateRetrievalCohort(inputs(artifacts)).problems, [
    COHORT_INPUT_PROBLEM.count,
  ]);
  // Nothing marks where a byte-valid report came from; mixing is an operator rule, not a detectable state.
  assert.equal(validateRetrievalCohort(inputs(mixed)).accepted, true);
  assert.equal(validateRetrievalCohort(undefined).accepted, false);
  assert.equal(validateRetrievalCohort([...inputs(cohort()).slice(1), null]).accepted, false);
  assert.equal(compareRetrievals().decision, COMPARISON_DECISION.rejected);
  const view = validateRetrievalCohort(inputs(cohort()));
  assert.equal(view.bySlot.size, 59);
  assert.ok(!('bySlot' in validateRetrievalCohort(inputs(artifacts))));
});

// ---------------------------------------------------------------------------
// CLI with injected readers

const FAKE = (side, index) => `private/${side}-${String(index).padStart(3, '0')}.bin`;

/** A fake file system over two cohorts; records every size and read call. */
function fakeFs(
  artifacts,
  fallback,
  { sizes = {}, readErrors = new Set(), statErrors = new Set() } = {},
) {
  const files = new Map();
  artifacts.forEach((bytes, i) => files.set(FAKE('a', i), bytes));
  fallback.forEach((bytes, i) => files.set(FAKE('f', i), bytes));
  const calls = [];
  return {
    calls,
    artifactPaths: artifacts.map((_, i) => FAKE('a', i)),
    fallbackPaths: fallback.map((_, i) => FAKE('f', i)),
    sizeOf: (path) => {
      calls.push(['size', path]);
      if (statErrors.has(path)) throw new Error(`ENOENT ${path}`);
      if (path in sizes) return sizes[path];
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      return files.get(path).length;
    },
    readBytes: (path) => {
      calls.push(['read', path]);
      if (readErrors.has(path)) throw new Error(`EACCES ${path}`);
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      return Buffer.from(files.get(path));
    },
  };
}

const runFake = (fs, argv) =>
  runRetrievalComparisonCli({ argv, sizeOf: fs.sizeOf, readBytes: fs.readBytes });

test('cli: exact usage — both cohorts, in either order, after an optional leading --', () => {
  const fs = fakeFs(cohort(), cohort());
  const forms = [
    ['--artifacts', ...fs.artifactPaths, '--fallback', ...fs.fallbackPaths],
    ['--fallback', ...fs.fallbackPaths, '--artifacts', ...fs.artifactPaths],
    [
      '--',
      '--artifacts',
      ...shuffled(fs.artifactPaths),
      '--fallback',
      ...shuffled(fs.fallbackPaths, 5),
    ],
  ];
  const outputs = forms.map((argv) => runFake(fs, argv));
  for (const { exitCode, output } of outputs) {
    assert.equal(exitCode, 0);
    assert.equal(output, outputs[0].output);
    assert.match(output, /^COMPARISON: MATCH$/m);
    assertSafeOutput(output, ['private', '.bin']);
  }
  assert.ok(fs.calls.every(([, path]) => path.startsWith('private/')));

  // Cohort membership comes from the option only: labels swapped with their paths → same decision.
  const edited = fakeFs(cohort(), cohort({ 3: { second: 59 } }));
  const forward = runFake(edited, [
    '--artifacts',
    ...edited.artifactPaths,
    '--fallback',
    ...edited.fallbackPaths,
  ]);
  const swapped = runFake(edited, [
    '--artifacts',
    ...edited.fallbackPaths,
    '--fallback',
    ...edited.artifactPaths,
  ]);
  assert.equal(forward.exitCode, 1);
  assert.equal(swapped.exitCode, 1);
  assert.match(forward.output, /^COMPARISON: DIFFERENT$/m);
  assert.equal(swapped.output, forward.output);
});

test('cli: usage errors exit 2 before any size check or read, and echo no argument', () => {
  const a = Array.from({ length: 59 }, (_, i) => `secret-a-${i}.txt`);
  const f = Array.from({ length: 59 }, (_, i) => `secret-f-${i}.txt`);
  const tooMany = Array.from(
    { length: RETRIEVAL_COMPARISON_LIMITS.maxPathsPerCohort + 1 },
    (_, i) => `secret-x-${i}.txt`,
  );
  const cases = [
    [[], USAGE_ERROR.missingOption],
    [['--'], USAGE_ERROR.missingOption],
    [['--artifacts', ...a], USAGE_ERROR.missingOption],
    [['--fallback', ...f], USAGE_ERROR.missingOption],
    [[...a, '--fallback', ...f], USAGE_ERROR.pathBeforeOption],
    [['--artifacts', ...a, '--fallback'], USAGE_ERROR.emptyCohort],
    [['--artifacts', '--fallback', ...f], USAGE_ERROR.emptyCohort],
    [['--artifacts', ...a, '--artifacts', ...f], USAGE_ERROR.repeatedOption],
    [
      ['--artifacts', ...a, '--fallback', ...f, '--fallback', 'secret-z'],
      USAGE_ERROR.repeatedOption,
    ],
    [['--artifacts=secret-a', '--fallback', ...f], USAGE_ERROR.inlineValue],
    [['--artifacts', ...a, '--fallback=secret-f'], USAGE_ERROR.inlineValue],
    [['--artifacts', ...a, '--secret-option', '--fallback', ...f], USAGE_ERROR.unknownOption],
    [['--artifacts', ...a, '-secret.txt', '--fallback', ...f], USAGE_ERROR.unknownOption],
    [['--artifacts', ...a, '-', '--fallback', ...f], USAGE_ERROR.unknownOption],
    [['--ARTIFACTS', ...a, '--fallback', ...f], USAGE_ERROR.unknownOption],
    [['--artifacts', ...a, '', '--fallback', ...f], USAGE_ERROR.emptyPath],
    [['--artifacts', ...a, '--', '--fallback', ...f], USAGE_ERROR.lateSeparator],
    [['--artifacts', ...a, '--fallback', '--', ...f], USAGE_ERROR.lateSeparator],
    [['--artifacts', ...a, '--fallback', ...f.slice(1), a[5]], USAGE_ERROR.sharedPath],
    [['--artifacts', ...a, '--fallback', ...f.slice(1), `./${a[0]}`], USAGE_ERROR.sharedPath],
    [['--artifacts', ...tooMany, '--fallback', ...f], USAGE_ERROR.tooManyPaths],
    [['--artifacts', ...a, '--fallback', ...tooMany], USAGE_ERROR.tooManyPaths],
  ];
  for (const [argv, reason] of cases) {
    const calls = [];
    const result = runRetrievalComparisonCli({
      argv,
      sizeOf: (path) => calls.push(['size', path]) && 10,
      readBytes: (path) => calls.push(['read', path]) && Buffer.alloc(0),
    });
    assert.equal(result.exitCode, 2, JSON.stringify(argv.slice(0, 3)));
    assert.equal(calls.length, 0, 'nothing is checked or read on a usage error');
    const lines = result.output.split('\n');
    assert.equal(lines[0], reason);
    assert.match(
      lines[1],
      /^usage: node scripts\/aggregation-campaign-retrieval-comparison\.mjs --artifacts/,
    );
    assert.equal(lines.length, 3);
    assert.ok(!/secret|ARTIFACTS/.test(result.output), 'no argument is echoed');
    assert.equal(parseComparisonArgs(argv).ok, false);
  }
  assert.deepEqual(parseComparisonArgs(['--artifacts', 'x', '--fallback', 'y']), {
    ok: true,
    cohorts: { artifacts: ['x'], fallback: ['y'] },
  });
});

test('cli: oversized, unreadable and wrong-count cohorts are counted, not read or named', () => {
  const artifacts = cohort();
  const fallback = cohort();
  const limit = RETRIEVAL_COMPARISON_LIMITS.maxReportBytes;

  for (const side of ['a', 'f']) {
    const target = FAKE(side, 7);
    const label = side === 'a' ? 'artifacts' : 'fallback';

    const big = fakeFs(artifacts, fallback, { sizes: { [target]: limit + 1 } });
    const bigRun = runFake(big, [
      '--artifacts',
      ...big.artifactPaths,
      '--fallback',
      ...big.fallbackPaths,
    ]);
    assert.equal(bigRun.exitCode, 1);
    assert.match(bigRun.output, /^COMPARISON: REJECTED$/m);
    assert.match(
      bigRun.output,
      new RegExp(`^ {2}${label} problems: ${COHORT_INPUT_PROBLEM.oversized};`, 'm'),
    );
    assert.ok(
      !big.calls.some(([kind, path]) => kind === 'read' && path === target),
      'oversized is never read',
    );
    assertSafeOutput(bigRun.output, ['private']);

    const unknownSize = fakeFs(artifacts, fallback, { sizes: { [target]: Number.NaN } });
    runFake(unknownSize, [
      '--artifacts',
      ...unknownSize.artifactPaths,
      '--fallback',
      ...unknownSize.fallbackPaths,
    ]);
    assert.ok(!unknownSize.calls.some(([kind, path]) => kind === 'read' && path === target));

    const grown = fakeFs(
      side === 'a' ? [Buffer.alloc(limit + 1, 0x61), ...artifacts.slice(1)] : artifacts,
      side === 'f' ? [Buffer.alloc(limit + 1, 0x61), ...fallback.slice(1)] : fallback,
      { sizes: { [FAKE(side, 0)]: 10 } },
    );
    const grownRun = runFake(grown, [
      '--artifacts',
      ...grown.artifactPaths,
      '--fallback',
      ...grown.fallbackPaths,
    ]);
    assert.match(
      grownRun.output,
      new RegExp(`^ {2}${label} problems: ${COHORT_INPUT_PROBLEM.oversized};`, 'm'),
    );

    for (const errors of [{ statErrors: new Set([target]) }, { readErrors: new Set([target]) }]) {
      const broken = fakeFs(artifacts, fallback, errors);
      const run = runFake(broken, [
        '--artifacts',
        ...broken.artifactPaths,
        '--fallback',
        ...broken.fallbackPaths,
      ]);
      assert.equal(run.exitCode, 1);
      assert.match(
        run.output,
        new RegExp(`^${label} cohort: REJECTED inputs=59 read=58 accounting=INCOMPLETE$`, 'm'),
      );
      assert.match(
        run.output,
        new RegExp(`^ {2}${label} problems: ${COHORT_INPUT_PROBLEM.unreadable};`, 'm'),
      );
      assertSafeOutput(run.output, ['private', 'ENOENT', 'EACCES']);
    }

    // A cohort that cannot hold 59 reports is not read at all; the other side still is.
    const short = fakeFs(
      side === 'a' ? artifacts.slice(1) : artifacts,
      side === 'f' ? fallback.slice(1) : fallback,
    );
    const shortRun = runFake(short, [
      '--artifacts',
      ...short.artifactPaths,
      '--fallback',
      ...short.fallbackPaths,
    ]);
    assert.equal(shortRun.exitCode, 1);
    assert.match(
      shortRun.output,
      new RegExp(`^${label} cohort: REJECTED inputs=58 read=0 accounting=INCOMPLETE$`, 'm'),
    );
    assert.ok(!short.calls.some(([, path]) => path.startsWith(`private/${side}-`)));
    assert.equal(short.calls.filter(([kind]) => kind === 'read').length, 59);
  }
});

// ---------------------------------------------------------------------------
// Policy

test('the comparator stays manual: outside pnpm verify, the test phases and ordinary CI', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['compare:aggregation-campaign-retrievals'],
    'node scripts/aggregation-campaign-retrieval-comparison.mjs',
  );
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name === 'compare:aggregation-campaign-retrievals') continue;
    assert.ok(!command.includes('aggregation-campaign-retrieval-comparison'), name);
    assert.ok(!command.includes('compare:aggregation-campaign-retrievals'), name);
  }
  for (const file of [
    '.github/workflows/ci.yml',
    'scripts/run-test-phases.mjs',
    'scripts/test-phases-lib.mjs',
    'scripts/check-test-phases.mjs',
  ]) {
    const text = readFileSync(join(repoRoot, file), 'utf8');
    assert.ok(!text.includes('retrieval-comparison'), file);
    assert.ok(!text.includes('compare:aggregation-campaign-retrievals'), file);
  }
  assert.deepEqual(readdirSync(join(repoRoot, '.github', 'workflows')), ['ci.yml']);

  // Read-only by construction: the only file system imports are a size check and a file read.
  const source = readFileSync(CLI, 'utf8');
  const lib = readFileSync(join(here, 'aggregation-campaign-retrieval-comparison-lib.mjs'), 'utf8');
  const specifiers = (text) =>
    [...text.matchAll(/^(?:import .*|\}) from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(specifiers(source), [
    './aggregation-campaign-accounting-lib.mjs',
    './aggregation-campaign-retrieval-comparison-lib.mjs',
    'node:fs',
    'node:path',
    'node:url',
  ]);
  assert.deepEqual(specifiers(lib), [
    './aggregation-campaign-accounting-lib.mjs',
    './aggregation-campaign-log-recovery-lib.mjs',
    './aggregation-evidence-lib.mjs',
  ]);
  assert.match(source, /^import \{ readFileSync, statSync \} from 'node:fs';$/m);
  for (const text of [source, lib]) {
    assert.ok(!/writeFile|mkdir|rename|unlink|rmSync|readdir|opendir|fetch\(/.test(text));
  }
});

// ---------------------------------------------------------------------------
// The real CLI over real temporary files

test('cli (spawned): MATCH, one-byte DIFFERENT and REJECTED over temporary files; nothing written', () => {
  const root = mkdtempSync(join(tmpdir(), 'aggregation-campaign-retrieval-comparison-test-'));
  temporaryDirs.push(root);
  assert.ok(
    !resolve(root).startsWith(repoRoot),
    'the temporary directory is outside the repository',
  );

  // Names deliberately carry no slot, and the fallback names run backwards.
  const artifacts = shuffled(cohort(), 23);
  const fallback = shuffled(cohort(), 29);
  const artifactPaths = artifacts.map((bytes, i) => {
    const path = join(root, `private-artifact-${String(i).padStart(2, '0')}.dat`);
    writeFileSync(path, bytes);
    return path;
  });
  const fallbackPaths = fallback.map((bytes, i) => {
    const path = join(root, `private-recovered-${String(58 - i).padStart(2, '0')}.dat`);
    writeFileSync(path, bytes);
    return path;
  });

  const snapshot = () =>
    readdirSync(root)
      .sort()
      .map((name) => {
        const stats = statSync(join(root, name));
        return [name, stats.size, stats.mtimeMs, readFileSync(join(root, name)).toString('base64')];
      });
  const before = snapshot();
  const run = (args) => {
    const around = snapshot();
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: root });
    assert.deepEqual(snapshot(), around, 'the run created, removed or changed nothing');
    return result;
  };

  const match = run(['--artifacts', ...artifactPaths, '--fallback', ...fallbackPaths]);
  assert.equal(match.status, 0, match.stdout);
  assert.equal(match.stderr, '');
  assert.match(
    match.stdout,
    /^comparison: slots_compared=59 identical=59 different=0\nCOMPARISON: MATCH$/m,
  );
  assertSafeOutput(match.stdout, [root, 'private', '.dat', repoRoot]);

  const reversed = run([
    '--',
    '--fallback',
    ...[...fallbackPaths].reverse(),
    '--artifacts',
    ...artifactPaths,
  ]);
  assert.equal(reversed.status, 0);
  assert.equal(reversed.stdout, match.stdout);

  // One byte of one fallback file: the `generated=` seconds digit, still a valid report.
  const target = fallbackPaths[31];
  const original = readFileSync(target);
  const text = original.toString('utf8');
  const at = text.indexOf('.000Z') - 1;
  const edited = flipByte(original, at, original[at] === 0x39 ? -1 : 1);
  writeFileSync(target, edited);
  assert.equal(parseSlotReport(edited.toString('utf8')).ok, true);
  const different = run(['--artifacts', ...artifactPaths, '--fallback', ...fallbackPaths]);
  assert.equal(different.status, 1);
  assert.match(
    different.stdout,
    /^comparison: slots_compared=59 identical=58 different=1\nCOMPARISON: DIFFERENT$/m,
  );
  assertSafeOutput(different.stdout, [root, 'private', '.dat']);

  // The same file with CRLF line endings: the fallback cohort is rejected.
  writeFileSync(target, Buffer.from(text.replaceAll('\n', '\r\n'), 'utf8'));
  const rejected = run(['--artifacts', ...artifactPaths, '--fallback', ...fallbackPaths]);
  assert.equal(rejected.status, 1);
  assert.match(
    rejected.stdout,
    /^fallback cohort: REJECTED inputs=59 read=59 accounting=INCOMPLETE$/m,
  );
  assert.match(rejected.stdout, /^COMPARISON: REJECTED$/m);
  assertSafeOutput(rejected.stdout, [root, 'private', '.dat']);

  const usage = run(['--artifacts', ...artifactPaths]);
  assert.equal(usage.status, 2);
  assert.ok(!usage.stdout.includes(root));

  // Restoring the test's own edit restores MATCH; the directory still holds only the 118 inputs.
  writeFileSync(target, original);
  assert.deepEqual(
    snapshot().map(([name, size, , bytes]) => [name, size, bytes]),
    before.map(([name, size, , bytes]) => [name, size, bytes]),
  );
  assert.equal(readdirSync(root).length, 118);
  const again = run(['--artifacts', ...artifactPaths, '--fallback', ...fallbackPaths]);
  assert.equal(again.status, 0);
  assert.equal(again.stdout, match.stdout);
});
