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
  MANIFEST_PROBLEM,
  MAX_RETRIEVAL_MANIFEST_BYTES,
  RETRIEVAL_COMPARISON_LIMITS,
  compareRetrievals,
  findPathCollision,
  formatRetrievalComparison,
  parseRetrievalManifest,
  retrievalPathKey,
  validateRetrievalCohort,
} from './aggregation-campaign-retrieval-comparison-lib.mjs';
import {
  USAGE_ERROR,
  parseComparisonArgs,
  runRetrievalComparisonCli,
} from './aggregation-campaign-retrieval-comparison.mjs';
import * as reportManifest from './aggregation-campaign-report-manifest-lib.mjs';

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
    mode: 'paths',
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
  const manifestLib = readFileSync(
    join(here, 'aggregation-campaign-report-manifest-lib.mjs'),
    'utf8',
  );
  const specifiers = (text) =>
    [...text.matchAll(/^(?:import .*|\}) from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(specifiers(source), [
    './aggregation-campaign-accounting-lib.mjs',
    './aggregation-campaign-report-manifest-lib.mjs',
    './aggregation-campaign-retrieval-comparison-lib.mjs',
    'node:fs',
    'node:path',
    'node:url',
  ]);
  assert.deepEqual(specifiers(lib), [
    './aggregation-campaign-accounting-lib.mjs',
    './aggregation-campaign-log-recovery-lib.mjs',
    './aggregation-campaign-report-manifest-lib.mjs',
    './aggregation-campaign-report-manifest-lib.mjs',
    './aggregation-evidence-lib.mjs',
  ]);
  // The shared manifest contract has no file system import and no comparator dependency.
  assert.deepEqual(specifiers(manifestLib), [
    './aggregation-campaign-accounting-lib.mjs',
    'node:path',
  ]);
  assert.match(source, /^import \{ readFileSync, statSync \} from 'node:fs';$/m);
  for (const text of [source, lib, manifestLib]) {
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

// ---------------------------------------------------------------------------
// Explicit paths — checks added alongside manifests, applied to both modes

const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const DEL = String.fromCharCode(127);

test('cli: explicit paths reject a duplicate within a cohort and an overlong path, before any read', () => {
  const a = Array.from({ length: 59 }, (_, i) => `secret-a-${i}.txt`);
  const f = Array.from({ length: 59 }, (_, i) => `secret-f-${i}.txt`);
  const long = `secret-${'x'.repeat(RETRIEVAL_COMPARISON_LIMITS.maxPathBytes)}`;
  const cases = [
    [['--artifacts', ...a.slice(1), a[3], '--fallback', ...f], USAGE_ERROR.duplicatePath],
    [['--artifacts', ...a, '--fallback', ...f.slice(1), `./${f[7]}`], USAGE_ERROR.duplicatePath],
    [['--artifacts', ...a.slice(1), long, '--fallback', ...f], USAGE_ERROR.pathTooLong],
    [
      ['--artifacts', ...a.slice(1), 'SECRET-A-3.TXT', '--fallback', ...f],
      USAGE_ERROR.duplicatePath,
      'win32',
    ],
    [
      ['--artifacts', ...a, '--fallback', ...f.slice(1), 'Secret-A-9.txt.'],
      USAGE_ERROR.sharedPath,
      'win32',
    ],
  ];
  for (const [argv, reason, platform = 'linux'] of cases) {
    const calls = [];
    const record = (path) => calls.push(path) && 10;
    const result = runRetrievalComparisonCli({
      argv,
      platform,
      cwd: platform === 'win32' ? 'C:\\work' : '/work',
      sizeOf: record,
      readBytes: record,
      manifestSizeOf: record,
      readManifestBytes: record,
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.output.split('\n')[0], reason);
    assert.equal(calls.length, 0);
    assert.ok(!/secret|xxxx/i.test(result.output));
  }
  // On a case-sensitive platform the same spellings are distinct paths.
  assert.equal(
    parseComparisonArgs(['--artifacts', ...a.slice(1), 'SECRET-A-3.TXT', '--fallback', ...f], {
      platform: 'linux',
      cwd: '/work',
    }).ok,
    true,
  );
  // A path of exactly the byte limit is accepted.
  const exact = 'y'.repeat(RETRIEVAL_COMPARISON_LIMITS.maxPathBytes);
  assert.equal(
    parseComparisonArgs(['--artifacts', ...a.slice(1), exact, '--fallback', ...f], {
      platform: 'linux',
      cwd: '/work',
    }).ok,
    true,
  );
});

// ---------------------------------------------------------------------------
// Manifest grammar (pure)

const manifestOf = (lines) => Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8');
const LINES = Array.from({ length: 59 }, (_, i) => `reports/r-${String(i).padStart(2, '0')}.bin`);
const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

test('manifest: exactly 59 LF-terminated paths, resolved against the manifest directory', () => {
  const parsed = parseRetrievalManifest(manifestOf(LINES), { manifestDir: '/runs/art' });
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    parsed.paths,
    LINES.map((line) => `/runs/art/${line}`),
  );
  const mixed = parseRetrievalManifest(
    manifestOf(['/abs/one.bin', '../up/two.bin', './here/three.bin', ...LINES.slice(3)]),
    { manifestDir: '/runs/art' },
  );
  assert.deepEqual(mixed.paths.slice(0, 3), [
    '/abs/one.bin',
    '/runs/up/two.bin',
    '/runs/art/here/three.bin',
  ]);

  const windows = parseRetrievalManifest(
    manifestOf([
      'D:\\evidence\\a.bin',
      'C:/x/b.bin',
      '\\root\\c.bin',
      'rel\\d.bin',
      ...LINES.slice(4),
    ]),
    { manifestDir: 'C:\\runs\\art', platform: 'win32' },
  );
  assert.deepEqual(windows.paths.slice(0, 4), [
    'D:\\evidence\\a.bin',
    'C:\\x\\b.bin',
    'C:\\root\\c.bin',
    'C:\\runs\\art\\rel\\d.bin',
  ]);

  // Bounds are inclusive: 1024-byte entries in a manifest of exactly the byte limit are accepted.
  const widest = Array.from(
    { length: 59 },
    (_, i) =>
      `${String(i).padStart(2, '0')}${'z'.repeat(RETRIEVAL_COMPARISON_LIMITS.maxPathBytes - 2)}`,
  );
  const widestBytes = manifestOf(widest);
  assert.equal(widestBytes.length, MAX_RETRIEVAL_MANIFEST_BYTES);
  assert.equal(MAX_RETRIEVAL_MANIFEST_BYTES, 59 * 1025);
  assert.equal(parseRetrievalManifest(widestBytes, { manifestDir: '/m' }).ok, true);
});

test('manifest: every grammar violation is a fixed problem and never echoes content', () => {
  const secret = 'secret-line';
  const body = (lines) => lines.map((line) => `${line}\n`).join('');
  const withLine = (line, at = 30) => {
    const copy = [...LINES];
    copy[at] = line;
    return manifestOf(copy);
  };
  const cases = [
    ['missing final LF', Buffer.from(body(LINES).slice(0, -1)), MANIFEST_PROBLEM.finalNewline],
    ['empty', Buffer.alloc(0), MANIFEST_PROBLEM.finalNewline],
    ['CRLF', Buffer.from(body(LINES).replaceAll('\n', `${CR}\n`)), MANIFEST_PROBLEM.carriageReturn],
    ['bare CR', withLine(`a${CR}b`), MANIFEST_PROBLEM.carriageReturn],
    ['BOM', Buffer.concat([BOM_BYTES, manifestOf(LINES)]), MANIFEST_PROBLEM.bom],
    [
      'invalid UTF-8',
      Buffer.concat([manifestOf(LINES.slice(1)), Buffer.from([0x61, 0xff, 0x0a])]),
      MANIFEST_PROBLEM.notUtf8,
    ],
    ['NUL', withLine(`${secret}${NUL}x`), MANIFEST_PROBLEM.control],
    ['tab', withLine(`${secret}${TAB}x`), MANIFEST_PROBLEM.control],
    ['DEL', withLine(`${secret}${DEL}`), MANIFEST_PROBLEM.control],
    ['blank line', withLine(''), MANIFEST_PROBLEM.blankLine],
    ['blank last line', Buffer.from(`${body(LINES.slice(1))}\n`), MANIFEST_PROBLEM.blankLine],
    ['leading space', withLine(` ${secret}`), MANIFEST_PROBLEM.whitespace],
    ['trailing space', withLine(`${secret} `), MANIFEST_PROBLEM.whitespace],
    ['option-like', withLine(`--${secret}`), MANIFEST_PROBLEM.optionLike],
    ['dash', withLine('-'), MANIFEST_PROBLEM.optionLike],
    ['comment', withLine(`# ${secret}`), MANIFEST_PROBLEM.notPlainPath],
    ['double-quoted', withLine(`"${secret}"`), MANIFEST_PROBLEM.notPlainPath],
    ['single quote at end', withLine(`${secret}'`), MANIFEST_PROBLEM.notPlainPath],
    ['https URL', withLine(`https://example.invalid/${secret}`), MANIFEST_PROBLEM.notPlainPath],
    ['file URL', withLine(`file:///tmp/${secret}`), MANIFEST_PROBLEM.notPlainPath],
    ['drive-relative', withLine(`C:${secret}`), MANIFEST_PROBLEM.notPlainPath],
    [
      'overlong entry',
      withLine('q'.repeat(RETRIEVAL_COMPARISON_LIMITS.maxPathBytes + 1)),
      MANIFEST_PROBLEM.entryTooLong,
    ],
    ['overlong multibyte entry', withLine('é'.repeat(513)), MANIFEST_PROBLEM.entryTooLong],
    ['58 lines', manifestOf(LINES.slice(1)), MANIFEST_PROBLEM.lineCount],
    ['60 lines', manifestOf([...LINES, 'extra.bin']), MANIFEST_PROBLEM.lineCount],
    ['one line', manifestOf([secret]), MANIFEST_PROBLEM.lineCount],
    ['oversized', Buffer.alloc(MAX_RETRIEVAL_MANIFEST_BYTES + 1, 0x61), MANIFEST_PROBLEM.tooLarge],
    ['not bytes', 'reports/r-00.bin\n', MANIFEST_PROBLEM.unreadable],
  ];
  for (const [name, bytes, problem] of cases) {
    assert.deepEqual(
      parseRetrievalManifest(bytes, { manifestDir: '/runs/art' }),
      { ok: false, problem },
      name,
    );
    assert.ok(!problem.includes('secret') && !problem.includes('/runs'), name);
  }
  assert.equal(
    parseRetrievalManifest(manifestOf(LINES), { manifestDir: 'relative/dir' }).ok,
    false,
    'the manifest directory must be absolute',
  );
});

test('manifest: the comparator uses the shared report-path manifest contract, not a copy', () => {
  assert.equal(parseRetrievalManifest, reportManifest.parseReportManifest);
  assert.equal(retrievalPathKey, reportManifest.reportPathKey);
  assert.equal(findPathCollision, reportManifest.findPathCollision);
  assert.equal(MANIFEST_PROBLEM, reportManifest.REPORT_MANIFEST_PROBLEM);
  assert.equal(MAX_RETRIEVAL_MANIFEST_BYTES, reportManifest.MAX_REPORT_MANIFEST_BYTES);
  assert.equal(
    RETRIEVAL_COMPARISON_LIMITS.maxPathBytes,
    reportManifest.REPORT_PATH_LIMITS.maxPathBytes,
  );
  const source = readFileSync(
    join(here, 'aggregation-campaign-retrieval-comparison-lib.mjs'),
    'utf8',
  );
  for (const forked of ['MANIFEST_CONTROL', 'NOT_PLAIN_PATH', 'toLowerCase', 'node:path']) {
    assert.ok(!source.includes(forked), 'no manifest rule is redefined in the comparator');
  }
  const cli = readFileSync(CLI, 'utf8');
  for (const forked of ['maxManifestBytes', 'dirname', 'parseRetrievalManifest']) {
    assert.ok(!cli.includes(forked), 'the CLI loads manifests only through the shared contract');
  }
});

test('manifest: path keys are conservative on Windows and exact on POSIX', () => {
  const win = { platform: 'win32' };
  for (const [a, b] of [
    ['C:\\Data\\Reports\\A.txt', 'c:/data/reports/a.TXT'],
    ['C:\\data\\a.txt', 'C:\\data\\a.txt.'],
    ['C:\\data\\a.txt', 'C:\\data\\a.txt  '],
    ['C:\\data\\dir.\\a.txt', 'C:\\data\\dir\\a.txt'],
    ['C:\\data\\x\\..\\a.txt', 'C:\\DATA\\A.TXT'],
  ]) {
    assert.equal(retrievalPathKey(a, win), retrievalPathKey(b, win), `${a} ~ ${b}`);
    assert.equal(findPathCollision({ artifacts: [a], fallback: [b] }, win), 'shared');
    assert.equal(findPathCollision({ artifacts: [a, b], fallback: [] }, win), 'duplicate');
  }
  assert.notEqual(
    retrievalPathKey('C:\\data\\a.txt', win),
    retrievalPathKey('D:\\data\\a.txt', win),
  );
  assert.equal(retrievalPathKey('/x/./y/../a', {}), '/x/a');
  assert.notEqual(retrievalPathKey('/x/A', {}), retrievalPathKey('/x/a', {}));
  assert.equal(findPathCollision({ artifacts: ['/x/A'], fallback: ['/x/a'] }, {}), null);
  assert.equal(
    findPathCollision({ artifacts: ['/x/a', '/x/b'], fallback: ['/x/b', '/x/b/'] }, {}),
    'duplicate',
    'duplicates are reported before sharing',
  );
});

// ---------------------------------------------------------------------------
// Manifest mode through the CLI, with injected readers

const reportNames = (prefix, count = 59) =>
  Array.from({ length: count }, (_, i) => `reports/${prefix}-${String(i).padStart(3, '0')}.bin`);

/**
 * A fake file system: reports under two run directories and one manifest in
 * each, listing its reports relatively. Every size check and read is recorded.
 */
function manifestFs(
  artifacts,
  fallback,
  { artifactLines, fallbackLines, manifests = {}, manifestSizes = {}, errors = new Set() } = {},
) {
  const reports = new Map();
  const aNames = reportNames('secret-art', artifacts.length);
  const fNames = reportNames('secret-fb', fallback.length);
  artifacts.forEach((bytes, i) => reports.set(`/runs/art/${aNames[i]}`, bytes));
  fallback.forEach((bytes, i) => reports.set(`/runs/fb/${fNames[i]}`, bytes));
  const files = new Map([
    ['/runs/art/list.txt', manifests.artifacts ?? manifestOf(artifactLines ?? aNames)],
    ['/runs/fb/list.txt', manifests.fallback ?? manifestOf(fallbackLines ?? fNames)],
  ]);
  const calls = [];
  const lookup = (map, path) => {
    if (errors.has(path) || !map.has(path)) throw new Error(`ENOENT ${path}`);
    return map.get(path);
  };
  return {
    calls,
    reportCalls: () => calls.filter(([kind]) => kind.startsWith('report')),
    options: {
      platform: 'linux',
      cwd: '/work/elsewhere',
      sizeOf: (path) => {
        calls.push(['report-size', path]);
        return lookup(reports, path).length;
      },
      readBytes: (path) => {
        calls.push(['report-read', path]);
        return Buffer.from(lookup(reports, path));
      },
      manifestSizeOf: (path) => {
        calls.push(['manifest-size', path]);
        return path in manifestSizes ? manifestSizes[path] : lookup(files, path).length;
      },
      readManifestBytes: (path) => {
        calls.push(['manifest-read', path]);
        return Buffer.from(lookup(files, path));
      },
    },
  };
}

const MANIFEST_ARGV = Object.freeze([
  '--artifacts-manifest',
  '../../runs/art/list.txt',
  '--fallback-manifest',
  '/runs/fb/list.txt',
]);
const runManifest = (fs, argv = MANIFEST_ARGV) =>
  runRetrievalComparisonCli({ argv: [...argv], ...fs.options });

test('cli manifests: MATCH, DIFFERENT and REJECTED, relative to each manifest, order-free', () => {
  const fs = manifestFs(cohort(), shuffled(cohort(), 3));
  const match = runManifest(fs);
  assert.equal(match.exitCode, 0, match.output);
  assert.match(match.output, /^COMPARISON: MATCH$/m);
  assertSafeOutput(match.output, ['secret', 'runs', 'list.txt', 'reports']);
  // Report paths come from each manifest's own directory, never from the working directory.
  const reportPaths = fs.reportCalls().map(([, path]) => path);
  assert.equal(reportPaths.filter((path) => path.startsWith('/runs/art/reports/')).length, 118);
  assert.equal(reportPaths.filter((path) => path.startsWith('/runs/fb/reports/')).length, 118);
  assert.ok(!reportPaths.some((path) => path.startsWith('/work')));
  assert.deepEqual(
    fs.calls.filter(([kind]) => kind.startsWith('manifest')),
    [
      ['manifest-size', '/runs/art/list.txt'],
      ['manifest-read', '/runs/art/list.txt'],
      ['manifest-size', '/runs/fb/list.txt'],
      ['manifest-read', '/runs/fb/list.txt'],
    ],
  );

  // Either option order, a leading `--`, and shuffled manifest lines change nothing.
  const reordered = manifestFs(cohort(), shuffled(cohort(), 3), {
    artifactLines: shuffled(reportNames('secret-art'), 41),
    fallbackLines: shuffled(reportNames('secret-fb'), 43),
  });
  const again = runManifest(reordered, [
    '--',
    ...MANIFEST_ARGV.slice(2),
    ...MANIFEST_ARGV.slice(0, 2),
  ]);
  assert.equal(again.exitCode, 0);
  assert.equal(again.output, match.output);

  // The same bytes through explicit absolute paths print the same comparison.
  const explicit = runRetrievalComparisonCli({
    argv: [
      '--artifacts',
      ...reportNames('secret-art').map((name) => `/runs/art/${name}`),
      '--fallback',
      ...reportNames('secret-fb').map((name) => `/runs/fb/${name}`),
    ],
    ...fs.options,
  });
  assert.equal(explicit.output, match.output);

  const different = runManifest(manifestFs(cohort(), cohort({ 44: { second: 45 } })));
  assert.equal(different.exitCode, 1);
  assert.match(different.output, /^comparison: slots_compared=59 identical=58 different=1$/m);
  assert.match(different.output, /^COMPARISON: DIFFERENT$/m);
  assertSafeOutput(different.output, ['secret', 'runs', '44']);

  const crlf = reportText(12).replaceAll('\n', `${CR}\n`);
  const rejected = runManifest(manifestFs(cohort({ 12: crlf }), cohort()));
  assert.equal(rejected.exitCode, 1);
  assert.match(
    rejected.output,
    /^artifacts cohort: REJECTED inputs=59 read=59 accounting=INCOMPLETE$/m,
  );
  assert.match(rejected.output, /^COMPARISON: REJECTED$/m);
  assertSafeOutput(rejected.output, ['secret', 'runs']);
});

test('cli manifests: a manifest failure on either side exits 2 with zero report reads', () => {
  const lines = reportNames('secret-x');
  const text = manifestOf(lines).toString('utf8');
  const bad = {
    missingFinalLf: [Buffer.from(text.slice(0, -1)), MANIFEST_PROBLEM.finalNewline],
    crlf: [Buffer.from(text.replaceAll('\n', `${CR}\n`)), MANIFEST_PROBLEM.carriageReturn],
    bom: [Buffer.concat([BOM_BYTES, manifestOf(lines)]), MANIFEST_PROBLEM.bom],
    notUtf8: [
      Buffer.concat([manifestOf(lines.slice(1)), Buffer.from([0xc3, 0x0a])]),
      MANIFEST_PROBLEM.notUtf8,
    ],
    nul: [manifestOf([...lines.slice(1), `secret${NUL}.bin`]), MANIFEST_PROBLEM.control],
    blank: [manifestOf([...lines.slice(1), '']), MANIFEST_PROBLEM.blankLine],
    optionLike: [manifestOf([...lines.slice(1), '--secret']), MANIFEST_PROBLEM.optionLike],
    url: [
      manifestOf([...lines.slice(1), 'https://secret.invalid/x']),
      MANIFEST_PROBLEM.notPlainPath,
    ],
    tooFew: [manifestOf(lines.slice(1)), MANIFEST_PROBLEM.lineCount],
    tooMany: [manifestOf([...lines, 'reports/secret-extra.bin']), MANIFEST_PROBLEM.lineCount],
    overlong: [manifestOf([...lines.slice(1), 's'.repeat(1025)]), MANIFEST_PROBLEM.entryTooLong],
  };
  const expectFailure = (fs, side, problem, name) => {
    const result = runManifest(fs);
    assert.equal(result.exitCode, 2, `${name} on ${side}`);
    const outputLines = result.output.split('\n');
    assert.equal(outputLines[0], `${side} manifest: ${problem}`, `${name} on ${side}`);
    assert.match(outputLines[1], /^usage: /);
    assert.equal(outputLines.length, 3);
    assert.deepEqual(fs.reportCalls(), [], `${name}: no report is checked or read`);
    assert.ok(
      !/secret|runs|list\.txt|ENOENT|work|sss/.test(result.output),
      `${name}: nothing echoed`,
    );
    return fs;
  };
  for (const side of ['artifacts', 'fallback']) {
    const path = side === 'artifacts' ? '/runs/art/list.txt' : '/runs/fb/list.txt';
    for (const [name, [bytes, problem]] of Object.entries(bad)) {
      expectFailure(
        manifestFs(cohort(), cohort(), { manifests: { [side]: bytes } }),
        side,
        problem,
        name,
      );
    }
    // Oversized or unknown size: the manifest itself is never read.
    for (const size of [MAX_RETRIEVAL_MANIFEST_BYTES + 1, Number.NaN]) {
      const big = expectFailure(
        manifestFs(cohort(), cohort(), { manifestSizes: { [path]: size } }),
        side,
        MANIFEST_PROBLEM.tooLarge,
        `size ${size}`,
      );
      assert.ok(!big.calls.some(([kind, called]) => kind === 'manifest-read' && called === path));
    }
    // Grown between the size check and the read: rejected on the bytes actually read.
    expectFailure(
      manifestFs(cohort(), cohort(), {
        manifests: { [side]: Buffer.alloc(MAX_RETRIEVAL_MANIFEST_BYTES + 1, 0x61) },
        manifestSizes: { [path]: 10 },
      }),
      side,
      MANIFEST_PROBLEM.tooLarge,
      'grown',
    );
    expectFailure(
      manifestFs(cohort(), cohort(), { errors: new Set([path]) }),
      side,
      MANIFEST_PROBLEM.unreadable,
      'unreadable',
    );
  }
});

test('cli manifests: duplicates and shared paths are refused after resolution, before any report read', () => {
  const art = reportNames('secret-art');
  const fb = reportNames('secret-fb');
  const cases = [
    ['duplicate line', { artifactLines: [...art.slice(1), art[5]] }, USAGE_ERROR.duplicatePath],
    [
      'duplicate spelling',
      { fallbackLines: [...fb.slice(1), `x/../${fb[9]}`] },
      USAGE_ERROR.duplicatePath,
    ],
    [
      'shared absolute',
      { fallbackLines: [...fb.slice(1), `/runs/art/${art[0]}`] },
      USAGE_ERROR.sharedPath,
    ],
    [
      'shared relative',
      { fallbackLines: [...fb.slice(1), `../art/${art[2]}`] },
      USAGE_ERROR.sharedPath,
    ],
  ];
  for (const [name, options, reason] of cases) {
    const fs = manifestFs(cohort(), cohort(), options);
    const result = runManifest(fs);
    assert.equal(result.exitCode, 2, name);
    assert.equal(result.output.split('\n')[0], reason, name);
    assert.deepEqual(fs.reportCalls(), [], name);
    assert.ok(!/secret|runs/.test(result.output));
  }

  // Windows spellings that name one file collide under the win32 policy only.
  const winLines = (prefix, first) => [
    first,
    ...Array.from({ length: 58 }, (_, i) => `${prefix}\\r-${i}.bin`),
  ];
  const manifests = {
    art: manifestOf(winLines('art', 'C:\\Evidence\\Secret.bin')),
    fb: manifestOf(winLines('fb', 'c:/evidence/SECRET.BIN.')),
  };
  const pick = (path) => (/art/i.test(path) ? manifests.art : manifests.fb);
  for (const [platform, cwd, argv, expected] of [
    [
      'win32',
      'C:\\work',
      [
        '--artifacts-manifest',
        'C:\\runs\\art\\list.txt',
        '--fallback-manifest',
        'C:\\runs\\fb\\list.txt',
      ],
      2,
    ],
    [
      'linux',
      '/work',
      ['--artifacts-manifest', '/runs/art/list.txt', '--fallback-manifest', '/runs/fb/list.txt'],
      1,
    ],
  ]) {
    const reads = [];
    const result = runRetrievalComparisonCli({
      argv,
      platform,
      cwd,
      sizeOf: (path) => reads.push(path) && 10,
      readBytes: (path) => reads.push(path) && Buffer.alloc(0),
      manifestSizeOf: (path) => pick(path).length,
      readManifestBytes: (path) => pick(path),
    });
    assert.equal(result.exitCode, expected, platform);
    if (platform === 'win32') {
      assert.equal(result.output.split('\n')[0], USAGE_ERROR.sharedPath);
      assert.deepEqual(reads, []);
    } else {
      // Case-sensitive: distinct paths, so reports are read (and here rejected as unreadable).
      assert.match(result.output, /^COMPARISON: REJECTED$/m);
      assert.equal(reads.length, 118 * 2);
    }
    assert.ok(!/secret|evidence|runs/i.test(result.output));
  }
});

test('cli manifests: option errors exit 2 before any manifest or report access', () => {
  const a = Array.from({ length: 59 }, (_, i) => `secret-a-${i}.txt`);
  const m1 = 'secret-m1';
  const m2 = 'secret-m2';
  const cases = [
    [['--artifacts-manifest', m1], USAGE_ERROR.missingManifest],
    [['--fallback-manifest', m2], USAGE_ERROR.missingManifest],
    [['--artifacts-manifest', m1, '--fallback', ...a], USAGE_ERROR.mixedModes],
    [['--artifacts', ...a, '--fallback-manifest', m2], USAGE_ERROR.mixedModes],
    [['--fallback-manifest', m2, '--artifacts', ...a], USAGE_ERROR.mixedModes],
    [
      ['--artifacts-manifest', m1, '--artifacts-manifest', 'secret-m3', '--fallback-manifest', m2],
      USAGE_ERROR.repeatedOption,
    ],
    [['--artifacts-manifest', m1, '--fallback-manifest'], USAGE_ERROR.manifestValue],
    [['--artifacts-manifest', '--fallback-manifest', m2], USAGE_ERROR.manifestValue],
    [['--artifacts-manifest', '', '--fallback-manifest', m2], USAGE_ERROR.manifestValue],
    [['--artifacts-manifest', '-secret', '--fallback-manifest', m2], USAGE_ERROR.manifestValue],
    [
      ['--artifacts-manifest', m1, 'secret-extra', '--fallback-manifest', m2],
      USAGE_ERROR.extraArgument,
    ],
    [
      ['--artifacts-manifest', m1, '--fallback-manifest', m2, 'secret-extra'],
      USAGE_ERROR.extraArgument,
    ],
    [['--artifacts-manifest=secret-m1', '--fallback-manifest', m2], USAGE_ERROR.inlineValue],
    [['--artifacts-manifest', m1, '--fallback-manifest=secret-m2'], USAGE_ERROR.inlineValue],
    [['--artifacts-manifests', m1, '--fallback-manifest', m2], USAGE_ERROR.unknownOption],
    [['--artifacts-manifest', m1, '--', '--fallback-manifest', m2], USAGE_ERROR.lateSeparator],
    [
      ['--artifacts-manifest', 'secret-m', '--fallback-manifest', './secret-m'],
      USAGE_ERROR.sharedManifest,
    ],
    [
      ['--artifacts-manifest', 's'.repeat(1025), '--fallback-manifest', m2],
      USAGE_ERROR.pathTooLong,
    ],
  ];
  for (const [argv, reason] of cases) {
    const calls = [];
    const record = (path) => calls.push(path) && 10;
    const result = runRetrievalComparisonCli({
      argv,
      platform: 'linux',
      cwd: '/work',
      sizeOf: record,
      readBytes: record,
      manifestSizeOf: record,
      readManifestBytes: record,
    });
    assert.equal(result.exitCode, 2, JSON.stringify(argv.slice(0, 2)));
    assert.equal(result.output.split('\n')[0], reason, JSON.stringify(argv.slice(0, 2)));
    assert.equal(calls.length, 0);
    assert.ok(!/secret|sss/.test(result.output));
  }
  const winShared = parseComparisonArgs(
    ['--artifacts-manifest', 'D:\\Runs\\List.txt', '--fallback-manifest', 'd:/runs/list.TXT'],
    { platform: 'win32', cwd: 'C:\\work' },
  );
  assert.equal(winShared.ok, false);
  assert.equal(winShared.output.split('\n')[0], USAGE_ERROR.sharedManifest);
  assert.deepEqual(
    parseComparisonArgs(['--fallback-manifest', 'f.txt', '--artifacts-manifest', 'a.txt'], {
      platform: 'linux',
      cwd: '/work',
    }),
    { ok: true, mode: 'manifest', manifests: { artifacts: 'a.txt', fallback: 'f.txt' } },
  );
});

// ---------------------------------------------------------------------------
// The package command in manifest mode, over long real paths

test('cli (spawned package command): manifests carry 118 long paths; MATCH, DIFFERENT, exit 2; nothing written', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const [program, script, ...rest] =
    pkg.scripts['compare:aggregation-campaign-retrievals'].split(' ');
  assert.equal(program, 'node');
  assert.deepEqual(rest, []);
  const scriptPath = join(repoRoot, script);

  const root = mkdtempSync(join(tmpdir(), 'aggregation-campaign-retrieval-manifest-test-'));
  temporaryDirs.push(root);
  assert.ok(!resolve(root).startsWith(repoRoot));
  const segment = (label) => `${label}-${'long-directory-segment-'.repeat(5)}`.slice(0, 90);
  const artifactDir = join(root, segment('downloaded-artifacts'));
  const fallbackDir = join(root, segment('materialized-fallback'));
  const callerDir = join(root, 'caller');
  for (const dir of [artifactDir, fallbackDir, callerDir]) mkdirSync(dir);

  const artifactPaths = cohort().map((bytes, i) => {
    const path = join(artifactDir, `private-artifact-report-${String(i).padStart(2, '0')}.txt`);
    writeFileSync(path, bytes);
    return path;
  });
  const fallbackNames = shuffled(cohort(), 31).map((bytes, i) => {
    const name = `private-recovered-report-${String(58 - i).padStart(2, '0')}.txt`;
    writeFileSync(join(fallbackDir, name), bytes);
    return name;
  });
  const fallbackPaths = fallbackNames.map((name) => join(fallbackDir, name));
  for (const path of [...artifactPaths, ...fallbackPaths]) {
    assert.ok(path.length < 250, 'each path stays under the classic Windows MAX_PATH');
  }
  const individually = [...artifactPaths, ...fallbackPaths].reduce(
    (total, path) => total + path.length + 3,
    0,
  );
  assert.ok(individually > 8191, 'passed one by one, the paths exceed the cmd.exe limit');

  // Absolute lines for the artifacts; lines relative to the manifest's directory for the fallback.
  const artifactManifest = join(root, 'artifacts.manifest');
  const fallbackManifest = join(fallbackDir, 'fallback.manifest');
  const malformedManifest = join(root, 'malformed.manifest');
  writeFileSync(artifactManifest, manifestOf(shuffled(artifactPaths, 17)));
  writeFileSync(fallbackManifest, manifestOf(fallbackNames));
  writeFileSync(
    malformedManifest,
    Buffer.from(manifestOf(fallbackNames).toString('utf8').replaceAll('\n', `${CR}\n`)),
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
    });
    assert.deepEqual(snapshot(), around, 'the run created, removed or changed nothing');
    assert.equal(result.stderr, '');
    return result;
  };
  const leaks = [root, 'private', 'long-directory', '.manifest', repoRoot, 'caller'];

  const match = run([
    '--',
    '--artifacts-manifest',
    artifactManifest,
    '--fallback-manifest',
    fallbackManifest,
  ]);
  assert.equal(match.status, 0, match.stdout);
  assert.match(
    match.stdout,
    /^comparison: slots_compared=59 identical=59 different=0\nCOMPARISON: MATCH$/m,
  );
  assertSafeOutput(match.stdout, leaks);

  // Explicit paths still work when passed directly, with no cmd.exe in between, and agree.
  const explicit = run(['--artifacts', ...artifactPaths, '--fallback', ...fallbackPaths]);
  assert.equal(explicit.status, 0);
  assert.equal(explicit.stdout, match.stdout);

  const target = fallbackPaths[20];
  const original = readFileSync(target);
  const at = original.indexOf('.000Z') - 1;
  writeFileSync(target, flipByte(original, at, original[at] === 0x39 ? -1 : 1));
  const different = run([
    '--fallback-manifest',
    fallbackManifest,
    '--artifacts-manifest',
    artifactManifest,
  ]);
  assert.equal(different.status, 1);
  assert.match(
    different.stdout,
    /^comparison: slots_compared=59 identical=58 different=1\nCOMPARISON: DIFFERENT$/m,
  );
  assertSafeOutput(different.stdout, leaks);
  writeFileSync(target, original);

  const malformed = run([
    '--artifacts-manifest',
    artifactManifest,
    '--fallback-manifest',
    malformedManifest,
  ]);
  assert.equal(malformed.status, 2);
  assert.equal(
    malformed.stdout.split('\n')[0],
    `fallback manifest: ${MANIFEST_PROBLEM.carriageReturn}`,
  );
  for (const leak of leaks) assert.ok(!malformed.stdout.includes(leak));

  const restored = run([
    '--artifacts-manifest',
    artifactManifest,
    '--fallback-manifest',
    fallbackManifest,
  ]);
  assert.equal(restored.status, 0);
  assert.equal(restored.stdout, match.stdout);
});
