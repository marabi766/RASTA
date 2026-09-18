/**
 * Offline, reference-free recovery of calibration reports from job-log text.
 *
 * Every report is rendered by the real `formatCalibrationReport` from real
 * summaries, then wrapped in **synthetic** log framing modelled on
 * launch-readiness § 2.5. None of this is a demonstration on an actual GitHub
 * multi-job run: nothing here downloads, reads or imitates a real archive
 * beyond that documented prefix. No Docker, PostgreSQL, GitHub or network;
 * files live only in temporary directories removed afterwards.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CAMPAIGN_SLOT_COUNT,
  SLOT_STATE,
  accountCampaign,
  formatAccounting,
  parseSlotReport,
} from './aggregation-campaign-accounting-lib.mjs';
import { runAccountingCli } from './aggregation-campaign-accounting.mjs';
import { COHORT_MANIFEST_SCHEMA } from './aggregation-campaign-image-cohort-lib.mjs';
import { runImageCohortCli } from './aggregation-campaign-image-cohort.mjs';
import {
  CALIBRATION_REPORT_FOOTER,
  CALIBRATION_REPORT_HEADER,
  LAUNCHER,
  PROCESS_OUTCOME,
  calibrationProbeId,
  calibrationStressId,
  formatCalibrationReport,
  sealProbeOutcome,
  summarizeCalibration,
  summarizeJestRun,
} from './aggregation-evidence-lib.mjs';
import {
  LOG_RECOVERY_LIMITS,
  MATERIALIZATION_CLEANUP,
  MATERIALIZATION_REASON,
  RECOVERY_REASON,
  extractReportCandidates,
  formatMaterialization,
  formatRecovery,
  planReportFiles,
  recoverAndAccount,
  recoverCalibrationReports,
  reportFileName,
} from './aggregation-campaign-log-recovery-lib.mjs';
import {
  STAGING_PREFIX,
  USAGE_ERROR,
  logsManifestCountProblem,
  materializeReportFiles,
  parseRecoveryArgs,
  runLogRecoveryCli,
} from './aggregation-campaign-log-recovery.mjs';
import {
  MAX_REPORT_MANIFEST_BYTES,
  PATH_MANIFEST_PROBLEM,
  REPORT_MANIFEST_PROBLEM,
  loadPathManifest,
  parsePathManifest,
  parseReportManifest,
  pathManifestMaxBytes,
} from './aggregation-campaign-report-manifest-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const CLI = join(here, 'aggregation-campaign-log-recovery.mjs');

const temporaryDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'aggregation-campaign-log-recovery-test-'));
  temporaryDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);
const BOM = String.fromCharCode(0xfeff);

// ---------------------------------------------------------------------------
// Reports rendered by the real harness code

const COMMIT = 'c'.repeat(40);
const TOPOLOGY = Object.freeze({
  runner_os: '"Ubuntu 24.04.5 LTS"',
  runner_image: 'ubuntu24/20260907.300.1',
  kernel: '6.17.0-1022-azure',
  cpus: 4,
  memory_gib: '15.6',
  postgres_image: 'postgis/postgis:16-3.4',
  server_version: '16.4',
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
const summaryFor = (messages = []) => {
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

const report = (slot, { kind = 'pass', commit = COMMIT, topology = TOPOLOGY } = {}) =>
  formatCalibrationReport({
    meta: {
      commit,
      generatedAt: `2026-09-16T01:00:${String(slot % 60).padStart(2, '0')}.000Z`,
      campaignSlot: slot,
    },
    topology,
    summary: summaryFor({ pass: [], event: [ENV_57014], product: [PRODUCT] }[kind]),
  });

// ---------------------------------------------------------------------------
// Synthetic job-log framing (launch-readiness § 2.5 prefix; not a real archive)

const stamp = (index) =>
  `2026-09-16T02:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(
    index % 60,
  ).padStart(2, '0')}.${String(1234567 + index).slice(-7)}Z `;

/** The report as the harness logs it (`log(\`\n${text}\`)`) amid unrelated job output. */
function jobLog(text, { prefixed = false, crlf = false, slot = 1, red = false } = {}) {
  const before = [
    '##[group]Run pnpm run calibrate:aggregation-stress -- --pairs 1 --slot "7"',
    `${ESC}[36;1mpnpm run calibrate:aggregation-stress${ESC}[0m`,
    '##[endgroup]',
    `[evidence] calibration: 1 pair(s); slot ${slot}; No threshold is applied.`,
    '',
  ];
  const afterLines = [
    `campaign_exit=${red ? 1 : 0}`,
    ...(red ? ['##[error]Process completed with exit code 1.'] : []),
    'Post job cleanup.',
  ];
  const lines = [...before, ...text.slice(0, -1).split('\n'), ...afterLines];
  const eol = crlf ? '\r\n' : '\n';
  return lines.map((line, index) => (prefixed ? stamp(index) : '') + line + eol).join('');
}

const recover = (texts, options) =>
  recoverCalibrationReports(
    texts.map((text) => ({ text })),
    options,
  );

const rejectionOf = (text) => {
  const extracted = extractReportCandidates(text);
  assert.equal(extracted.ok, false, 'expected the log to be rejected');
  return extracted.reason;
};

