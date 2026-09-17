/**
 * Report-path manifests for the manual ADR-055 campaign tools — how 59 report
 * paths reach a command without a long command line, never evidence.
 *
 * On Windows, `pnpm run` passes arguments through `cmd.exe`, whose command
 * line is limited to 8191 characters; 59 long report paths per cohort can
 * exceed it. A report-path manifest is a plain path list instead:
 * `parseReportManifest` accepts exactly 59 LF-terminated lines of strict UTF-8
 * and resolves each against the manifest's own directory. It is
 * operator-supplied transport only: it proves nothing about authenticity or
 * provenance, and its line order means nothing because every tool still reads
 * slots from report content.
 *
 * Shared by `compare:aggregation-campaign-retrievals`,
 * `account:aggregation-campaign` and `review:aggregation-campaign-image-cohort`
 * so the grammar, bounds and duplicate policy exist once. The same grammar
 * with another entry count, `parsePathManifest` / `loadPathManifest`, carries
 * the job-log paths of `recover:aggregation-campaign-logs --logs-manifest`.
 * This module holds only bounded parsing, path arithmetic and constants: no
 * slot, report, log, classification or cohort logic. It imports no file system
 * API; the loaders perform only the size check and read their caller injects.
 * Diagnostics are fixed sentences; no path, manifest line or OS error is ever
 * part of them.
 */
import { posix, win32 } from 'node:path';

import { CAMPAIGN_SLOT_COUNT } from './aggregation-campaign-accounting-lib.mjs';

/** Bounds of one report path as given: one argument or one manifest line. */
export const REPORT_PATH_LIMITS = Object.freeze({
  /** UTF-8 bytes of one report or manifest path. */
  maxPathBytes: 1024,
});

/** A manifest lists exactly the campaign's reports, each line at most one bounded path plus LF. */
export const MAX_REPORT_MANIFEST_BYTES =
  CAMPAIGN_SLOT_COUNT * (REPORT_PATH_LIMITS.maxPathBytes + 1);

/** Fixed path-manifest problems shared by every entry count, in the order they are checked. */
export const PATH_MANIFEST_PROBLEM = Object.freeze({
  unreadable: 'manifest could not be read',
  tooLarge: 'manifest exceeds the byte limit',
  bom: 'manifest starts with a byte order mark',
  notUtf8: 'manifest is not valid UTF-8',
  carriageReturn: 'manifest contains a carriage return (only LF line endings are accepted)',
  control: 'manifest contains NUL or another control character',
  finalNewline: 'manifest does not end with a line feed',
  blankLine: 'manifest contains a blank line',
  whitespace: 'manifest entry has leading or trailing whitespace',
  optionLike: 'manifest entry starts with -',
  notPlainPath: 'manifest entry looks like a comment, quoted value, URL or drive-relative path',
  entryTooLong: 'manifest entry exceeds the path byte limit',
});

/** Fixed manifest-contract problems, in the order they are checked. */
export const REPORT_MANIFEST_PROBLEM = Object.freeze({
  ...PATH_MANIFEST_PROBLEM,
  lineCount: `manifest does not list exactly ${CAMPAIGN_SLOT_COUNT} report paths`,
});

/** The byte bound of a manifest of at most `maxEntries` bounded paths, each plus LF. */
export const pathManifestMaxBytes = (maxEntries, limits = REPORT_PATH_LIMITS) =>
  maxEntries * (limits.maxPathBytes + 1);

/** `minEntries..maxEntries` must be a non-empty range of positive safe integers. */
function assertEntryRange(minEntries, maxEntries) {
  if (
    !Number.isSafeInteger(minEntries) ||
    !Number.isSafeInteger(maxEntries) ||
    minEntries < 1 ||
    maxEntries < minEntries
  ) {
    throw new RangeError('a path manifest needs 1 <= minEntries <= maxEntries');
  }
}

