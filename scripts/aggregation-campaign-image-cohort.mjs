#!/usr/bin/env node
/**
 * Reviews the runner/image cohort of the preregistered ADR-055 fresh-run
 * campaign: the pre-launch release snapshot, then the post-run comparison of
 * the 59 campaign reports.
 *
 * Two input modes for the reports; the JSON review manifest always comes first:
 *
 *   Explicit paths:
 *   node scripts/aggregation-campaign-image-cohort.mjs <review-manifest> <report> [<report> ...]
 *   pnpm run review:aggregation-campaign-image-cohort -- <review-manifest> <report> [<report> ...]
 *
 *   Report-path manifest (recommended on Windows, where `pnpm run` passes 59
 *   long paths through `cmd.exe` and its command-line length limit):
 *   node scripts/aggregation-campaign-image-cohort.mjs <review-manifest> --reports-manifest <file>
 *   pnpm run review:aggregation-campaign-image-cohort -- <review-manifest> --reports-manifest <file>
 *
 * The `<review-manifest>` is the JSON pre-launch snapshot, read and validated
 * exactly as before. The `--reports-manifest <file>` is something else
 * entirely: a plain list of the 59 report paths in the exact grammar of the
 * retrieval comparator's cohort manifests
 * (`aggregation-campaign-report-manifest-lib.mjs`: strict UTF-8 without BOM,
 * exactly 59 LF-terminated lines of one path each, at most 1024 UTF-8 bytes per
 * line and 60 475 bytes in all; relative lines resolve against its own
 * directory; line order means nothing). It is operator-supplied transport, not
 * evidence.
 *
 * Usage and report-path-manifest errors exit 2 before the review manifest or
 * any report is read:
 *
 * - no review manifest, or `--reports-manifest` before it;
 * - an unknown option, `--reports-manifest=value`, or a repeated manifest option;
 * - a manifest option without exactly one following path (none, empty or
 *   starting with `-`), or any argument after it;
 * - explicit report paths mixed with a manifest option;
 * - no report, an empty path, a path starting with `-` (write `./-name`), a
 *   path longer than 1024 UTF-8 bytes, or more than `MAX_REPORT_PATHS` reports;
 * - `--` anywhere but before the first real argument (pnpm forwards a leading one);
 * - the same report path twice (compared after resolution; on Windows
 *   case-insensitively, ignoring trailing dots and spaces; file system
 *   identity such as links or 8.3 names is not consulted);
 * - a report-path manifest that cannot be read, exceeds its byte limit
 *   (checked before and after reading) or breaks the grammar.
 *
 * It reads only the named files and the listed reports, writes nothing, scans
 * no directory, expands no glob, calls no network or GitHub API, and never
 * prints a path, argument, OS error, manifest line or manifest value.
 *
 * Exit 0 only for `COHORT: CONSISTENT` — an accepted snapshot and a complete,
 * single-commit, single-topology accounting of the 59 slots; 1 for
 * `COHORT: BRANCH C`, whatever the reason; 2 for a usage or report-path
 * manifest error.
 *
 * Manual and outside every gate: nothing in `pnpm verify`, the test phases or
 * CI runs it. It decides comparability only and verifies no readiness row.
 * All review logic is in `aggregation-campaign-image-cohort-lib.mjs`.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_MANIFEST_BYTES,
  formatCohortReview,
  reviewImageCohort,
} from './aggregation-campaign-image-cohort-lib.mjs';
import { LOG_RECOVERY_LIMITS } from './aggregation-campaign-log-recovery-lib.mjs';
import {
  REPORT_PATH_LIMITS,
  exceedsPathBytes,
  findPathCollision,
  loadReportManifest,
  pathApiFor,
} from './aggregation-campaign-report-manifest-lib.mjs';

const USAGE =
  'usage: node scripts/aggregation-campaign-image-cohort.mjs <review-manifest> <report> [<report> ...] | <review-manifest> --reports-manifest <file>';

const REPORTS_MANIFEST_OPTION = '--reports-manifest';

/** The per-report byte bound shared with log recovery; a report is about 3.3 KiB. */
export const MAX_REPORT_BYTES = LOG_RECOVERY_LIMITS.maxCandidateBytes;
/** More report paths than this are refused before any file is read. */
export const MAX_REPORT_PATHS = LOG_RECOVERY_LIMITS.maxLogs;

/** Fixed usage messages; no argument text is ever echoed. */
export const USAGE_ERROR = Object.freeze({
  noManifest: 'no manifest given',
  optionBeforeManifest: 'the review manifest must come before --reports-manifest',
  unknownOption: 'unknown option',
  inlineValue: '--reports-manifest takes no inline value',
  repeatedOption: '--reports-manifest given more than once',
  manifestValue: '--reports-manifest needs exactly one manifest path',
  extraArgument: 'unexpected argument after the manifest path',
  mixedModes: 'explicit report paths and --reports-manifest cannot be mixed',
  noReport: 'no report given',
  emptyPath: 'path is empty',
  pathTooLong: 'path exceeds the path byte limit',
  tooManyPaths: 'too many reports given',
  lateSeparator: '-- is accepted only before the first argument',
  duplicatePath: 'the same report path is listed twice',
});

const usage = (reason) => ({ ok: false, exitCode: 2, output: `${reason}\n${USAGE}\n` });

