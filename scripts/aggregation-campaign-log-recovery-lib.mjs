/**
 * Offline, reference-free recovery of ADR-055 calibration reports from GitHub
 * Actions job-log text.
 *
 * The preregistration (§ 9.3) allows a slot's report to be recovered from its
 * job log when the artifact cannot be downloaded, provided the recovered text
 * is byte-faithful and passes the same validation as a downloaded artifact.
 * The one earlier recovery (launch-readiness § 2.5) cut a slice whose length
 * came from the committed reference file. This library needs no reference:
 *
 * - **Boundaries** are only `CALIBRATION_REPORT_HEADER` and
 *   `CALIBRATION_REPORT_FOOTER`. No line count, file name, artifact or job
 *   name, slot order, job conclusion or colour is read.
 * - **Framing** is modelled fail-closed. Inside one report every line is either
 *   unprefixed or carries exactly one GitHub timestamp prefix
 *   (`YYYY-MM-DDThh:mm:ss.fffffffZ `); modes never mix. Only that prefix and a
 *   terminal CR of CRLF framing are removed; nothing is trimmed, normalised or
 *   de-coloured, and the final newline the report was printed with is restored.
 * - **Validation** is the existing strict `parseSlotReport`; accounting is the
 *   existing `accountCampaign` / `formatAccounting`. Nothing here re-implements
 *   or relaxes either.
 * - **Rejection, never truncation.** A framing defect rejects its whole log; a
 *   limit breach rejects the input it applies to; a report that does not parse
 *   is rejected alone. Every rejection makes the result unclean.
 * - **Materialization plan.** For the CLI's opt-in `--output-dir`, every accepted
 *   string stays bound to the slot `parseSlotReport` read from it, and
 *   `planReportFiles` maps a clean, complete result to `slot-01.txt` … `slot-59.txt`
 *   with those exact strings. Writing the files is the CLI's job, not this file's.
 *
 * Pure: text in, values out. No file system, no network, no GitHub. Diagnostics
 * are fixed sentences with counts only — never a path, a timestamp or a line of
 * log content.
 *
 * **What this cannot prove.** That a future log archive will be retrievable,
 * that a recovered report equals the artifact bytes the job uploaded, or that
 * this works on a real 59-job archive. Those need live evidence.
 */
import {
  CAMPAIGN_SLOT_COUNT,
  accountCampaign,
  formatAccounting,
  parseSlotReport,
} from './aggregation-campaign-accounting-lib.mjs';
import {
  CALIBRATION_REPORT_FOOTER,
  CALIBRATION_REPORT_HEADER,
  MAX_CAMPAIGN_SLOT,
  MIN_CAMPAIGN_SLOT,
} from './aggregation-evidence-lib.mjs';

const MIB = 1024 * 1024;

/** Every bound the recovery enforces. Exceeding one rejects; nothing is cut. */
export const LOG_RECOVERY_LIMITS = Object.freeze({
  /** Explicit log inputs per invocation; a 59-slot campaign needs 59. */
  maxLogs: 128,
  /** Bytes of one log text. */
  maxLogBytes: 64 * MIB,
  /** Bytes across every log text together. */
  maxTotalBytes: 256 * MIB,
  /** Framed report candidates across all logs; more than the campaign has slots is refused. */
  maxReports: CAMPAIGN_SLOT_COUNT,
  /** Lines of one candidate, header and footer included (a one-pair report is 35). */
  maxCandidateLines: 200,
  /** Bytes of one recovered candidate (a one-pair report is about 3.4 KiB). */
  maxCandidateBytes: 32 * 1024,
});