const strictUtf8 = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const MANIFEST_CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F]/;
// `#` comments, quoting, `scheme:` URLs (two or more letters) and Windows
// drive-relative `C:name`, whose base would be a per-drive working directory.
const NOT_PLAIN_PATH = /^[#"']|["']$|^[A-Za-z][A-Za-z0-9+.-]+:|^[A-Za-z]:(?![\\/])/;

/** The path functions of one platform; `resolve` is only ever called with an absolute base. */
export const pathApiFor = (platform) => (platform === 'win32' ? win32 : posix);

/** Whether one path as given exceeds the path byte bound. */
export const exceedsPathBytes = (path, limits = REPORT_PATH_LIMITS) =>
  Buffer.byteLength(path, 'utf8') > limits.maxPathBytes;

/**
 * Parses one bounded path manifest: strict UTF-8 without BOM, between
 * `minEntries` and `maxEntries` non-empty LF-terminated lines, one path per
 * line, nothing else, at most `pathManifestMaxBytes(maxEntries)` bytes. A
 * relative entry resolves against `manifestDir` (the absolute directory holding
 * the manifest), never against the caller's working directory. Returns
 * `{ ok: true, paths }` in line order, or `{ ok: false, problem }` with a fixed
 * `PATH_MANIFEST_PROBLEM` sentence or the caller's fixed `countProblem`.
 */
export function parsePathManifest(
  bytes,
  {
    manifestDir,
    platform = 'posix',
    limits = REPORT_PATH_LIMITS,
    minEntries,
    maxEntries,
    countProblem,
  } = {},
) {
  assertEntryRange(minEntries, maxEntries);
  const fail = (problem) => ({ ok: false, problem });
  const maxBytes = pathManifestMaxBytes(maxEntries, limits);
  if (!Buffer.isBuffer(bytes)) return fail(PATH_MANIFEST_PROBLEM.unreadable);
  if (bytes.length > maxBytes) return fail(PATH_MANIFEST_PROBLEM.tooLarge);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return fail(PATH_MANIFEST_PROBLEM.bom);
  }
  let text;
  try {
    text = strictUtf8().decode(bytes);
  } catch {
    return fail(PATH_MANIFEST_PROBLEM.notUtf8);
  }
  if (text.includes('\r')) return fail(PATH_MANIFEST_PROBLEM.carriageReturn);
  if (MANIFEST_CONTROL.test(text)) return fail(PATH_MANIFEST_PROBLEM.control);
  if (!text.endsWith('\n')) return fail(PATH_MANIFEST_PROBLEM.finalNewline);

  const lines = text.slice(0, -1).split('\n');
  for (const line of lines) {
    if (line === '') return fail(PATH_MANIFEST_PROBLEM.blankLine);
    if (line !== line.trim()) return fail(PATH_MANIFEST_PROBLEM.whitespace);
    if (line.startsWith('-')) return fail(PATH_MANIFEST_PROBLEM.optionLike);
    if (NOT_PLAIN_PATH.test(line)) return fail(PATH_MANIFEST_PROBLEM.notPlainPath);
    if (exceedsPathBytes(line, limits)) return fail(PATH_MANIFEST_PROBLEM.entryTooLong);
  }
  if (lines.length < minEntries || lines.length > maxEntries) return fail(countProblem);

  const api = pathApiFor(platform);
  if (typeof manifestDir !== 'string' || !api.isAbsolute(manifestDir)) {
    return fail(PATH_MANIFEST_PROBLEM.unreadable);
  }
  return { ok: true, paths: lines.map((line) => api.resolve(manifestDir, line)) };
}

/**
 * Reads and parses one bounded path manifest through the caller's injected
 * `sizeOf` and `readBytes`, which are the only file access. The path as given
 * resolves against `cwd`. The size is checked before reading — a size that is
 * not a non-negative safe integer within `pathManifestMaxBytes(maxEntries)`
 * refuses without reading (the fixed problem is `tooLarge`) — and the bytes are
 * checked again by `parsePathManifest`, so growth after the size check is
 * refused too. Returns what `parsePathManifest` returns; any thrown error is
 * `unreadable`.
 */
