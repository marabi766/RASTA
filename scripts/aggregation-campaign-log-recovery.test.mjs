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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CAMPAIGN_SLOT_COUNT,
  SLOT_STATE,
  accountCampaign,
  formatAccounting,
} from './aggregation-campaign-accounting-lib.mjs';
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
  RECOVERY_REASON,
  extractReportCandidates,
  formatRecovery,
  recoverAndAccount,
  recoverCalibrationReports,
} from './aggregation-campaign-log-recovery-lib.mjs';
import { runLogRecoveryCli } from './aggregation-campaign-log-recovery.mjs';

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