/** `2026-09-16T02:31:05.1234567Z ` — the exact prefix of launch-readiness § 2.5. */
const TIMESTAMP_PREFIX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{7}Z /;
const TIMESTAMP_PREFIX_LENGTH = 'YYYY-MM-DDThh:mm:ss.fffffffZ '.length;
/** Anything that starts like a timestamp, valid or not. */
const TIMESTAMP_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** C0 (tab and ESC included), DEL, C1, line/paragraph separators, BOM, replacement char. */
const codePointRange = (from, to) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`;
const CONTROL = new RegExp(
  `[${codePointRange(0x00, 0x1f)}${codePointRange(0x7f, 0x9f)}${String.fromCodePoint(0x2028, 0x2029, 0xfeff, 0xfffd)}]`,
);

export const RECOVERY_REASON = Object.freeze({
  noLogs: 'no log was given',
  tooManyLogs: 'more logs than the recovery limit',
  totalTooLarge: 'logs together exceed the recovery byte limit',
  unreadable: 'log could not be read',
  logTooLarge: 'log exceeds the recovery byte limit',
  empty: 'log is empty',
  noReport: 'log contains no calibration report',
  boundaryFraming: 'report boundary text appears in unrecognised framing',
  orphanFooter: 'report footer without a preceding header',
  nestedHeader: 'report header inside an open report',
  unterminated: 'report header without a footer',
  truncatedFraming: 'report line has no line terminator (truncated framing)',
  mixedLineEndings: 'report mixes CRLF and LF line endings',
  malformedTimestamp: 'report line has a malformed timestamp prefix',
  timestampInPlain: 'timestamp-like prefix inside an unprefixed report',
  unprefixedInTimestamped: 'unprefixed line inside a timestamp-prefixed report',
  repeatedTimestamp: 'report line carries more than one timestamp prefix',
  control: 'control character inside a report',
  candidateLines: 'report candidate exceeds the line limit',
  candidateBytes: 'report candidate exceeds the byte limit',
  tooManyReports: 'more report candidates than campaign slots',
  unparseable: 'recovered report does not parse',
});

const MAX_REASON_CHARS = 160;

class RecoveryRejection extends Error {}

const refuse = (reason) => {
  throw new RecoveryRejection(reason);
};

function validTimestamp(match) {
  const [, , month, day, hour, minute, second] = match.map(Number);
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59
  );
}

/** `{ body }` for a line with exactly one valid prefix, else `null`. */
function stripTimestamp(content) {
  const match = TIMESTAMP_PREFIX.exec(content);
  if (!match || !validTimestamp(match)) return null;
  return content.slice(TIMESTAMP_PREFIX_LENGTH);
}

/**
 * Splits log text into physical lines. Only LF splits a line; a single CR
 * directly before it is framing and is recorded, not kept. The last line is
 * `terminated: false` when the text does not end with LF.
 */
function physicalLines(text) {
  const parts = text.split('\n');
  const endsWithNewline = parts.at(-1) === '';
  if (endsWithNewline) parts.pop();
  return parts.map((part, index) => {
    const crlf = part.endsWith('\r');
    return {
      content: crlf ? part.slice(0, -1) : part,
      crlf,
      terminated: endsWithNewline || index < parts.length - 1,
    };
  });
}

/** `'header' | 'footer' | null` and the framing mode, or a rejection. */
function boundaryOf(content) {
  for (const [kind, text] of [
    ['header', CALIBRATION_REPORT_HEADER],
    ['footer', CALIBRATION_REPORT_FOOTER],
  ]) {
    if (!content.includes(text)) continue;
    if (content === text) return { kind, prefixed: false };
    if (stripTimestamp(content) === text) return { kind, prefixed: true };
    refuse(RECOVERY_REASON.boundaryFraming);
  }
  return { kind: null };
}

/** The recovered body of one line inside an open report, or a rejection. */
function bodyOf(line, open) {
  if (line.crlf !== open.crlf) refuse(RECOVERY_REASON.mixedLineEndings);
  if (!line.terminated) refuse(RECOVERY_REASON.truncatedFraming);
  let body;
  if (open.prefixed) {
    body = stripTimestamp(line.content);
    if (body === null) {
      refuse(
        TIMESTAMP_LIKE.test(line.content)
          ? RECOVERY_REASON.malformedTimestamp
          : RECOVERY_REASON.unprefixedInTimestamped,
      );
    }
    if (TIMESTAMP_LIKE.test(body)) refuse(RECOVERY_REASON.repeatedTimestamp);
  } else {
    if (TIMESTAMP_LIKE.test(line.content)) refuse(RECOVERY_REASON.timestampInPlain);
    body = line.content;
  }
  if (CONTROL.test(body)) refuse(RECOVERY_REASON.control);
  return body;
}

/**
 * Every framed report candidate of one log, in log order, or one rejection
 * reason for the whole log. A candidate is text from a header line to the next
 * footer line inclusive, with framing removed and one trailing newline.
 */
export function extractReportCandidates(text, limits = LOG_RECOVERY_LIMITS) {
  try {
    if (text.length === 0) refuse(RECOVERY_REASON.empty);
    const candidates = [];
    let open = null;
    for (const line of physicalLines(text)) {
      const boundary = boundaryOf(line.content);
      if (open === null) {
        if (boundary.kind === 'footer') refuse(RECOVERY_REASON.orphanFooter);
        if (boundary.kind !== 'header') continue;
        open = { prefixed: boundary.prefixed, crlf: line.crlf, lines: [], bytes: 0 };
      } else if (boundary.kind === 'header') {
        refuse(RECOVERY_REASON.nestedHeader);
      }
      const body = bodyOf(line, open);
      open.lines.push(body);
      open.bytes += Buffer.byteLength(body, 'utf8') + 1;
      if (open.lines.length > limits.maxCandidateLines) refuse(RECOVERY_REASON.candidateLines);
      if (open.bytes > limits.maxCandidateBytes) refuse(RECOVERY_REASON.candidateBytes);
      if (boundary.kind === 'footer') {
        candidates.push(`${open.lines.join('\n')}\n`);
        open = null;
      }
    }
    if (open !== null) refuse(RECOVERY_REASON.unterminated);
    if (candidates.length === 0) refuse(RECOVERY_REASON.noReport);
    return { ok: true, candidates };
  } catch (error) {
    if (error instanceof RecoveryRejection) return { ok: false, reason: error.message };
    throw error;
  }
}

const bounded = (reason) =>
  reason.length <= MAX_REASON_CHARS ? reason : `${reason.slice(0, MAX_REASON_CHARS - 1)}…`;

/**
 * Recovers every report from a list of logs, each `{ text }`,
 * `{ unreadable: true }` or `{ oversized: true, bytes }`. Deterministic in the multiset of logs: the recovered
 * reports are sorted and rejections are counted by fixed reason, so neither
 * input order nor any name can influence the result.
 */
export function recoverCalibrationReports(logs, { limits = LOG_RECOVERY_LIMITS } = {}) {
  const list = Array.isArray(logs) ? logs : [];
  const rejections = {};
  const reject = (reason, count = 1) => {
    const key = bounded(reason);
    rejections[key] = (rejections[key] ?? 0) + count;
  };
  const finish = (reports) => {
    const sorted = [...reports].map(({ text }) => text).sort();
    // The same accepted strings, each bound to the slot `parseSlotReport` read
    // from it; ordered by slot, then text, so no input order can show through.
    const slotReports = [...reports]
      .map(({ slot, text }) => Object.freeze({ slot, text }))
      .sort((a, b) => a.slot - b.slot || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
    const rejectedCount = Object.values(rejections).reduce((sum, n) => sum + n, 0);
    return {
      logs: list.length,
      readableLogs: list.filter((log) => log && !log.unreadable && typeof log.text === 'string')
        .length,
      reports: sorted,
      slotReports,
      rejections: Object.fromEntries(
        Object.entries(rejections).sort(([a], [b]) => a.localeCompare(b)),
      ),
      rejectedCount,
      clean: rejectedCount === 0,
    };
  };

  if (list.length === 0) {
    reject(RECOVERY_REASON.noLogs);
    return finish([]);
  }
  if (list.length > limits.maxLogs) {
    reject(RECOVERY_REASON.tooManyLogs);
    return finish([]);
  }
  // A caller that did not read an input (because its size alone breaks a limit)
  // passes `{ oversized: true, bytes }`; its size still counts toward the total.
  const sizeOf = (log) =>
    typeof log?.text === 'string'
      ? Buffer.byteLength(log.text, 'utf8')
      : Number.isSafeInteger(log?.bytes) && log.bytes > 0
        ? log.bytes
        : 0;
  const totalBytes = list.reduce((sum, log) => sum + sizeOf(log), 0);
  if (totalBytes > limits.maxTotalBytes) {
    reject(RECOVERY_REASON.totalTooLarge);
    return finish([]);
  }

  const candidates = [];
  for (const log of list) {
    if (log?.oversized) {
      reject(RECOVERY_REASON.logTooLarge);
      continue;
    }
    if (!log || log.unreadable || typeof log.text !== 'string') {
      reject(RECOVERY_REASON.unreadable);
      continue;
    }
    if (Buffer.byteLength(log.text, 'utf8') > limits.maxLogBytes) {
      reject(RECOVERY_REASON.logTooLarge);
      continue;
    }
    const extracted = extractReportCandidates(log.text, limits);
    if (!extracted.ok) reject(extracted.reason);
    else candidates.push(...extracted.candidates);
  }

  if (candidates.length > limits.maxReports) {
    reject(RECOVERY_REASON.tooManyReports);
    return finish([]);
  }

  const reports = [];
  for (const candidate of candidates) {
    const parsed = parseSlotReport(candidate);
    if (parsed.ok) reports.push({ slot: parsed.report.slot, text: candidate });
    else reject(`${RECOVERY_REASON.unparseable}: ${parsed.reason}`);
  }
  return finish(reports);
}

/**
 * Recovery, then the existing slot accounting over exactly the recovered
 * reports. Exit 0 only for a clean recovery and a complete accounting.
 */
export function recoverAndAccount(logs, options) {
  const recovery = recoverCalibrationReports(logs, options);
  const accounting = accountCampaign(recovery.reports.map((text) => ({ text })));
  const ok = recovery.clean && accounting.complete;
  return { recovery, accounting, ok, exitCode: ok ? 0 : 1 };
}

// ---------------------------------------------------------------------------
// Materialization plan — which exact bytes go into which fixed file name

/** Digits of the largest slot, so every name has the same bounded ASCII shape. */
const SLOT_NAME_DIGITS = String(MAX_CAMPAIGN_SLOT).length;

/**
 * The fixed file name for a slot: `slot-01.txt` … `slot-59.txt`. Derived only
 * from the integer slot, never from a path, a job name or report text.
 */
export function reportFileName(slot) {
  if (!Number.isInteger(slot) || slot < MIN_CAMPAIGN_SLOT || slot > MAX_CAMPAIGN_SLOT) {
    throw new RangeError('slot is outside the campaign range');
  }
  return `slot-${String(slot).padStart(SLOT_NAME_DIGITS, '0')}.txt`;
}

/** Fixed, value-free outcome sentences for the opt-in `--output-dir` form. */
export const MATERIALIZATION_REASON = Object.freeze({
  notComplete: 'recovery or accounting is not complete',
  binding: 'recovered reports do not bind one to one to the campaign slots',
  invalidName: 'output path has no usable directory name',
  exists: 'output path already exists',
  uncheckable: 'output path could not be checked',
  parent: 'output parent is not an existing directory that is not a link',
  staging: 'staging directory could not be created',
  stagingOutside: 'staging directory is not inside the output parent',
  create: 'report file could not be created exclusively',
  verify: 'report file bytes did not verify after writing',
  entries: 'staging directory holds unexpected entries',
  rename: 'output directory could not be put in place',
  placed: 'output directory was put in place but could not be confirmed',
});

/** Cleanup outcomes after a failure; staging is never removed recursively. */
export const MATERIALIZATION_CLEANUP = Object.freeze({
  none: 'nothing was created',
  removed: 'owned staging state was removed',
  incomplete: 'owned staging state could not be fully removed',
  notRemoved: 'nothing was removed',
  leftInPlace: 'the output directory was left in place for inspection',
});

/**
 * The files a complete, clean recovery may write, or a fixed refusal. Every
 * slot `1..59` must be bound to exactly one recovered string, and that string
 * must still pass the unchanged `parseSlotReport` with that same slot. The
 * text is the accepted recovered string itself — nothing is re-rendered.
 */
export function planReportFiles(result) {
  const refuse = (reason) => ({ ok: false, reason });
  if (!result?.ok || result.recovery?.clean !== true || result.accounting?.complete !== true) {
    return refuse(MATERIALIZATION_REASON.notComplete);
  }
  const entries = Array.isArray(result.recovery.slotReports) ? result.recovery.slotReports : [];
  if (entries.length !== CAMPAIGN_SLOT_COUNT) return refuse(MATERIALIZATION_REASON.binding);

  const files = [];
  for (let slot = MIN_CAMPAIGN_SLOT; slot <= MAX_CAMPAIGN_SLOT; slot += 1) {
    const bound = entries.filter((entry) => entry?.slot === slot);
    if (bound.length !== 1 || typeof bound[0].text !== 'string') {
      return refuse(MATERIALIZATION_REASON.binding);
    }
    const parsed = parseSlotReport(bound[0].text);
    if (!parsed.ok || parsed.report.slot !== slot) return refuse(MATERIALIZATION_REASON.binding);
    files.push(Object.freeze({ slot, name: reportFileName(slot), text: bound[0].text }));
  }
  return { ok: true, files };
}

/**
 * One line describing the materialization outcome, from fixed sentences only:
 * `{ written: true, count }` or `{ written: false, reason, cleanup }`.
 */
export function formatMaterialization(outcome) {
  if (outcome?.written === true) {
    return `materialization: WRITTEN - ${outcome.count} report files ${reportFileName(
      MIN_CAMPAIGN_SLOT,
    )}..${reportFileName(MAX_CAMPAIGN_SLOT)} in a newly created output directory`;
  }
  const label = outcome?.reason === MATERIALIZATION_REASON.notComplete ? 'NOT WRITTEN' : 'FAILED';
  return `materialization: ${label} - ${outcome?.reason}; ${outcome?.cleanup}`;
}

/**
 * Recovery counts first, then the unchanged accounting text, then one verdict.
 * Without `materialization` the text is exactly the read-only form's. With it,
 * one materialization line precedes the verdict, and `PASS` also requires that
 * the files were written.
 */
export function formatRecovery({ recovery, accounting, ok }, { materialization } = {}) {
  const rejections = Object.entries(recovery.rejections);
  const lines = [
    'ADR-055 campaign log recovery - offline and reference-free; boundaries are the calibration header and footer only',
    `recovery: logs=${recovery.logs} readable_logs=${recovery.readableLogs} recovered_reports=${recovery.reports.length} rejections=${recovery.rejectedCount}`,
    `recovery rejections: ${
      rejections.length === 0
        ? 'none'
        : rejections.map(([reason, count]) => `${reason} x${count}`).join('; ')
    }`,
    `recovery: ${recovery.clean ? 'CLEAN' : 'REJECTED - at least one log or report was refused; nothing was truncated'}`,
    'not provable offline: that a real archive is retrievable, that recovered text equals the uploaded artifact bytes, or that a real 59-job archive recovers',
    '',
  ];
  if (materialization === undefined) {
    return `${lines.join('\n')}${formatAccounting(accounting)}RESULT: ${ok ? 'PASS' : 'FAIL'}\n`;
  }
  const pass = ok && materialization.written === true;
  return `${lines.join('\n')}${formatAccounting(accounting)}${formatMaterialization(
    materialization,
  )}\nRESULT: ${pass ? 'PASS' : 'FAIL'}\n`;
}