export function loadPathManifest(
  manifestPath,
  {
    sizeOf,
    readBytes,
    platform = 'posix',
    cwd,
    limits = REPORT_PATH_LIMITS,
    minEntries,
    maxEntries,
    countProblem,
  } = {},
) {
  assertEntryRange(minEntries, maxEntries);
  const api = pathApiFor(platform);
  const absolute = api.resolve(cwd, manifestPath);
  const maxBytes = pathManifestMaxBytes(maxEntries, limits);
  let bytes;
  try {
    const size = sizeOf(absolute);
    if (!(Number.isSafeInteger(size) && size >= 0 && size <= maxBytes)) {
      return { ok: false, problem: PATH_MANIFEST_PROBLEM.tooLarge };
    }
    bytes = readBytes(absolute);
  } catch {
    return { ok: false, problem: PATH_MANIFEST_PROBLEM.unreadable };
  }
  return parsePathManifest(bytes, {
    manifestDir: api.dirname(absolute),
    platform,
    limits,
    minEntries,
    maxEntries,
    countProblem,
  });
}

/** A report-path manifest lists exactly the campaign's slots. */
const REPORT_MANIFEST_ENTRIES = Object.freeze({
  minEntries: CAMPAIGN_SLOT_COUNT,
  maxEntries: CAMPAIGN_SLOT_COUNT,
  countProblem: REPORT_MANIFEST_PROBLEM.lineCount,
});

/**
 * Parses one report-path manifest: strict UTF-8 without BOM, exactly 59
 * non-empty LF-terminated lines, one report path per line, nothing else. A
 * relative entry resolves against `manifestDir` (the absolute directory holding
 * the manifest), never against the caller's working directory. Returns
 * `{ ok: true, paths }` in line order — order means nothing downstream — or
 * `{ ok: false, problem }` with a fixed `REPORT_MANIFEST_PROBLEM` sentence.
 */
export function parseReportManifest(
  bytes,
  { manifestDir, platform = 'posix', limits = REPORT_PATH_LIMITS } = {},
) {
  return parsePathManifest(bytes, { manifestDir, platform, limits, ...REPORT_MANIFEST_ENTRIES });
}

/**
 * Reads and parses one report-path manifest exactly as `loadPathManifest`
 * does, with exactly 59 entries. Returns what `parseReportManifest` returns.
 */
export function loadReportManifest(
  manifestPath,
  { sizeOf, readBytes, platform = 'posix', cwd, limits = REPORT_PATH_LIMITS } = {},
) {
  return loadPathManifest(manifestPath, {
    sizeOf,
    readBytes,
    platform,
    cwd,
    limits,
    ...REPORT_MANIFEST_ENTRIES,
  });
}

/**
 * The key two absolute paths are compared by when looking for a duplicate.
 * String-only and conservative: on Windows, separators are normalized,
 * trailing dots and spaces of each segment are dropped (Windows ignores them)
 * and case is folded, so more spellings collide, never fewer. No file system
 * identity is consulted: hard links, junctions, symlinks and 8.3 short names
 * are not seen.
 */
export function reportPathKey(absolutePath, { platform = 'posix' } = {}) {
  if (platform === 'win32') {
    const normalized = win32.normalize(String(absolutePath));
    const segments = normalized.split('\\');
    const key = segments
      .map((segment, index) => (index === 0 ? segment : segment.replace(/[. ]+$/, '')))
      .join('\\')
      .toLowerCase();
    return key.length > 3 ? key.replace(/\\+$/, '') : key;
  }
  const key = posix.normalize(String(absolutePath));
  return key.length > 1 ? key.replace(/\/+$/, '') : key;
}

/**
 * `groups` maps a name to a list of absolute paths. Returns `null` when every
 * path is distinct within its list and no path appears in two lists (by
 * `reportPathKey`); otherwise `'duplicate'` or `'shared'`. Duplicates are
 * checked first, across every list.
 */
export function findPathCollision(groups, { platform = 'posix' } = {}) {
  const lists = Object.values(groups).map((paths) =>
    paths.map((path) => reportPathKey(path, { platform })),
  );
  for (const keys of lists) {
    if (new Set(keys).size !== keys.length) return 'duplicate';
  }
  const seen = new Set();
  for (const keys of lists) {
    if (keys.some((key) => seen.has(key))) return 'shared';
    for (const key of keys) seen.add(key);
  }
  return null;
}