/** Replaces exactly one occurrence, so a mutation cannot silently miss. */
function mutate(text, from, to) {
  const first = text.indexOf(from);
  assert.ok(first >= 0, `anchor not found: ${from.slice(0, 50)}`);
  assert.equal(text.indexOf(from, first + 1), -1, `anchor not unique: ${from.slice(0, 50)}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
}

const fullCampaignLogs = (options = {}) =>
  Array.from({ length: CAMPAIGN_SLOT_COUNT }, (_, index) => {
    const slot = index + 1;
    return jobLog(report(slot), {
      slot,
      prefixed: slot % 2 === 0,
      crlf: slot % 3 === 0,
      ...options,
    });
  });

// ---------------------------------------------------------------------------
// Exact recovery

test('recovery is byte-exact from plain LF and from timestamp-prefixed CRLF logs', () => {
  const text = report(7);
  for (const framing of [
    { prefixed: false, crlf: false },
    { prefixed: true, crlf: true },
    { prefixed: true, crlf: false },
    { prefixed: false, crlf: true },
  ]) {
    const log = jobLog(text, framing);
    const extracted = extractReportCandidates(log);
    assert.deepEqual(extracted, { ok: true, candidates: [text] }, JSON.stringify(framing));
  }
  // Leading spaces, blank lines and the non-ASCII footer survive untouched.
  assert.ok(text.includes('\n  probe: '));
  assert.ok(text.includes('\n\n'));
  assert.ok(CALIBRATION_REPORT_FOOTER.includes('§'));
});

test('unrelated text outside a report, including ANSI colour, is ignored', () => {
  const text = report(3);
  const noisy = `${ESC}[31mred noise${ESC}[0m\nsomething: else\n${jobLog(text)}${NUL} trailing control noise\n`;
  assert.deepEqual(extractReportCandidates(noisy), { ok: true, candidates: [text] });
});

test('no reference line count: reports of different lengths recover by boundary alone', () => {
  const pass = report(1);
  const event = report(2, { kind: 'event' });
  assert.notEqual(pass.split('\n').length, event.split('\n').length);
  const log = jobLog(pass) + jobLog(event, { red: true });
  assert.deepEqual(extractReportCandidates(log), { ok: true, candidates: [pass, event] });
  const source = readFileSync(join(here, 'aggregation-campaign-log-recovery-lib.mjs'), 'utf8');
  assert.ok(!/\b170\b/.test(source), 'no line count from the earlier reference slice');
  assert.ok(!source.includes('docs/evidence'), 'no reference artifact is read');
});

test('multiple reports across multiple logs feed the unchanged accounting', () => {
  const logs = [jobLog(report(1)) + jobLog(report(2), { prefixed: true }), jobLog(report(3))];
  const recovery = recover(logs);
  assert.equal(recovery.clean, true);
  assert.deepEqual(recovery.reports, [report(1), report(2), report(3)].sort());
  const direct = accountCampaign([report(1), report(2), report(3)].map((text) => ({ text })));
  const { accounting, exitCode } = recoverAndAccount(logs.map((text) => ({ text })));
  assert.equal(formatAccounting(accounting), formatAccounting(direct));
  assert.equal(accounting.complete, false, 'three slots are not a campaign');
  assert.equal(accounting.totals.missing, 56);
  assert.equal(exitCode, 1);
});

test('all 59 slots from a synthetic multi-log fixture account complete; order is irrelevant', () => {
  const logs = fullCampaignLogs();
  const result = recoverAndAccount(logs.map((text) => ({ text })));
  assert.equal(result.recovery.clean, true);
  assert.equal(result.recovery.reports.length, CAMPAIGN_SLOT_COUNT);
  assert.equal(result.accounting.complete, true);
  assert.equal(result.accounting.totals.nonEvents, CAMPAIGN_SLOT_COUNT);
  assert.equal(result.exitCode, 0);
  const text = formatRecovery(result);
  assert.match(text, /recovery: logs=59 readable_logs=59 recovered_reports=59 rejections=0/);
  assert.match(text, /accounting: COMPLETE/);
  assert.match(text, /RESULT: PASS\n$/);

  const reversed = recoverAndAccount([...logs].reverse().map((text) => ({ text })));
  assert.equal(formatRecovery(reversed), text);
  assert.deepEqual(
    reversed.recovery.reports,
    result.recovery.reports,
    'recovered multiset is sorted',
  );
  const rotated = recoverAndAccount(
    [...logs.slice(30), ...logs.slice(0, 30)].map((text) => ({ text })),
  );
  assert.equal(formatRecovery(rotated), text);
});

test('red event reports recover exactly like passing reports', () => {
  const logs = fullCampaignLogs();
  logs[10] = jobLog(report(11, { kind: 'event' }), { prefixed: true, crlf: true, red: true });
  const result = recoverAndAccount(logs.map((text) => ({ text })));
  assert.equal(result.recovery.clean, true);
  assert.ok(result.recovery.reports.includes(report(11, { kind: 'event' })));
  assert.equal(result.accounting.slots[10].state, SLOT_STATE.event);
  assert.equal(result.accounting.complete, true, 'an event is data, not a blocker');
  assert.equal(result.exitCode, 0);

  logs[11] = jobLog(report(12, { kind: 'product' }), { red: true });
  const blocked = recoverAndAccount(logs.map((text) => ({ text })));
  assert.equal(blocked.recovery.clean, true);
  assert.equal(blocked.accounting.slots[11].state, SLOT_STATE.blocker);
  assert.equal(blocked.exitCode, 1);
});

// ---------------------------------------------------------------------------
// Framing failures

test('boundary, nesting and termination defects reject the whole log', () => {
  const text = report(5);
  const plain = jobLog(text);
  const footerless = mutate(plain, `${CALIBRATION_REPORT_FOOTER}\n`, '');
  assert.equal(rejectionOf(footerless), RECOVERY_REASON.unterminated, 'missing footer');
  assert.equal(
    rejectionOf(`${CALIBRATION_REPORT_FOOTER}\n${plain}`),
    RECOVERY_REASON.orphanFooter,
    'orphan footer',
  );
  assert.equal(
    rejectionOf(
      mutate(plain, 'campaign_slot=5\n', `campaign_slot=5\n${CALIBRATION_REPORT_HEADER}\n`),
    ),
    RECOVERY_REASON.nestedHeader,
    'nested header',
  );
  assert.equal(
    rejectionOf(jobLog(text) + jobLog(text).split(CALIBRATION_REPORT_FOOTER)[0]),
    RECOVERY_REASON.unterminated,
    'second report cut before its footer',
  );
  assert.equal(
    rejectionOf(mutate(plain, CALIBRATION_REPORT_HEADER, `${CALIBRATION_REPORT_HEADER} `)),
    RECOVERY_REASON.boundaryFraming,
    'changed header',
  );
  assert.equal(
    rejectionOf(mutate(plain, CALIBRATION_REPORT_HEADER, 'ADR-055 paired calibration - probe')),
    RECOVERY_REASON.orphanFooter,
    'header text changed beyond recognition',
  );
  assert.equal(
    rejectionOf(mutate(plain, CALIBRATION_REPORT_FOOTER, CALIBRATION_REPORT_FOOTER.slice(0, -1))),
    RECOVERY_REASON.unterminated,
    'changed footer',
  );
  assert.equal(
    rejectionOf(
      `${plain.slice(0, plain.indexOf(CALIBRATION_REPORT_FOOTER))}${CALIBRATION_REPORT_FOOTER}`,
    ),
    RECOVERY_REASON.truncatedFraming,
    'log ends on the footer without a terminator',
  );
  assert.equal(
    rejectionOf(plain.slice(0, plain.indexOf('pair-1:') + 3)),
    RECOVERY_REASON.truncatedFraming,
    'log truncated mid-line',
  );
  assert.equal(
    rejectionOf(plain.slice(0, plain.indexOf('pair-1:'))),
    RECOVERY_REASON.unterminated,
    'log truncated at a line boundary',
  );
  assert.equal(rejectionOf('just job output\n'), RECOVERY_REASON.noReport, 'no report');
  assert.equal(rejectionOf(''), RECOVERY_REASON.empty, 'empty');
});

test('timestamp framing is exact, consistent and never mixed', () => {
  const text = report(9);
  const prefixed = jobLog(text, { prefixed: true, crlf: true });
  const lineWith = (log, needle) => log.split('\n').find((line) => line.includes(needle));
  const slotLine = lineWith(prefixed, 'campaign_slot=9');
  const body = slotLine.slice(29);

  const withSlotLine = (replacement) => mutate(prefixed, slotLine, replacement);
  assert.equal(
    rejectionOf(withSlotLine(`2026-09-16T02:00:08.123Z ${body}`)),
    RECOVERY_REASON.malformedTimestamp,
    'three fractional digits',
  );
  assert.equal(
    rejectionOf(withSlotLine(`2026-13-16T02:00:08.1234567Z ${body}`)),
    RECOVERY_REASON.malformedTimestamp,
    'month 13',
  );
  assert.equal(
    rejectionOf(withSlotLine(`2026-09-16T25:00:08.1234567Z ${body}`)),
    RECOVERY_REASON.malformedTimestamp,
    'hour 25',
  );
  assert.equal(
    rejectionOf(withSlotLine(`2026-09-16T02:00:08.1234567Z${body}`)),
    RECOVERY_REASON.malformedTimestamp,
    'no separating space',
  );
  assert.equal(
    rejectionOf(withSlotLine(`[2026-09-16T02:00:08.1234567Z] ${body}`)),
    RECOVERY_REASON.unprefixedInTimestamped,
    'timestamp-like arbitrary prefix',
  );
  assert.equal(
    rejectionOf(withSlotLine(`${body}\r`)),
    RECOVERY_REASON.unprefixedInTimestamped,
    'unprefixed line in a prefixed report',
  );
  assert.equal(
    rejectionOf(withSlotLine(`2026-09-16T02:00:08.1234567Z 2026-09-16T02:00:08.1234567Z ${body}`)),
    RECOVERY_REASON.repeatedTimestamp,
    'double prefix',
  );

  const plain = jobLog(text);
  assert.equal(
    rejectionOf(
      mutate(plain, 'campaign_slot=9\n', '2026-09-16T02:00:08.1234567Z campaign_slot=9\n'),
    ),
    RECOVERY_REASON.timestampInPlain,
    'prefixed line in a plain report',
  );
  const headerLine = lineWith(prefixed, CALIBRATION_REPORT_HEADER);
  assert.equal(
    rejectionOf(
      mutate(prefixed, headerLine, `2026-09-16T02:00:08.123Z ${CALIBRATION_REPORT_HEADER}\r`),
    ),
    RECOVERY_REASON.boundaryFraming,
    'header behind a timestamp-like prefix',
  );
  assert.equal(
    rejectionOf(mutate(prefixed, headerLine, `${CALIBRATION_REPORT_HEADER}\r`)),
    RECOVERY_REASON.timestampInPlain,
    'unprefixed header followed by prefixed lines',
  );
  assert.equal(
    rejectionOf(mutate(prefixed, `${slotLine}\n`, `${slotLine.slice(0, -1)}\n`)),
    RECOVERY_REASON.mixedLineEndings,
    'CRLF and LF mixed inside a report',
  );
});

test('control characters inside a report are rejected, never stripped', () => {
  const text = report(4);
  const plain = jobLog(text);
  for (const [label, injected] of [
    ['ANSI colour', `${ESC}[32mcampaign_slot=4${ESC}[0m\n`],
    ['NUL', `campaign_slot=4${NUL}\n`],
    ['tab', 'campaign_slot=4\t\n'],
    ['bare CR', 'campaign_slot=4\rx\n'],
    ['BOM', `${BOM}campaign_slot=4\n`],
  ]) {
    assert.equal(
      rejectionOf(mutate(plain, 'campaign_slot=4\n', injected)),
      RECOVERY_REASON.control,
      label,
    );
  }
  assert.equal(
    rejectionOf(mutate(plain, CALIBRATION_REPORT_HEADER, `${ESC}[1m${CALIBRATION_REPORT_HEADER}`)),
    RECOVERY_REASON.boundaryFraming,
    'ANSI on the header',
  );
});

// ---------------------------------------------------------------------------
// Limits

test('limits reject, never truncate', () => {
  const small = { ...LOG_RECOVERY_LIMITS };
  const log = jobLog(report(1));
  const bytes = Buffer.byteLength(log, 'utf8');

  assert.deepEqual(recover([log], { limits: { ...small, maxLogBytes: bytes - 1 } }).rejections, {
    [RECOVERY_REASON.logTooLarge]: 1,
  });
  const total = recover([log, jobLog(report(2))], { limits: { ...small, maxTotalBytes: bytes } });
  assert.deepEqual(total.rejections, { [RECOVERY_REASON.totalTooLarge]: 1 });
  assert.deepEqual(total.reports, []);

  const lines = report(1).split('\n').length - 1;
  assert.equal(
    extractReportCandidates(log, { ...small, maxCandidateLines: lines - 1 }).reason,
    RECOVERY_REASON.candidateLines,
  );
  assert.equal(extractReportCandidates(log, { ...small, maxCandidateLines: lines }).ok, true);
  assert.equal(
    extractReportCandidates(log, { ...small, maxCandidateBytes: 1024 }).reason,
    RECOVERY_REASON.candidateBytes,
  );
  // A header with no footer followed by a huge log stops at the line limit.
  const runaway = `${CALIBRATION_REPORT_HEADER}\n${'noise\n'.repeat(1000)}`;
  assert.equal(extractReportCandidates(runaway).reason, RECOVERY_REASON.candidateLines);

  const tooManyLogs = recover([log, log, log], { limits: { ...small, maxLogs: 2 } });
  assert.deepEqual(tooManyLogs.rejections, { [RECOVERY_REASON.tooManyLogs]: 1 });
  assert.deepEqual(tooManyLogs.reports, []);

  const sixty = [...fullCampaignLogs(), jobLog(report(1))];
  const tooManyReports = recover(sixty);
  assert.deepEqual(tooManyReports.rejections, { [RECOVERY_REASON.tooManyReports]: 1 });
  assert.deepEqual(tooManyReports.reports, [], 'no subset of 59 is kept');

  assert.deepEqual(recover([]).rejections, { [RECOVERY_REASON.noLogs]: 1 });
  assert.equal(LOG_RECOVERY_LIMITS.maxReports, CAMPAIGN_SLOT_COUNT);
  assert.ok(Object.isFrozen(LOG_RECOVERY_LIMITS));
});

// ---------------------------------------------------------------------------
// Validation and accounting failures

test('recovered text must pass the strict slot-report parser', () => {
  const edited = mutate(
    jobLog(report(6)),
    'stress: passed=1 failed=0 of 1',
    'stress: passed=2 failed=0 of 1',
  );
  const recovery = recover([edited]);
  assert.equal(recovery.clean, false);
  assert.deepEqual(recovery.reports, []);
  assert.equal(Object.keys(recovery.rejections).length, 1);
  assert.match(Object.keys(recovery.rejections)[0], /^recovered report does not parse: /);

  const cases = [
    ['missing slot', mutate(jobLog(report(6)), 'campaign_slot=6\n', '')],
    ['out-of-range slot', mutate(jobLog(report(6)), 'campaign_slot=6\n', 'campaign_slot=60\n')],
    ['zero slot', mutate(jobLog(report(6)), 'campaign_slot=6\n', 'campaign_slot=0\n')],
    ['dropped line', mutate(jobLog(report(6)), 'outcomes: VALID=1 INVALID=0 INCONCLUSIVE=0\n', '')],
    ['malformed commit', mutate(jobLog(report(6)), `commit=${COMMIT}`, 'commit=abc')],
    ['two-pair claim', mutate(jobLog(report(6)), 'pairs: 1;', 'pairs: 2;')],
  ];
  for (const [label, log] of cases) {
    const result = recover([log]);
    assert.equal(result.clean, false, label);
    assert.deepEqual(result.reports, [], label);
    assert.match(Object.keys(result.rejections)[0], /^recovered report does not parse: /, label);
  }

  const others = fullCampaignLogs().filter((_, index) => index !== 5);
  const mixed = recoverAndAccount([{ text: edited }, ...others.map((text) => ({ text }))]);
  assert.equal(mixed.recovery.reports.length, 58);
  assert.equal(mixed.accounting.slots[5].state, SLOT_STATE.missing);
  assert.equal(mixed.exitCode, 1);
});

test('duplicate slots and provenance mismatches stay accounting failures', () => {
  const logs = fullCampaignLogs();
  logs[1] = jobLog(report(1));
  const duplicate = recoverAndAccount(logs.map((text) => ({ text })));
  assert.equal(duplicate.recovery.clean, true);
  assert.equal(duplicate.accounting.slots[0].state, SLOT_STATE.missing);
  assert.match(duplicate.accounting.slots[0].reason, /claimed by 2 reports/);
  assert.equal(duplicate.accounting.slots[1].state, SLOT_STATE.missing);
  assert.equal(duplicate.exitCode, 1);

  const provenance = fullCampaignLogs();
  provenance[20] = jobLog(report(21, { commit: 'd'.repeat(40) }));
  const mismatch = recoverAndAccount(provenance.map((text) => ({ text })));
  assert.equal(mismatch.recovery.clean, true);
  assert.equal(mismatch.accounting.complete, false);
  assert.match(formatRecovery(mismatch), /commit differs across reports/);
  assert.equal(mismatch.exitCode, 1);

  const topology = fullCampaignLogs();
  topology[30] = jobLog(report(31, { topology: { ...TOPOLOGY, kernel: '6.18.0-1-azure' } }));
  assert.equal(recoverAndAccount(topology.map((text) => ({ text }))).exitCode, 1);
});

test('unreadable, empty and report-free inputs make the result fail, not pass', () => {
  const logs = fullCampaignLogs().map((text) => ({ text }));
  const withUnreadable = recoverAndAccount([...logs.slice(1), { unreadable: true }]);
  assert.equal(withUnreadable.recovery.rejectedCount, 1);
  assert.equal(withUnreadable.exitCode, 1);

  for (const extra of [{ text: '' }, { text: 'job output without any report\n' }]) {
    const result = recoverAndAccount([...logs, extra]);
    assert.equal(result.accounting.complete, true, 'the 59 reports themselves still account');
    assert.equal(result.recovery.clean, false);
    assert.equal(result.exitCode, 1, 'but a log that gave nothing is a failure');
  }

  const empty = recoverAndAccount([{ text: 'nothing here\n' }]);
  const text = formatRecovery(empty);
  assert.match(text, /recovered_reports=0 rejections=1/);
  assert.match(text, /accounting: INCOMPLETE/);
  assert.match(text, /RESULT: FAIL\n$/);
});

test('diagnostics are bounded, deterministic and leak no content, timestamp or value', () => {
  const secret = 'SUPER-SECRET-TOKEN-VALUE';
  const logs = [
    {
      text: `${secret}\n${jobLog(report(2), { prefixed: true })}`.replace(
        'campaign_slot=2',
        `campaign_slot=2${ESC}`,
      ),
    },
    { text: `2026-09-16T02:00:08.1234567Z ${secret} ${CALIBRATION_REPORT_HEADER}\n` },
    { text: mutate(jobLog(report(3)), 'campaign_slot=3\n', `campaign_slot=${secret}\n`) },
    { text: `${secret}\n` },
    { unreadable: true },
  ];
  const first = formatRecovery(recoverAndAccount(logs));
  const second = formatRecovery(recoverAndAccount([...logs].reverse()));
  assert.equal(first, second);
  assert.ok(!first.includes(secret));
  assert.ok(!first.includes('2026-09-16T02:'), 'no log timestamp is echoed');
  assert.ok(!first.includes(ESC));
  const rejectionLine = first.split('\n').find((line) => line.startsWith('recovery rejections:'));
  assert.ok(rejectionLine.length < 1000);
  for (const reason of Object.values(RECOVERY_REASON)) assert.ok(reason.length <= 80);
});

// ---------------------------------------------------------------------------
// CLI

test('the CLI recovers explicit logs, prints no path, and exits 0 only for a complete campaign', () => {
  const dir = tempDir();
  const paths = fullCampaignLogs().map((text, index) => {
    const path = join(dir, `private-job-name-${index}.txt`);
    writeFileSync(path, text);
    return path;
  });
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

  const pass = run(paths);
  assert.equal(pass.status, 0, pass.stdout);
  assert.match(pass.stdout, /recovered_reports=59 rejections=0/);
  assert.match(pass.stdout, /RESULT: PASS\n$/);
  assert.equal(pass.stderr, '');
  for (const leak of [dir, 'private-job-name', repoRoot]) assert.ok(!pass.stdout.includes(leak));

  const withSeparator = run(['--', ...[...paths].reverse()]);
  assert.equal(withSeparator.status, 0);
  assert.equal(withSeparator.stdout, pass.stdout, 'order and `--` are irrelevant');

  const partial = run(paths.slice(0, 58));
  assert.equal(partial.status, 1);
  assert.match(partial.stdout, /recovered_reports=58 rejections=0/);
  assert.match(partial.stdout, /accounting: INCOMPLETE/);

  const missing = join(dir, 'private-missing-log.txt');
  const unreadable = run([...paths.slice(1), missing]);
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stdout, /log could not be read x1/);
  assert.ok(!unreadable.stdout.includes('private-missing-log'));

  const bad = join(dir, 'private-bad-log.txt');
  writeFileSync(bad, `${CALIBRATION_REPORT_FOOTER}\n`);
  const rejected = run([...paths, bad]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /report footer without a preceding header x1/);

  for (const args of [[], ['--'], ['--json'], ['--out=/private/place', ...paths]]) {
    const usage = run(args);
    assert.equal(usage.status, 2, JSON.stringify(args));
    assert.match(usage.stdout, /usage:/);
    assert.ok(!usage.stdout.includes('/private/place'));
  }
});

test('the CLI never reads an oversized log and reads only the given paths', () => {
  const read = [];
  const limits = { ...LOG_RECOVERY_LIMITS, maxLogBytes: 10, maxTotalBytes: 100 };
  const oversized = runLogRecoveryCli({
    argv: ['a/private.log'],
    sizeOf: () => 11,
    readText: (path) => {
      read.push(path);
      return '';
    },
    limits,
  });
  assert.equal(oversized.exitCode, 1);
  assert.deepEqual(read, []);
  assert.match(oversized.output, /log exceeds the recovery byte limit x1/);

  const together = runLogRecoveryCli({
    argv: Array.from({ length: 11 }, (_, i) => `b/${i}.log`),
    sizeOf: () => 10,
    readText: (path) => {
      read.push(path);
      return '';
    },
    limits,
  });
  assert.equal(together.exitCode, 1);
  assert.deepEqual(read, []);
  assert.match(together.output, /logs together exceed the recovery byte limit x1/);

  const text = jobLog(report(1));
  const given = runLogRecoveryCli({
    argv: ['c/only.log'],
    sizeOf: () => Buffer.byteLength(text),
    readText: (path) => {
      read.push(path);
      return text;
    },
  });
  assert.deepEqual(read, ['c/only.log']);
  assert.equal(given.exitCode, 1, 'one slot is not a campaign');
  assert.ok(!given.output.includes('only.log'));

  const statFails = runLogRecoveryCli({
    argv: ['d/private.log'],
    sizeOf: () => {
      throw new Error('ENOENT d/private.log');
    },
  });
  assert.equal(statFails.exitCode, 1);
  assert.ok(!statFails.output.includes('private'));
});

test('the recovery command stays outside pnpm verify, the test phases and ordinary CI', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['recover:aggregation-campaign-logs'],
    'node scripts/aggregation-campaign-log-recovery.mjs',
  );
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name === 'recover:aggregation-campaign-logs') continue;
    assert.ok(!command.includes('aggregation-campaign-log-recovery'), name);
  }
  const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(!ci.includes('aggregation-campaign-log-recovery'));
  assert.ok(!ci.includes('recover:aggregation-campaign-logs'));
});

// ---------------------------------------------------------------------------
// Opt-in materialization (`--output-dir`) — synthetic logs, temporary or fake file systems

const SLOT_NAMES = Array.from({ length: CAMPAIGN_SLOT_COUNT }, (_, index) =>
  reportFileName(index + 1),
);

/** A deterministic permutation, so "shuffled" is reproducible. */
const shuffled = (items, seed = 7) => {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/** In-memory log files for the CLI value: path → text. */
const memoryLogs = (texts, prefix = 'mem/private-log-') => {
  const files = new Map(texts.map((text, index) => [`${prefix}${index}.txt`, text]));
  return {
    paths: [...files.keys()],
    sizeOf: (path) => Buffer.byteLength(files.get(path), 'utf8'),
    readText: (path) => files.get(path),
  };
};

/** A file system adapter that records every call and allows none. */
const forbiddenFs = () => {
  const calls = [];
  const fs = new Proxy(
    {},
    {
      get: (_, name) => () => {
        calls.push(String(name));
        throw new Error('unexpected file system call');
      },
    },
  );
  return { fs, calls };
};

/** An in-memory file system with fault injection; paths are plain strings. */
class FakeFs {
  constructor({ dirs = [], files = [], links = [], faults = {} } = {}) {
    this.dirs = new Set(dirs);
    this.files = new Map(files);
    this.links = new Set(links);
    this.faults = faults;
    this.calls = [];
    this.writes = 0;
  }

  static error(code) {
    return Object.assign(new Error(code), { code });
  }

  lstat(path) {
    this.calls.push(['lstat', path]);
    const forced = this.faults.lstatError?.(path);
    if (forced) throw FakeFs.error(forced);
    let kind = null;
    if (this.links.has(path)) kind = 'link';
    else if (this.dirs.has(path)) kind = 'dir';
    else if (this.files.has(path)) kind = 'file';
    if (kind === null) throw FakeFs.error('ENOENT');
    return { isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' };
  }

  mkdtemp(prefix) {
    this.calls.push(['mkdtemp', prefix]);
    if (this.faults.mkdtempThrows) throw FakeFs.error('EACCES');
    const path = this.faults.mkdtempPath ?? `${prefix}Ab12Cd`;
    this.dirs.add(path);
    return path;
  }

  writeExclusive(path, bytes) {
    this.calls.push(['writeExclusive', path]);
    this.writes += 1;
    if (this.writes === this.faults.failWriteAt) throw FakeFs.error('EIO');
    if (this.files.has(path) || this.dirs.has(path) || this.links.has(path)) {
      throw FakeFs.error('EEXIST');
    }
    this.files.set(path, Buffer.from(bytes));
    if (this.writes === this.faults.injectEntryAfterWrite) {
      this.files.set(join(dirname(path), 'foreign.txt'), Buffer.from('not ours\n'));
    }
    if (this.writes === this.faults.targetAppearsAfterWrite) this.dirs.add(this.faults.target);
  }

  readBytes(path) {
    this.calls.push(['readBytes', path]);
    const bytes = this.files.get(path);
    if (!bytes) throw FakeFs.error('ENOENT');
    if (this.faults.corruptReadOf === basename(path)) {
      return Buffer.concat([bytes, Buffer.from(' ')]);
    }
    return Buffer.from(bytes);
  }

  readdir(path) {
    this.calls.push(['readdir', path]);
    return [...this.files.keys()]
      .filter((file) => dirname(file) === path)
      .map((file) => basename(file));
  }

  rename(from, to) {
    this.calls.push(['rename', from, to]);
    if (this.faults.renameThrows) throw FakeFs.error('EPERM');
    for (const [path, bytes] of [...this.files]) {
      if (dirname(path) === from) {
        this.files.delete(path);
        this.files.set(join(to, basename(path)), bytes);
      }
    }
    this.dirs.delete(from);
    this.dirs.add(to);
  }

  unlink(path) {
    this.calls.push(['unlink', path]);
    if (this.faults.unlinkThrows) throw FakeFs.error('EPERM');
    if (!this.files.delete(path)) throw FakeFs.error('ENOENT');
  }

  rmdir(path) {
    this.calls.push(['rmdir', path]);
    if ([...this.files.keys()].some((file) => dirname(file) === path)) {
      throw FakeFs.error('ENOTEMPTY');
    }
    if (!this.dirs.delete(path)) throw FakeFs.error('ENOENT');
  }
}

const FAKE_PARENT = resolve('fake-materialization-root');
const FAKE_TARGET = join(FAKE_PARENT, 'recovered');
const FAKE_STAGING = join(FAKE_PARENT, `${STAGING_PREFIX}Ab12Cd`);
const MUTATING_CALLS = ['mkdtemp', 'writeExclusive', 'rename', 'unlink', 'rmdir'];

const completePlan = () =>
  planReportFiles(recoverAndAccount(fullCampaignLogs().map((text) => ({ text }))));

/** Every mutating call stays inside the owned staging directory or is the one rename. */
function assertOnlyOwnedMutations(fake) {
  for (const [name, path, to] of fake.calls) {
    if (name === 'writeExclusive' || name === 'unlink') assert.equal(dirname(path), FAKE_STAGING);
    if (name === 'rmdir') assert.equal(path, FAKE_STAGING);
    if (name === 'rename') assert.deepEqual([path, to], [FAKE_STAGING, FAKE_TARGET]);
  }
}

const withSlot = (texts, index, text) => texts.map((old, i) => (i === index ? text : old));

/** Campaigns that must never be written, each as log texts. */
const unwritableCampaigns = () => {
  const base = fullCampaignLogs();
  return [
    ['58 slots', base.slice(0, 58)],
    ['a report-free extra log', [...base, 'job output only\n']],
    ['a rejected extra log', [...base, `${CALIBRATION_REPORT_FOOTER}\n`]],
    ['duplicate slot', withSlot(base, 1, jobLog(report(1)))],
    ['commit mismatch', withSlot(base, 20, jobLog(report(21, { commit: 'd'.repeat(40) })))],
    [
      'topology mismatch',
      withSlot(
        base,
        30,
        jobLog(report(31, { topology: { ...TOPOLOGY, kernel: '6.18.0-1-azure' } })),
      ),
    ],
    ['blocker', withSlot(base, 11, jobLog(report(12, { kind: 'product' })))],
    [
      'edited report',
      withSlot(
        base,
        5,
        mutate(base[5], 'stress: passed=1 failed=0 of 1', 'stress: passed=2 failed=0 of 1'),
      ),
    ],
  ];
};

test('materialize: the read-only form is unchanged and never touches the output file system', () => {
  for (const texts of [fullCampaignLogs(), fullCampaignLogs().slice(0, 58)]) {
    const logs = memoryLogs(texts);
    const { fs, calls } = forbiddenFs();
    const cli = runLogRecoveryCli({
      argv: logs.paths,
      sizeOf: logs.sizeOf,
      readText: logs.readText,
      fs,
    });
    const direct = recoverAndAccount(texts.map((text) => ({ text })));
    assert.equal(cli.output, formatRecovery(direct));
    assert.equal(cli.exitCode, direct.exitCode);
    assert.deepEqual(calls, []);
    assert.ok(!cli.output.includes('materialization'));
  }
  const usage = runLogRecoveryCli({ argv: [] });
  assert.equal(usage.exitCode, 2);
  assert.match(usage.output, /\[--output-dir <new-directory>\] <job-log> \[<job-log> \.\.\.\]/);
});

test('materialize: each accepted string is bound to its parsed slot; names and bytes ignore input order', () => {
  const logs = withSlot(
    fullCampaignLogs(),
    10,
    jobLog(report(11, { kind: 'event' }), { prefixed: true, crlf: true, red: true }),
  );
  const result = recoverAndAccount(logs.map((text) => ({ text })));
  assert.equal(result.recovery.slotReports.length, CAMPAIGN_SLOT_COUNT);
  assert.deepEqual(
    result.recovery.slotReports.map(({ text }) => text).sort(),
    result.recovery.reports,
    'the bound strings are exactly the recovered reports',
  );
  const plan = planReportFiles(result);
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.files.map(({ name }) => name),
    SLOT_NAMES,
  );
  assert.equal(SLOT_NAMES[0], 'slot-01.txt');
  assert.equal(SLOT_NAMES[58], 'slot-59.txt');
  for (const file of plan.files) {
    const expected = file.slot === 11 ? report(11, { kind: 'event' }) : report(file.slot);
    assert.equal(file.text, expected, `slot ${file.slot} bytes are the rendered report`);
    assert.equal(parseSlotReport(file.text).report.slot, file.slot);
    assert.match(file.name, /^slot-[0-5]\d\.txt$/);
  }

  const mapping = (texts) =>
    planReportFiles(recoverAndAccount(texts.map((text) => ({ text })))).files.map(
      ({ name, text }) => [name, text],
    );
  const baseline = mapping(logs);
  assert.deepEqual(mapping(shuffled(logs)), baseline, 'shuffled logs');
  assert.deepEqual(mapping(shuffled(logs, 99).reverse()), baseline, 'another order');
  const grouped = [];
  const order = shuffled(logs, 3);
  for (let i = 0; i < order.length; i += 7) grouped.push(order.slice(i, i + 7).join(''));
  assert.deepEqual(mapping(grouped), baseline, 'shuffled reports grouped into fewer logs');

  for (const bad of [0, 60, 1.5, '1', -1, Number.NaN]) {
    assert.throws(() => reportFileName(bad), RangeError, String(bad));
  }
});

test('materialize: only a clean, complete, one-to-one bound recovery yields a plan', () => {
  for (const [label, texts] of unwritableCampaigns()) {
    assert.deepEqual(
      planReportFiles(recoverAndAccount(texts.map((text) => ({ text })))),
      { ok: false, reason: MATERIALIZATION_REASON.notComplete },
      label,
    );
  }

  // A result that claims completeness but binds wrongly is still refused.
  const good = recoverAndAccount(fullCampaignLogs().map((text) => ({ text })));
  const entries = good.recovery.slotReports;
  const tampered = (slotReports) => ({ ...good, recovery: { ...good.recovery, slotReports } });
  for (const [label, slotReports] of [
    ['one binding missing', entries.slice(1)],
    ['a slot bound twice', [entries[0], ...entries.slice(0, 58)]],
    ['text bound to the wrong slot', withSlot(entries, 0, { slot: 1, text: entries[1].text })],
    ['edited text', withSlot(entries, 0, { slot: 1, text: entries[0].text.replace('\n', '\r\n') })],
    ['not an array', undefined],
  ]) {
    assert.deepEqual(
      planReportFiles(tampered(slotReports)),
      { ok: false, reason: MATERIALIZATION_REASON.binding },
      label,
    );
  }
  assert.equal(planReportFiles({ ...good, ok: false }).reason, MATERIALIZATION_REASON.notComplete);
  assert.equal(planReportFiles(undefined).reason, MATERIALIZATION_REASON.notComplete);
});

test('materialize: option syntax errors exit 2 before any read or write and echo no value', () => {
  const logs = memoryLogs(fullCampaignLogs());
  for (const argv of [
    ['--output-dir'],
    ['--output-dir', '', ...logs.paths],
    ['--output-dir', '--', ...logs.paths],
    ['--output-dir', '-private-dir', ...logs.paths],
    ['--output-dir=private-dir', ...logs.paths],
    ['--output-dir', 'private-a', '--output-dir', 'private-b', ...logs.paths],
    ['--output-dir', 'private-a'],
    ['--out', 'private-a', ...logs.paths],
  ]) {
    const touched = [];
    const { fs, calls } = forbiddenFs();
    const result = runLogRecoveryCli({
      argv,
      sizeOf: (path) => touched.push(path),
      readText: (path) => touched.push(path),
      fs,
    });
    const label = JSON.stringify(argv.slice(0, 5));
    assert.equal(result.exitCode, 2, label);
    assert.match(result.output, /usage:/, label);
    assert.ok(!result.output.includes('private'), label);
    assert.deepEqual(touched, [], label);
    assert.deepEqual(calls, [], label);
  }

  // Accepted before, between or after the logs, and after pnpm's forwarded `--`.
  for (const argv of [
    ['--', '--output-dir', FAKE_TARGET, ...logs.paths],
    [...logs.paths.slice(0, 30), '--output-dir', FAKE_TARGET, ...logs.paths.slice(30)],
    [...logs.paths, '--output-dir', FAKE_TARGET],
  ]) {
    const fake = new FakeFs({ dirs: [FAKE_PARENT] });
    const result = runLogRecoveryCli({
      argv,
      sizeOf: logs.sizeOf,
      readText: logs.readText,
      fs: fake,
    });
    assert.equal(result.exitCode, 0, result.output);
    assert.deepEqual(
      [...fake.files.keys()].map((path) => [dirname(path), basename(path)]),
      SLOT_NAMES.map((name) => [FAKE_TARGET, name]),
    );
  }
});

test('materialize: incomplete, rejected, duplicate or inconsistent campaigns touch no file system', () => {
  for (const [label, texts] of unwritableCampaigns()) {
    const logs = memoryLogs(texts);
    const { fs, calls } = forbiddenFs();
    const result = runLogRecoveryCli({
      argv: ['--output-dir', 'private-out', ...logs.paths],
      sizeOf: logs.sizeOf,
      readText: logs.readText,
      fs,
    });
    assert.equal(result.exitCode, 1, label);
    assert.deepEqual(calls, [], label);
    assert.match(
      result.output,
      /\nmaterialization: NOT WRITTEN - recovery or accounting is not complete; nothing was created\nRESULT: FAIL\n$/,
      label,
    );
    const legacy = formatRecovery(recoverAndAccount(texts.map((text) => ({ text }))));
    assert.ok(result.output.startsWith(legacy.slice(0, legacy.lastIndexOf('RESULT: '))), label);
  }
  const { fs, calls } = forbiddenFs();
  const unreadable = runLogRecoveryCli({
    argv: ['--output-dir', 'private-out', 'missing-private.log'],
    sizeOf: () => {
      throw new Error('ENOENT');
    },
    fs,
  });
  assert.equal(unreadable.exitCode, 1);
  assert.deepEqual(calls, []);
});

test('materialize: a destination that exists in any form, or an unusable parent, is refused untouched', () => {
  const { files } = completePlan();
  const refused = (fake, outputDir = FAKE_TARGET) => {
    const outcome = materializeReportFiles({ outputDir, files, fs: fake });
    assert.equal(outcome.written, false);
    assert.equal(outcome.cleanup, MATERIALIZATION_CLEANUP.none);
    assert.ok(!fake.calls.some(([name]) => MUTATING_CALLS.includes(name)));
    return outcome.reason;
  };
  for (const [label, fake] of [
    ['existing directory', new FakeFs({ dirs: [FAKE_PARENT, FAKE_TARGET] })],
    [
      'existing file',
      new FakeFs({ dirs: [FAKE_PARENT], files: [[FAKE_TARGET, Buffer.from('keep')]] }),
    ],
    ['symlink or junction', new FakeFs({ dirs: [FAKE_PARENT], links: [FAKE_TARGET] })],
  ]) {
    assert.equal(refused(fake), MATERIALIZATION_REASON.exists, label);
  }
  const denied = new FakeFs({
    dirs: [FAKE_PARENT],
    faults: { lstatError: (path) => (path === FAKE_TARGET ? 'EACCES' : null) },
  });
  assert.equal(refused(denied), MATERIALIZATION_REASON.uncheckable);
  assert.equal(refused(new FakeFs({ links: [FAKE_PARENT] })), MATERIALIZATION_REASON.parent);
  assert.equal(
    refused(new FakeFs({ files: [[FAKE_PARENT, Buffer.from('x')]] })),
    MATERIALIZATION_REASON.parent,
  );
  assert.equal(refused(new FakeFs()), MATERIALIZATION_REASON.parent, 'missing parent');
  assert.equal(refused(new FakeFs(), resolve('/')), MATERIALIZATION_REASON.invalidName, 'root');
});

test('materialize: failures after staging remove only owned state and never expose a partial output', () => {
  const { files } = completePlan();
  const run = (faults) => {
    const fake = new FakeFs({ dirs: [FAKE_PARENT], faults: { target: FAKE_TARGET, ...faults } });
    const outcome = materializeReportFiles({ outputDir: FAKE_TARGET, files, fs: fake });
    assertOnlyOwnedMutations(fake);
    assert.equal(outcome.written, false);
    assert.ok(![...fake.files.keys()].some((path) => dirname(path) === FAKE_TARGET));
    assert.ok(!fake.calls.some(([name]) => name === 'rename') || faults.renameThrows);
    const line = formatMaterialization(outcome);
    assert.match(line, /^materialization: FAILED - /);
    for (const leak of [FAKE_PARENT, 'recovered', STAGING_PREFIX, 'Ab12Cd']) {
      assert.ok(!line.includes(leak), leak);
    }
    return { fake, outcome };
  };
  const removed = (fake) => {
    assert.equal(fake.files.size, 0);
    assert.ok(!fake.dirs.has(FAKE_STAGING));
  };

  const failedWrite = run({ failWriteAt: 30 });
  assert.equal(failedWrite.outcome.reason, MATERIALIZATION_REASON.create);
  assert.equal(failedWrite.outcome.cleanup, MATERIALIZATION_CLEANUP.removed);
  assert.equal(failedWrite.fake.calls.filter(([name]) => name === 'unlink').length, 29);
  removed(failedWrite.fake);

  const corrupt = run({ corruptReadOf: 'slot-17.txt' });
  assert.equal(corrupt.outcome.reason, MATERIALIZATION_REASON.verify);
  assert.equal(corrupt.outcome.cleanup, MATERIALIZATION_CLEANUP.removed);
  removed(corrupt.fake);

  const foreign = run({ injectEntryAfterWrite: 59 });
  assert.equal(foreign.outcome.reason, MATERIALIZATION_REASON.entries);
  assert.equal(foreign.outcome.cleanup, MATERIALIZATION_CLEANUP.incomplete);
  assert.deepEqual([...foreign.fake.files.keys()], [join(FAKE_STAGING, 'foreign.txt')]);
  assert.ok(foreign.fake.dirs.has(FAKE_STAGING), 'never removed recursively');

  const lateTarget = run({ targetAppearsAfterWrite: 59 });
  assert.equal(lateTarget.outcome.reason, MATERIALIZATION_REASON.exists);
  assert.equal(lateTarget.outcome.cleanup, MATERIALIZATION_CLEANUP.removed);
  assert.ok(lateTarget.fake.dirs.has(FAKE_TARGET), 'the concurrently created directory is kept');
  removed(lateTarget.fake);

  const renameFails = run({ renameThrows: true });
  assert.equal(renameFails.outcome.reason, MATERIALIZATION_REASON.rename);
  assert.equal(renameFails.outcome.cleanup, MATERIALIZATION_CLEANUP.removed);
  removed(renameFails.fake);

  const unlinkFails = run({ failWriteAt: 3, unlinkThrows: true });
  assert.equal(unlinkFails.outcome.cleanup, MATERIALIZATION_CLEANUP.incomplete);

  const noStaging = run({ mkdtempThrows: true });
  assert.deepEqual(noStaging.outcome, {
    written: false,
    reason: MATERIALIZATION_REASON.staging,
    cleanup: MATERIALIZATION_CLEANUP.none,
  });

  const outside = new FakeFs({
    dirs: [FAKE_PARENT],
    faults: { mkdtempPath: resolve('elsewhere', `${STAGING_PREFIX}Zz9`) },
  });
  assert.deepEqual(materializeReportFiles({ outputDir: FAKE_TARGET, files, fs: outside }), {
    written: false,
    reason: MATERIALIZATION_REASON.stagingOutside,
    cleanup: MATERIALIZATION_CLEANUP.notRemoved,
  });
  assert.ok(
    !outside.calls.some(([name]) => ['writeExclusive', 'unlink', 'rmdir', 'rename'].includes(name)),
  );

  const success = new FakeFs({ dirs: [FAKE_PARENT] });
  assert.deepEqual(materializeReportFiles({ outputDir: FAKE_TARGET, files, fs: success }), {
    written: true,
    count: CAMPAIGN_SLOT_COUNT,
  });
  assertOnlyOwnedMutations(success);
  assert.ok(!success.dirs.has(FAKE_STAGING));
  assert.equal(success.calls.filter(([name]) => name === 'rename').length, 1);
});

test('materialize: the real CLI writes 59 exact files once, and a repeat or existing path is never overwritten', () => {
  const root = tempDir();
  const logDir = join(root, 'private-logs');
  mkdirSync(logDir);
  const texts = withSlot(
    fullCampaignLogs(),
    10,
    jobLog(report(11, { kind: 'event' }), { prefixed: true, crlf: true, red: true }),
  );
  const paths = shuffled(
    texts.map((text, index) => {
      const path = join(logDir, `private-job-${index}.log`);
      writeFileSync(path, text);
      return path;
    }),
  );
  const out = join(root, 'recovered-private');
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

  const legacy = run(paths);
  assert.equal(legacy.status, 0);
  assert.deepEqual(readdirSync(root), ['private-logs'], 'the read-only form wrote nothing');

  const first = run(['--output-dir', out, ...paths]);
  assert.equal(first.status, 0, first.stdout);
  assert.equal(first.stderr, '');
  assert.ok(first.stdout.startsWith(legacy.stdout.slice(0, legacy.stdout.lastIndexOf('RESULT: '))));
  assert.match(
    first.stdout,
    /\nmaterialization: WRITTEN - 59 report files slot-01\.txt\.\.slot-59\.txt in a newly created output directory\nRESULT: PASS\n$/,
  );
  assert.deepEqual(readdirSync(root).sort(), ['private-logs', 'recovered-private']);
  assert.deepEqual(readdirSync(out).sort(), SLOT_NAMES);
  for (let slot = 1; slot <= CAMPAIGN_SLOT_COUNT; slot += 1) {
    const expected = slot === 11 ? report(11, { kind: 'event' }) : report(slot);
    assert.ok(
      readFileSync(join(out, reportFileName(slot))).equals(Buffer.from(expected, 'utf8')),
      `slot ${slot}`,
    );
  }
  for (const leak of [root, 'private', '2026-09-16T01:00', STAGING_PREFIX]) {
    assert.ok(!first.stdout.includes(leak), leak);
  }
  // The commit appears only where the unchanged accounting already prints it;
  // everything the materialization adds carries no recovered value.
  const added = first.stdout.slice(legacy.stdout.lastIndexOf('RESULT: '));
  for (const leak of [root, COMMIT, STAGING_PREFIX, 'recovered-private']) {
    assert.ok(!added.includes(leak), leak);
  }
  assert.equal(
    first.stdout.split(COMMIT).length,
    legacy.stdout.split(COMMIT).length,
    'no additional commit occurrence',
  );

  const snapshot = () =>
    SLOT_NAMES.map((name) => [
      name,
      readFileSync(join(out, name)),
      statSync(join(out, name)).mtimeMs,
    ]);
  const before = snapshot();
  const repeat = run(['--output-dir', out, ...shuffled(paths, 11)]);
  assert.equal(repeat.status, 1);
  assert.match(
    repeat.stdout,
    /\nmaterialization: FAILED - output path already exists; nothing was created\nRESULT: FAIL\n$/,
  );
  assert.deepEqual(snapshot(), before, 'the existing output is unchanged');

  const fileTarget = join(root, 'private-file');
  writeFileSync(fileTarget, 'keep me\n');
  const onFile = run(['--output-dir', fileTarget, ...paths]);
  assert.equal(onFile.status, 1);
  assert.equal(readFileSync(fileTarget, 'utf8'), 'keep me\n');

  const emptyDir = join(root, 'private-empty');
  mkdirSync(emptyDir);
  assert.equal(run(['--output-dir', emptyDir, ...paths]).status, 1);
  assert.deepEqual(
    readdirSync(emptyDir),
    [],
    'an existing empty directory is neither filled nor merged',
  );

  const linkTarget = join(root, 'private-link');
  let linked = false;
  try {
    symlinkSync(emptyDir, linkTarget, 'junction');
    linked = true;
  } catch {
    // The platform may refuse to create a link; the fake file system covers the rule.
  }
  if (linked) {
    const onLink = run(['--output-dir', linkTarget, ...paths]);
    assert.equal(onLink.status, 1);
    assert.match(onLink.stdout, /output path already exists/);
    assert.deepEqual(readdirSync(emptyDir), [], 'nothing is written through a link');
  }

  const noParent = run(['--output-dir', join(root, 'missing-private', 'out'), ...paths]);
  assert.equal(noParent.status, 1);
  assert.match(noParent.stdout, /output parent is not an existing directory that is not a link/);

  assert.ok(
    !readdirSync(root).some((name) => name.startsWith(STAGING_PREFIX)),
    'no staging residue',
  );
  for (const result of [repeat, onFile, noParent]) {
    assert.ok(!result.stdout.includes(root));
    assert.ok(!result.stdout.includes('private'));
  }
});

test('materialize: synthetic materialized files pass the unchanged accounting and image-cohort commands', () => {
  const root = tempDir();
  const texts = withSlot(
    fullCampaignLogs(),
    10,
    jobLog(report(11, { kind: 'event' }), { prefixed: true, red: true }),
  );
  const logs = memoryLogs(texts);
  const out = join(root, 'recovered');
  const cli = runLogRecoveryCli({
    argv: ['--output-dir', out, ...shuffled(logs.paths)],
    sizeOf: logs.sizeOf,
    readText: logs.readText,
  });
  assert.equal(cli.exitCode, 0, cli.output);
  const files = SLOT_NAMES.map((name) => join(out, name));

  const accounting = runAccountingCli({ argv: shuffled(files, 5) });
  assert.equal(accounting.exitCode, 0, accounting.output);
  assert.match(accounting.output, /totals: non-events=58 events=1 blockers=0 missing=0/);
  const rendered = accountCampaign(
    Array.from({ length: CAMPAIGN_SLOT_COUNT }, (_, i) => ({
      text: i === 10 ? report(11, { kind: 'event' }) : report(i + 1),
    })),
  );
  assert.equal(
    accounting.output,
    formatAccounting(rendered),
    'files account like the rendered reports',
  );

  // A synthetic nine-field manifest: illustrative values, not an observed release state.
  const manifestPath = join(root, 'synthetic-manifest.json');
  const manifest = {
    schema: COHORT_MANIFEST_SCHEMA,
    observed_at: '2026-09-15T08:00:00Z',
    runner_label: 'ubuntu-24.04',
    current_image_release: 'ubuntu24/20260907.300',
    current_image_published_at: '2026-09-08T09:34:53Z',
    previous_image_release: 'ubuntu24/20260831.293',
    previous_image_published_at: '2026-09-01T09:00:00Z',
    branch_c_on_topology_mismatch_acknowledged: true,
    campaign_commit: COMMIT,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const now = new Date('2026-09-17T00:00:00Z');
  const cohort = runImageCohortCli({ argv: [manifestPath, ...shuffled(files, 13)], now });
  assert.equal(cohort.exitCode, 0, cohort.output);
  assert.match(cohort.output, /COHORT: CONSISTENT/);

  // One changed byte in one materialized file is no longer a consistent cohort.
  writeFileSync(files[3], readFileSync(files[3], 'utf8').replace('pairs: 1;', 'pairs: 2;'));
  const edited = runImageCohortCli({ argv: [manifestPath, ...files], now });
  assert.equal(edited.exitCode, 1);
  assert.match(edited.output, /COHORT: BRANCH C/);
});

// ---------------------------------------------------------------------------
// Job-log manifests (`--logs-manifest`) — injected file systems, or temporary files only

const USAGE_LINE = runLogRecoveryCli({ argv: [] }).output.split('\n')[1];
const listOf = (lines) => lines.map((line) => `${line}\n`).join('');

const POSIX_CWD = '/private-caller/nested';
const POSIX_MANIFEST = '/private-campaign/lists/private-logs.list';
const POSIX_LOG_DIR = '/private-campaign/job-logs';
const WIN_CWD = 'C:\\private-caller\\nested';
const WIN_MANIFEST = 'D:\\private-campaign\\lists\\private-logs.list';

/**
 * Injected manifest and log reads that record every access in order. `logs`
 * maps a resolved path to its text; `sizes` may report another size for a log.
 */
function logManifestHarness({
  logs = new Map(),
  bytes = Buffer.alloc(0),
  sizes = new Map(),
  platform = 'posix',
  cwd = POSIX_CWD,
  ...manifest
} = {}) {
  const events = [];
  const missing = () => Object.assign(new Error('ENOENT: /private-campaign'), { code: 'ENOENT' });
  const options = {
    platform,
    cwd,
    manifestSizeOf: (path) => {
      events.push(['manifestSize', path]);
      if (manifest.statThrows) throw missing();
      return 'size' in manifest ? manifest.size : bytes.length;
    },
    readManifestBytes: (path) => {
      events.push(['manifestRead', path]);
      if (manifest.readThrows) throw missing();
      return bytes;
    },
    sizeOf: (path) => {
      events.push(['logSize', path]);
      if (sizes.has(path)) return sizes.get(path);
      if (!logs.has(path)) throw missing();
      return Buffer.byteLength(logs.get(path), 'utf8');
    },
    readText: (path) => {
      events.push(['logRead', path]);
      if (!logs.has(path)) throw missing();
      return logs.get(path);
    },
  };
  const logEvents = () => events.filter(([kind]) => kind.startsWith('log'));
  return { events, options, logEvents };
}

/** 59 in-memory logs listed by a manifest of shuffled lines relative to the manifest's directory. */
function memoryLogCampaign(texts = fullCampaignLogs(), seed = 7) {
  const logs = new Map(
    texts.map((text, index) => [
      `${POSIX_LOG_DIR}/private-job-${String(index).padStart(2, '0')}.log`,
      text,
    ]),
  );
  const order = shuffled([...logs.keys()], seed);
  const lines = order.map((path) => `../job-logs/${posix.basename(path)}`);
  return { logs, order, lines, bytes: Buffer.from(listOf(lines), 'utf8') };
}

test('logs manifest: the shared bounded primitive keeps the report-manifest contract and counts 1..maxLogs', () => {
  assert.deepEqual(Object.keys(REPORT_MANIFEST_PROBLEM), [
    ...Object.keys(PATH_MANIFEST_PROBLEM),
    'lineCount',
  ]);
  assert.deepEqual(REPORT_MANIFEST_PROBLEM, {
    ...PATH_MANIFEST_PROBLEM,
    lineCount: 'manifest does not list exactly 59 report paths',
  });
  assert.equal(MAX_REPORT_MANIFEST_BYTES, 60475);
  assert.equal(pathManifestMaxBytes(CAMPAIGN_SLOT_COUNT), MAX_REPORT_MANIFEST_BYTES);
  assert.equal(pathManifestMaxBytes(LOG_RECOVERY_LIMITS.maxLogs), 131200);
  assert.equal(
    logsManifestCountProblem(),
    'manifest does not list between 1 and 128 job-log paths',
  );

  const range = {
    manifestDir: '/private-campaign/lists',
    minEntries: 1,
    maxEntries: LOG_RECOVERY_LIMITS.maxLogs,
    countProblem: logsManifestCountProblem(),
  };
  const lines = (count) =>
    Buffer.from(listOf(Array.from({ length: count }, (_, i) => `logs/${i}.log`)));
  for (const count of [1, 58, 59, 60, 128]) {
    const parsed = parsePathManifest(lines(count), range);
    assert.equal(parsed.ok, true, String(count));
    assert.equal(parsed.paths.length, count);
    assert.equal(parsed.paths[0], '/private-campaign/lists/logs/0.log');
  }
  assert.deepEqual(parsePathManifest(lines(129), range), {
    ok: false,
    problem: logsManifestCountProblem(),
  });
  // The report manifest still insists on exactly 59.
  for (const count of [1, 58, 60]) {
    assert.deepEqual(parseReportManifest(lines(count), { manifestDir: range.manifestDir }), {
      ok: false,
      problem: REPORT_MANIFEST_PROBLEM.lineCount,
    });
  }
  assert.equal(parseReportManifest(lines(59), { manifestDir: range.manifestDir }).ok, true);

  // A malformed range is a programming error, refused before any access.
  for (const [minEntries, maxEntries] of [
    [0, 1],
    [2, 1],
    [1, Number.NaN],
    [1.5, 2],
    [undefined, 128],
  ]) {
    assert.throws(
      () => parsePathManifest(lines(1), { ...range, minEntries, maxEntries }),
      RangeError,
    );
    const touched = [];
    assert.throws(
      () =>
        loadPathManifest('private.list', {
          ...range,
          minEntries,
          maxEntries,
          cwd: '/private-caller',
          sizeOf: (path) => touched.push(path),
          readBytes: (path) => touched.push(path),
        }),
      RangeError,
    );
    assert.deepEqual(touched, []);
  }
});

test('logs manifest: argument grammar — accepted orders, and every usage error exits 2 with a fixed line before any read or write', () => {
  const parse = (argv) => parseRecoveryArgs(argv, { platform: 'posix', cwd: POSIX_CWD });
  const m = 'private.list';
  const o = 'private-out';
  // Every accepted manifest order.
  for (const [argv, outputDir] of [
    [['--logs-manifest', m], undefined],
    [['--', '--logs-manifest', m], undefined],
    [['--output-dir', o, '--logs-manifest', m], o],
    [['--logs-manifest', m, '--output-dir', o], o],
    [['--', '--output-dir', o, '--logs-manifest', m], o],
    [['--', '--logs-manifest', m, '--output-dir', o], o],
  ]) {
    assert.deepEqual(parse(argv), { ok: true, mode: 'manifest', manifest: m, outputDir });
  }
  // Every accepted explicit order is unchanged: before, between or after the logs.
  const logs = ['private-a.log', 'private-b.log', 'private-c.log'];
  for (const [argv, outputDir] of [
    [logs, undefined],
    [['--', ...logs], undefined],
    [['--output-dir', o, ...logs], o],
    [['--', '--output-dir', o, ...logs], o],
    [[logs[0], '--output-dir', o, ...logs.slice(1)], o],
    [[...logs, '--output-dir', o], o],
  ]) {
    assert.deepEqual(parse(argv), { ok: true, mode: 'paths', paths: logs, outputDir });
  }
  const maxPaths = Array.from(
    { length: LOG_RECOVERY_LIMITS.maxLogs },
    (_, i) => `private-${i}.log`,
  );
  assert.equal(parse(maxPaths).ok, true);
  assert.equal(parse(['p'.repeat(1024)]).ok, true);
  assert.equal(parse(['--logs-manifest', 'p'.repeat(1024)]).ok, true);

  const E = USAGE_ERROR;
  const cases = [
    [['--logs-manifest'], E.manifestValue],
    [['--logs-manifest', ''], E.manifestValue],
    [['--logs-manifest', '-private.list'], E.manifestValue],
    [['--logs-manifest', '--'], E.manifestValue],
    [['--logs-manifest', '--output-dir', o], E.manifestValue],
    [['--logs-manifest', 'é'.repeat(513)], E.pathTooLong],
    [['--logs-manifest=private.list'], E.inlineValue],
    [['--logs-manifest=', m], E.inlineValue],
    [['--logs-manifest', m, '--logs-manifest', 'private-b.list'], E.manifestRepeated],
    [['--logs-manifest', m, '--logs-manifest'], E.manifestRepeated],
    [['--logs-manifest', m, 'private.log'], E.extraArgument],
    [['--logs-manifest', m, '--output-dir', o, 'private.log'], E.extraArgument],
    [['--logs-manifest', m, ''], E.extraArgument],
    [['private.log', '--logs-manifest', m], E.mixedModes],
    [['--output-dir', o, 'private.log', '--logs-manifest', m], E.mixedModes],
    [['--logs-manifest', m, '--'], E.lateSeparator],
    [['--', '--', '--logs-manifest', m], E.lateSeparator],
    [['--output-dir', o, '--', '--logs-manifest', m], E.lateSeparator],
    [['private.log', '--', 'private-b.log'], E.lateSeparator],
    [['--', '--', 'private.log'], E.lateSeparator],
    [['--logs-manifest', m, '--output-dir'], E.outputValue],
    [['--logs-manifest', m, '--output-dir', '-private'], E.outputValue],
    [['--output-dir', o, '--logs-manifest', m, '--output-dir', 'private-p'], E.outputRepeated],
    [['--logs-manifest', m, '--json'], E.unknownOption],
    [['--output-dir=private', '--logs-manifest', m], E.unknownOption],
    [['--logs', m], E.unknownOption],
    [['-private.log'], E.unknownOption],
    [[], E.noLog],
    [['--'], E.noLog],
    [['--output-dir', o], E.noLog],
    [[''], E.emptyPath],
    [['private.log', ''], E.emptyPath],
    [['é'.repeat(513)], E.pathTooLong],
    [[...maxPaths, 'private-extra.log'], E.tooManyPaths],
    [['private.log', 'private.log'], E.duplicatePath],
  ];
  for (const [argv, message] of cases) {
    const label = JSON.stringify(argv.slice(0, 6));
    const parsed = parse(argv);
    assert.equal(parsed.ok, false, label);
    const h = logManifestHarness();
    const { fs, calls } = forbiddenFs();
    const result = runLogRecoveryCli({ argv, ...h.options, fs });
    assert.equal(result.exitCode, 2, label);
    assert.equal(result.output, `${message}\n${USAGE_LINE}\n`, label);
    assert.equal(parsed.output, result.output, label);
    assert.deepEqual(h.events, [], `${label}: no manifest or log access`);
    assert.deepEqual(calls, [], `${label}: no output file system call`);
    for (const leak of ['private', 'é', '.list', '.log']) {
      assert.ok(!result.output.includes(leak), `${label} leaks ${leak}`);
    }
  }
  assert.equal(new Set(Object.values(USAGE_ERROR)).size, Object.keys(USAGE_ERROR).length);
  assert.match(USAGE_LINE, / \| \[--output-dir <new-directory>\] --logs-manifest <file>$/);
});

test('logs manifest: grammar, size, growth and read failures exit 2 with zero log reads and zero writes', () => {
  const P = PATH_MANIFEST_PROBLEM;
  const good = '../job-logs/private-job-00.log';
  const other = '../job-logs/private-job-01.log';
  const MAX = pathManifestMaxBytes(LOG_RECOVERY_LIMITS.maxLogs);
  const bytesOf = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'));
  const cases = [
    ['BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytesOf(`${good}\n`)]), P.bom],
    ['UTF-16LE', Buffer.from(`${good}\n`, 'utf16le'), P.control],
    [
      'invalid UTF-8',
      Buffer.concat([
        bytesOf('../job-logs/private-'),
        Buffer.from([0xc3, 0x28]),
        bytesOf('.log\n'),
      ]),
      P.notUtf8,
    ],
    ['CRLF', `${good}\r\n${other}\r\n`, P.carriageReturn],
    ['lone CR', `${good}\r`, P.carriageReturn],
    ['NUL', `${good}${NUL}\n`, P.control],
    ['tab', `${good}\t\n`, P.control],
    ['ESC', `${ESC}${good}\n`, P.control],
    ['DEL', `${good}\u007f\n`, P.control],
    ['no final LF', `${good}\n${other}`, P.finalNewline],
    ['empty', '', P.finalNewline],
    ['only LF', '\n', P.blankLine],
    ['blank line', `${good}\n\n${other}\n`, P.blankLine],
    ['trailing blank line', `${good}\n\n`, P.blankLine],
    ['leading space', ` ${good}\n`, P.whitespace],
    ['trailing space', `${good} \n`, P.whitespace],
    ['no-break space', `${good}\u00a0\n`, P.whitespace],
    ['option-like', '-private-job.log\n', P.optionLike],
    ['comment', `# ${good}\n`, P.notPlainPath],
    ['double quoted', `"${good}"\n`, P.notPlainPath],
    ['single quoted', `'${good}'\n`, P.notPlainPath],
    ['URL', 'https://example.invalid/private-job.log\n', P.notPlainPath],
    ['file URL', 'file:///private-campaign/job.log\n', P.notPlainPath],
    ['drive-relative', 'C:private-job.log\n', P.notPlainPath],
    ['entry over 1024 bytes', `${'é'.repeat(513)}\n`, P.entryTooLong],
    [
      '129 entries',
      listOf(Array.from({ length: 129 }, (_, i) => `../job-logs/private-${i}.log`)),
      logsManifestCountProblem(),
    ],
  ].map(([label, body, problem]) => [label, { bytes: bytesOf(body) }, problem]);
  const small = Buffer.from(`${good}\n`);
  cases.push(
    ['stat over the byte limit', { bytes: small, size: MAX + 1 }, P.tooLarge],
    ['stat unknown (NaN)', { bytes: small, size: Number.NaN }, P.tooLarge],
    ['stat negative', { bytes: small, size: -1 }, P.tooLarge],
    ['stat fractional', { bytes: small, size: 1.5 }, P.tooLarge],
    ['stat not a number', { bytes: small, size: '12' }, P.tooLarge],
    ['stat bigint', { bytes: small, size: 12n }, P.tooLarge],
    ['growth after the size check', { bytes: Buffer.alloc(MAX + 1, 0x61), size: 10 }, P.tooLarge],
    ['stat fails', { bytes: small, statThrows: true }, P.unreadable],
    ['read fails', { bytes: small, readThrows: true }, P.unreadable],
    ['read returns no bytes', { bytes: 'not a buffer' }, P.unreadable],
  );
  const refusedUnread = new Set([
    'stat over the byte limit',
    'stat unknown (NaN)',
    'stat negative',
    'stat fractional',
    'stat not a number',
    'stat bigint',
    'stat fails',
  ]);

  for (const [label, manifest, problem] of cases) {
    for (const argv of [
      ['--logs-manifest', POSIX_MANIFEST],
      ['--', '--output-dir', 'private-out', '--logs-manifest', POSIX_MANIFEST],
    ]) {
      const campaign = memoryLogCampaign();
      const h = logManifestHarness({ logs: campaign.logs, ...manifest });
      const { fs, calls } = forbiddenFs();
      const result = runLogRecoveryCli({ argv, ...h.options, fs });
      const name = `${label} (${argv.length} arguments)`;
      assert.equal(result.exitCode, 2, name);
      assert.equal(result.output, `logs manifest: ${problem}\n${USAGE_LINE}\n`, name);
      assert.deepEqual(h.logEvents(), [], `${name}: no log size or read`);
      assert.deepEqual(calls, [], `${name}: no output file system call`);
      assert.deepEqual(
        h.events.map(([kind]) => kind),
        refusedUnread.has(label) ? ['manifestSize'] : ['manifestSize', 'manifestRead'],
        `${name}: only the named manifest, unread when its size is refused`,
      );
      for (const [, path] of h.events) assert.equal(path, POSIX_MANIFEST, name);
      for (const leak of ['private', 'job-logs', 'ENOENT', 'é', 'https', '#']) {
        assert.ok(!result.output.includes(leak), `${name} leaks ${leak}`);
      }
    }
  }
});

test('logs manifest: exact bounds; listed logs that are missing or oversized stay exit-1 recovery failures, sized before any read', () => {
  // 128 entries of exactly 1024 bytes: 131 200 bytes, the largest accepted manifest.
  const padded = Array.from({ length: LOG_RECOVERY_LIMITS.maxLogs }, (_, i) => {
    const head = `../job-logs/${String(i).padStart(3, '0')}-`;
    return `${head}${'x'.repeat(1024 - head.length)}`;
  });
  const largest = Buffer.from(listOf(padded));
  assert.equal(largest.length, 131200);
  const bound = logManifestHarness({ bytes: largest });
  const { fs, calls } = forbiddenFs();
  const allMissing = runLogRecoveryCli({
    argv: ['--logs-manifest', POSIX_MANIFEST, '--output-dir', 'private-out'],
    ...bound.options,
    fs,
  });
  assert.equal(allMissing.exitCode, 1, 'a listed log that cannot be read is a recovery failure');
  assert.match(allMissing.output, /^recovery: logs=128 readable_logs=0 recovered_reports=0 /m);
  assert.match(allMissing.output, /log could not be read x128/);
  assert.match(allMissing.output, /\nmaterialization: NOT WRITTEN - .*\nRESULT: FAIL\n$/);
  assert.deepEqual(calls, []);
  assert.equal(bound.logEvents().length, LOG_RECOVERY_LIMITS.maxLogs);
  assert.ok(bound.logEvents().every(([kind]) => kind === 'logSize'));
  assert.ok(!allMissing.output.includes('xxxx') && !allMissing.output.includes('ENOENT'));

  const oneMore = logManifestHarness({
    bytes: Buffer.from(listOf([...padded.slice(0, -1), `${padded.at(-1)}x`])),
  });
  const refused = runLogRecoveryCli({
    argv: ['--logs-manifest', POSIX_MANIFEST],
    ...oneMore.options,
  });
  assert.equal(refused.exitCode, 2);
  assert.equal(refused.output.split('\n')[0], `logs manifest: ${PATH_MANIFEST_PROBLEM.tooLarge}`);
  assert.deepEqual(oneMore.logEvents(), []);

  const campaign = memoryLogCampaign();
  const sizedBeforeRead = (harness) => {
    const kinds = harness.logEvents().map(([kind]) => kind);
    const firstRead = kinds.indexOf('logRead');
    assert.ok(firstRead === -1 || !kinds.slice(firstRead).includes('logSize'));
  };

  // One listed log missing: a 60th line that names nothing.
  const missing = logManifestHarness({
    logs: campaign.logs,
    bytes: Buffer.from(listOf([...campaign.lines, '../job-logs/private-gone.log'])),
  });
  const missingResult = runLogRecoveryCli({
    argv: ['--logs-manifest', POSIX_MANIFEST],
    ...missing.options,
  });
  assert.equal(missingResult.exitCode, 1);
  assert.match(missingResult.output, /^recovery: logs=60 readable_logs=59 recovered_reports=59 /m);
  assert.match(missingResult.output, /log could not be read x1/);
  sizedBeforeRead(missing);

  // One listed log over the per-log bound is sized and never read; nothing is written.
  const huge = campaign.order[17];
  const oversized = logManifestHarness({
    logs: campaign.logs,
    bytes: campaign.bytes,
    sizes: new Map([[huge, LOG_RECOVERY_LIMITS.maxLogBytes + 1]]),
  });
  const { fs: noFs, calls: noCalls } = forbiddenFs();
  const oversizedResult = runLogRecoveryCli({
    argv: ['--output-dir', 'private-out', '--logs-manifest', POSIX_MANIFEST],
    ...oversized.options,
    fs: noFs,
  });
  assert.equal(oversizedResult.exitCode, 1);
  assert.match(oversizedResult.output, /log exceeds the recovery byte limit x1/);
  assert.match(oversizedResult.output, /\nmaterialization: NOT WRITTEN - .*\nRESULT: FAIL\n$/);
  assert.ok(!oversized.logEvents().some(([kind, path]) => kind === 'logRead' && path === huge));
  assert.deepEqual(noCalls, []);
  sizedBeforeRead(oversized);

  // Together over the aggregate bound: no log is read at all.
  const together = logManifestHarness({
    logs: campaign.logs,
    bytes: campaign.bytes,
    sizes: new Map(campaign.order.map((path) => [path, 5 * 1024 * 1024])),
  });
  const togetherResult = runLogRecoveryCli({
    argv: ['--logs-manifest', POSIX_MANIFEST],
    ...together.options,
  });
  assert.equal(togetherResult.exitCode, 1);
  assert.match(togetherResult.output, /logs together exceed the recovery byte limit x1/);
  assert.ok(together.logEvents().every(([kind]) => kind === 'logSize'));
  assert.equal(together.logEvents().length, CAMPAIGN_SLOT_COUNT);

  for (const result of [missingResult, oversizedResult, togetherResult]) {
    for (const leak of ['private', 'job-logs', 'ENOENT']) assert.ok(!result.output.includes(leak));
  }
});

test('logs manifest: duplicate log paths after resolution exit 2 before any log read, on POSIX and injected Windows semantics', () => {
  const attempt = ({ lines, argv, platform = 'posix', cwd = POSIX_CWD }) => {
    const h = logManifestHarness({
      ...(lines ? { bytes: Buffer.from(listOf(lines)) } : {}),
      platform,
      cwd,
    });
    const { fs, calls } = forbiddenFs();
    const result = runLogRecoveryCli({ argv, ...h.options, fs });
    return { result, h, calls };
  };
  const assertDuplicate = (label, run) => {
    assert.equal(run.result.exitCode, 2, label);
    assert.equal(run.result.output, `${USAGE_ERROR.duplicatePath}\n${USAGE_LINE}\n`, label);
    assert.deepEqual(run.h.logEvents(), [], label);
    assert.deepEqual(run.calls, [], label);
  };
  const assertDistinct = (label, run) => {
    assert.equal(run.result.exitCode, 1, `${label}: not a duplicate, so the logs are sized`);
    assert.ok(run.h.logEvents().length >= 2, label);
    assert.ok(!run.result.output.includes('private'), label);
  };

  const posixManifest = (lines) => ({
    lines,
    argv: ['--output-dir', 'private-out', '--logs-manifest', POSIX_MANIFEST],
  });
  for (const lines of [
    ['../job-logs/private-a.log', './../job-logs/private-a.log'],
    ['../job-logs/private-a.log', '/private-campaign/job-logs/private-a.log'],
    ['../job-logs/private-a.log', '../job-logs/sub/../private-a.log'],
    ['../job-logs/private-a.log', '../job-logs//private-a.log'],
    ['../job-logs/private-a.log', '../job-logs/private-b.log', '../job-logs/private-a.log/'],
  ]) {
    assertDuplicate(`posix manifest ${lines.join(' ')}`, attempt(posixManifest(lines)));
  }
  for (const lines of [
    ['../job-logs/private-a.log', '../job-logs/PRIVATE-A.log'],
    ['../job-logs/private-a.log', '../job-logs/private-a.log.'],
  ]) {
    assertDistinct(`posix manifest ${lines.join(' ')}`, attempt(posixManifest(lines)));
  }

  const winManifest = (lines) => ({
    lines,
    argv: ['--logs-manifest', WIN_MANIFEST],
    platform: 'win32',
    cwd: WIN_CWD,
  });
  for (const lines of [
    ['..\\job-logs\\private-a.log', '../JOB-LOGS/PRIVATE-A.LOG'],
    ['..\\job-logs\\private-a.log', 'D:\\private-campaign\\job-logs\\private-a.log.'],
    ['..\\job-logs\\private-a.log', 'd:/private-campaign/job-logs/private-a.log'],
    ['..\\job-logs\\private-a.log', '..\\job-logs \\private-a.log...'],
  ]) {
    assertDuplicate(`win32 manifest ${lines.join(' ')}`, attempt(winManifest(lines)));
  }
  assertDistinct(
    'win32 manifest distinct names',
    attempt(winManifest(['..\\job-logs\\private-a.log', '..\\job-logs\\private-b.log'])),
  );

  // Explicit paths are compared after resolution against the working directory, in both semantics.
  for (const argv of [
    ['logs/private-a.log', './logs/private-a.log'],
    ['logs/private-a.log', `${POSIX_CWD}/logs/private-a.log`],
    ['--output-dir', 'private-out', 'logs/private-a.log', 'logs/x/../private-a.log'],
  ]) {
    assertDuplicate(`posix explicit ${argv.join(' ')}`, attempt({ argv }));
  }
  assertDistinct(
    'posix explicit case differs',
    attempt({ argv: ['logs/private-a.log', 'logs/Private-A.log'] }),
  );
  for (const argv of [
    ['logs\\private-a.log', 'LOGS/PRIVATE-A.log.'],
    ['logs\\private-a.log', `${WIN_CWD}\\logs\\private-a.log`],
  ]) {
    assertDuplicate(
      `win32 explicit ${argv.join(' ')}`,
      attempt({ argv, platform: 'win32', cwd: WIN_CWD }),
    );
  }
});

test('logs manifest: shuffled relative lines resolve against the manifest directory, reach recovery in line order, and equal explicit mode', () => {
  const campaign = memoryLogCampaign(
    withSlot(
      fullCampaignLogs(),
      10,
      jobLog(report(11, { kind: 'event' }), { prefixed: true, crlf: true, red: true }),
    ),
  );
  assert.notDeepEqual(campaign.order, [...campaign.order].sort(), 'the manifest is shuffled');
  const explicit = logManifestHarness({ logs: campaign.logs });
  const baseline = runLogRecoveryCli({
    argv: campaign.order,
    ...explicit.options,
    fs: forbiddenFs().fs,
  });
  assert.equal(baseline.exitCode, 0, baseline.output);
  assert.equal(
    baseline.output,
    formatRecovery(
      recoverAndAccount(campaign.order.map((path) => ({ text: campaign.logs.get(path) }))),
    ),
  );
  const expectedLogEvents = [
    ...campaign.order.map((path) => ['logSize', path]),
    ...campaign.order.map((path) => ['logRead', path]),
  ];
  assert.deepEqual(explicit.logEvents(), expectedLogEvents);

  // Read-only. The manifest path itself resolves against the caller; its lines never do.
  for (const argv of [
    ['--logs-manifest', POSIX_MANIFEST],
    ['--', '--logs-manifest', '../../private-campaign/lists/private-logs.list'],
  ]) {
    const h = logManifestHarness({ logs: campaign.logs, bytes: campaign.bytes });
    const { fs, calls } = forbiddenFs();
    const result = runLogRecoveryCli({ argv, ...h.options, fs });
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(result.output, baseline.output, 'identical to explicit mode');
    assert.deepEqual(calls, []);
    assert.deepEqual(h.events.slice(0, 2), [
      ['manifestSize', POSIX_MANIFEST],
      ['manifestRead', POSIX_MANIFEST],
    ]);
    assert.deepEqual(
      h.events.slice(2),
      expectedLogEvents,
      'sizes first, then reads, in line order',
    );
  }

  // Resolving the same lines against the caller's directory would name nothing that exists.
  const callerRelative = logManifestHarness({
    logs: new Map(
      [...campaign.logs].map(([path, text]) => [
        posix.resolve(POSIX_CWD, `../job-logs/${posix.basename(path)}`),
        text,
      ]),
    ),
    bytes: campaign.bytes,
  });
  const wrongBase = runLogRecoveryCli({
    argv: ['--logs-manifest', POSIX_MANIFEST],
    ...callerRelative.options,
  });
  assert.equal(wrongBase.exitCode, 1);
  assert.match(wrongBase.output, /log could not be read x59/);

  // Materializing, with --output-dir before or after the manifest option.
  const explicitFake = new FakeFs({ dirs: [FAKE_PARENT] });
  const explicitWritten = runLogRecoveryCli({
    argv: ['--output-dir', FAKE_TARGET, ...campaign.order],
    ...logManifestHarness({ logs: campaign.logs }).options,
    fs: explicitFake,
  });
  assert.equal(explicitWritten.exitCode, 0, explicitWritten.output);
  for (const argv of [
    ['--', '--output-dir', FAKE_TARGET, '--logs-manifest', POSIX_MANIFEST],
    ['--logs-manifest', POSIX_MANIFEST, '--output-dir', FAKE_TARGET],
  ]) {
    const h = logManifestHarness({ logs: campaign.logs, bytes: campaign.bytes });
    const fake = new FakeFs({ dirs: [FAKE_PARENT] });
    const result = runLogRecoveryCli({ argv, ...h.options, fs: fake });
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(result.output, explicitWritten.output);
    assert.match(result.output, /\nmaterialization: WRITTEN - 59 report files .*\nRESULT: PASS\n$/);
    assert.deepEqual(
      [...fake.files.keys()].map((path) => [dirname(path), basename(path)]),
      SLOT_NAMES.map((name) => [FAKE_TARGET, name]),
    );
    for (let slot = 1; slot <= CAMPAIGN_SLOT_COUNT; slot += 1) {
      const expected = slot === 11 ? report(11, { kind: 'event' }) : report(slot);
      assert.ok(
        fake.files.get(join(FAKE_TARGET, reportFileName(slot))).equals(Buffer.from(expected)),
      );
    }
    assertOnlyOwnedMutations(fake);
    assert.deepEqual(fake.calls, explicitFake.calls, 'the same output calls as explicit mode');
    for (const leak of ['private', 'job-logs', STAGING_PREFIX, FAKE_PARENT]) {
      assert.ok(!result.output.includes(leak), leak);
    }
  }
});

// ---------------------------------------------------------------------------
// The real package command, spawned through pnpm with one short manifest path

const CMD_EXE_LIMIT = 8191;
const RECOVERY_SCRIPT = 'recover:aggregation-campaign-logs';

/** `pnpm --silent run recover:aggregation-campaign-logs -- <args>`, spawned from `cwd`. */
function runPackageRecovery(args, cwd) {
  const argv = ['--dir', repoRoot, '--silent', 'run', RECOVERY_SCRIPT, '--', ...args];
  const options = { cwd, encoding: 'utf8', timeout: 120_000 };
  if (process.platform !== 'win32') return spawnSync('pnpm', argv, options);
  // pnpm is a .cmd shim on Windows and runs through cmd.exe: only arguments that need no quoting
  // are passed, and the whole command line stays short.
  for (const arg of argv) assert.match(arg, /^[\w:\\/.~-]+$/, 'argument needs no cmd.exe quoting');
  const command = ['pnpm', ...argv].join(' ');
  assert.ok(command.length < 1024, 'the command line is short');
  return spawnSync(command, { ...options, shell: true });
}

/** Relative name → type, size, mtime and SHA-256 for every entry under `root`. */
function snapshotTree(root) {
  const entries = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join('/');
      const stats = lstatSync(full);
      if (stats.isDirectory()) {
        entries.set(rel, { type: 'dir', mtimeMs: stats.mtimeMs });
        walk(full);
      } else {
        const bytes = stats.isFile() ? readFileSync(full) : Buffer.alloc(0);
        entries.set(rel, {
          type: stats.isFile() ? 'file' : 'other',
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  };
  walk(root);
  return entries;
}

/** Every added, removed or changed relative name between two snapshots. */
function treeChanges(before, after) {
  const added = [...after.keys()].filter((name) => !before.has(name)).sort();
  const removed = [...before.keys()].filter((name) => !after.has(name)).sort();
  const changed = [...after.keys()]
    .filter(
      (name) =>
        before.has(name) && JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name)),
    )
    .sort();
  return { added, removed, changed };
}

const UNCHANGED = Object.freeze({ added: [], removed: [], changed: [] });

test('logs manifest (spawned pnpm package command): 59 long log paths travel through one short manifest path; read-only writes nothing, --output-dir creates only its directory', () => {
  const root = tempDir();
  const segment = `${'long-directory-segment-'.repeat(2)}ab`;
  const logDir = join(root, 'private-job-logs', segment, segment);
  const caller = join(root, 'private-caller', 'nested');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(caller, { recursive: true });
  const texts = withSlot(
    fullCampaignLogs(),
    10,
    jobLog(report(11, { kind: 'event' }), { prefixed: true, crlf: true, red: true }),
  );
  const logPaths = texts.map((text, index) => {
    const path = join(logDir, `private-job-${String(index).padStart(2, '0')}.log`);
    writeFileSync(path, text);
    return path;
  });
  const order = shuffled(logPaths, 23);
  assert.notDeepEqual(order, logPaths);
  const lines = order.map((path) => relative(root, path).split(sep).join('/'));
  const manifest = join(root, 'm.list');
  writeFileSync(manifest, listOf(lines));
  const crlfManifest = join(root, 'crlf.list');
  writeFileSync(crlfManifest, listOf(lines).replaceAll('\n', '\r\n'));

  // Passed one by one, the logs alone would overflow cmd.exe; each path stays bounded.
  const explicitLength = logPaths.reduce((total, path) => total + path.length + 3, 0);
  assert.ok(explicitLength > CMD_EXE_LIMIT, `explicit form is ${explicitLength} characters`);
  for (const path of logPaths) {
    assert.ok(path.length < 250 && Buffer.byteLength(path) <= 1024, 'each path is bounded');
  }
  assert.ok(manifest.length < 200, 'one short manifest path');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts[RECOVERY_SCRIPT],
    'node scripts/aggregation-campaign-log-recovery.mjs',
    'the operational package script is unchanged',
  );

  const assertClean = (label, result) => {
    assert.equal(result.stderr, '', `${label}: nothing on stderr`);
    for (const leak of [
      root,
      basename(root),
      'private',
      'long-directory-segment',
      '.list',
      '.log',
      STAGING_PREFIX,
      'ENOENT',
      'Error:',
      '    at ',
    ]) {
      assert.ok(!result.stdout.includes(leak), `${label} leaks ${leak}`);
    }
  };

  // Read-only: exit 0, the same output as the in-process explicit form, and no change at all.
  const before = snapshotTree(root);
  const readOnly = runPackageRecovery(['--logs-manifest', manifest], caller);
  assert.equal(readOnly.status, 0, readOnly.stdout + readOnly.stderr);
  assert.match(
    readOnly.stdout,
    /^recovery: logs=59 readable_logs=59 recovered_reports=59 rejections=0$/m,
  );
  assert.match(readOnly.stdout, /\nRESULT: PASS\n$/);
  assert.equal(readOnly.stdout, runLogRecoveryCli({ argv: order }).output);
  assertClean('read-only', readOnly);
  const afterReadOnly = snapshotTree(root);
  assert.deepEqual(treeChanges(before, afterReadOnly), UNCHANGED);

  // A malformed manifest: exit 2 through pnpm, one fixed line, and no change.
  const malformed = runPackageRecovery(['--logs-manifest', crlfManifest], caller);
  assert.equal(malformed.status, 2);
  assert.equal(
    malformed.stdout,
    `logs manifest: ${PATH_MANIFEST_PROBLEM.carriageReturn}\n${USAGE_LINE}\n`,
  );
  assertClean('malformed', malformed);
  const afterMalformed = snapshotTree(root);
  assert.deepEqual(treeChanges(afterReadOnly, afterMalformed), UNCHANGED);

  // Materializing: only the requested directory and exactly its 59 reports appear.
  const outName = 'private-recovered';
  const written = runPackageRecovery(
    ['--output-dir', join(root, outName), '--logs-manifest', manifest],
    caller,
  );
  assert.equal(written.status, 0, written.stdout + written.stderr);
  assert.match(
    written.stdout,
    /\nmaterialization: WRITTEN - 59 report files slot-01\.txt\.\.slot-59\.txt in a newly created output directory\nRESULT: PASS\n$/,
  );
  assertClean('materializing', written);
  const afterWritten = snapshotTree(root);
  assert.deepEqual(treeChanges(afterMalformed, afterWritten), {
    added: [outName, ...SLOT_NAMES.map((name) => `${outName}/${name}`)].sort(),
    removed: [],
    changed: [],
  });
  for (let slot = 1; slot <= CAMPAIGN_SLOT_COUNT; slot += 1) {
    const expected = Buffer.from(slot === 11 ? report(11, { kind: 'event' }) : report(slot));
    const entry = afterWritten.get(`${outName}/${reportFileName(slot)}`);
    assert.equal(entry.size, expected.length, `slot ${slot} size`);
    assert.equal(
      entry.sha256,
      createHash('sha256').update(expected).digest('hex'),
      `slot ${slot} bytes`,
    );
  }
});