/**
 * Splits arguments into the review manifest and one of the two report modes,
 * deterministically, or a usage error. Returns
 * `{ ok: true, mode: 'paths', reviewManifest, paths }` or
 * `{ ok: true, mode: 'manifest', reviewManifest, reportsManifest }`.
 * `platform` and `cwd` only decide how report paths are compared for duplicates.
 */
export function parseImageCohortArgs(
  argv,
  { platform = process.platform, cwd = process.cwd(), limits = REPORT_PATH_LIMITS } = {},
) {
  let reviewManifest = null;
  const paths = [];
  let reportsManifest = null;
  let awaitingManifest = false;
  let seenArgument = false;
  for (const arg of (Array.isArray(argv) ? argv : []).map(String)) {
    if (awaitingManifest) {
      if (arg === '' || arg.startsWith('-')) return usage(USAGE_ERROR.manifestValue);
      if (exceedsPathBytes(arg, limits)) return usage(USAGE_ERROR.pathTooLong);
      reportsManifest = arg;
      awaitingManifest = false;
      continue;
    }
    if (arg === '--') {
      if (seenArgument) return usage(USAGE_ERROR.lateSeparator);
      continue;
    }
    seenArgument = true;
    if (arg === REPORTS_MANIFEST_OPTION) {
      if (reviewManifest === null) return usage(USAGE_ERROR.optionBeforeManifest);
      if (reportsManifest !== null) return usage(USAGE_ERROR.repeatedOption);
      if (paths.length > 0) return usage(USAGE_ERROR.mixedModes);
      awaitingManifest = true;
      continue;
    }
    if (arg.startsWith(`${REPORTS_MANIFEST_OPTION}=`)) return usage(USAGE_ERROR.inlineValue);
    if (arg.startsWith('-')) return usage(USAGE_ERROR.unknownOption);
    if (reportsManifest !== null) return usage(USAGE_ERROR.extraArgument);
    if (arg === '') return usage(USAGE_ERROR.emptyPath);
    if (exceedsPathBytes(arg, limits)) return usage(USAGE_ERROR.pathTooLong);
    if (reviewManifest === null) {
      reviewManifest = arg;
      continue;
    }
    paths.push(arg);
    if (paths.length > MAX_REPORT_PATHS) return usage(USAGE_ERROR.tooManyPaths);
  }
  if (awaitingManifest) return usage(USAGE_ERROR.manifestValue);
  if (reviewManifest === null) return usage(USAGE_ERROR.noManifest);
  if (reportsManifest !== null) {
    return { ok: true, mode: 'manifest', reviewManifest, reportsManifest };
  }
  if (paths.length === 0) return usage(USAGE_ERROR.noReport);

  const api = pathApiFor(platform);
  const collision = findPathCollision(
    { reports: paths.map((path) => api.resolve(cwd, path)) },
    { platform },
  );
  if (collision !== null) return usage(USAGE_ERROR.duplicatePath);
  return { ok: true, mode: 'paths', reviewManifest, paths };
}

/**
 * The CLI as a value: arguments in, text and an exit code out. `sizeOf` and
 * `readText` read the JSON review manifest and the reports, exactly as before;
 * `reportsManifestSizeOf` and `readReportsManifestBytes` read only the
 * report-path manifest. The file system and the clock are injectable so a test
 * can prove unreadable and oversized files are counted, not named or read, a
 * usage or report-path-manifest failure reads nothing else, and the review
 * time is explicit. `platform` and `cwd` are injectable so Windows path
 * comparison can be tested on any host.
 */
export function runImageCohortCli({
  argv = [],
  sizeOf = (path) => statSync(path).size,
  readText = (path) => readFileSync(path, 'utf8'),
  reportsManifestSizeOf = (path) => statSync(path).size,
  readReportsManifestBytes = (path) => readFileSync(path),
  platform = process.platform,
  cwd = process.cwd(),
  now = new Date(),
} = {}) {
  const parsed = parseImageCohortArgs(argv, { platform, cwd });
  if (!parsed.ok) return { exitCode: parsed.exitCode, output: parsed.output };

  let reportPaths = parsed.paths;
  if (parsed.mode === 'manifest') {
    const listed = loadReportManifest(parsed.reportsManifest, {
      sizeOf: reportsManifestSizeOf,
      readBytes: readReportsManifestBytes,
      platform,
      cwd,
    });
    if (!listed.ok) return usage(`reports manifest: ${listed.problem}`);
    if (findPathCollision({ reports: listed.paths }, { platform }) !== null) {
      return usage(USAGE_ERROR.duplicatePath);
    }
    reportPaths = listed.paths;
  }

  /** `{ text }`, or `{ unreadable }` without reading when the size is unknown or too big. */
  const load = (path, limit) => {
    try {
      const size = sizeOf(path);
      if (size > limit) return { unreadable: true, oversized: true };
      return { text: readText(path) };
    } catch {
      return { unreadable: true };
    }
  };

  const manifest = load(parsed.reviewManifest, MAX_MANIFEST_BYTES);
  const reports = reportPaths.map((path) => {
    const { text, unreadable } = load(path, MAX_REPORT_BYTES);
    return unreadable ? { unreadable: true } : { text };
  });

  const result = reviewImageCohort({ manifest, reports, now });
  return { exitCode: result.exitCode, output: formatCohortReview(result) };
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { exitCode, output } = runImageCohortCli({ argv: process.argv.slice(2) });
  process.stdout.write(output);
  process.exitCode = exitCode;
}
