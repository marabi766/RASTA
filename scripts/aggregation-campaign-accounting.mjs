#!/usr/bin/env node
/**
 * Accounts for the preregistered ADR-055 fresh-run campaign's 59 slots from
 * the content of its calibration reports.
 *
 * Two input modes:
 *
 *   Explicit paths:
 *   node scripts/aggregation-campaign-accounting.mjs <report> [<report> ...]
 *   pnpm run account:aggregation-campaign -- <report> [<report> ...]
 *
 *   Report-path manifest (recommended on Windows, where `pnpm run` passes 59
 *   long paths through `cmd.exe` and its command-line length limit):
 *   node scripts/aggregation-campaign-accounting.mjs --reports-manifest <file>
 *   pnpm run account:aggregation-campaign -- --reports-manifest <file>
 *
 * Give it every campaign report — one per slot, produced by
 * `calibrate:aggregation-stress -- --pairs 1 --slot <S>`. It enumerates slots
 * `1..59`, resolves each to `non-event`, `event`, `blocker` or `missing` from
 * the report text alone (preregistration § 8.4), prints every slot and the
 * totals, and asserts `non-events + events + blockers + missing == 59`. Fewer
 * readable reports are accounted as they are: absent slots are `missing`.
 *
 * **Manifest.** `--reports-manifest` appears once, followed by exactly one
 * manifest path and nothing else. The manifest has the exact grammar of the
 * retrieval comparator's cohort manifests
 * (`aggregation-campaign-report-manifest-lib.mjs`): strict UTF-8 without BOM,
 * exactly 59 LF-terminated lines of one report path each (at most 1024 UTF-8
 * bytes, no whitespace padding, control character, comment, quoting, escape,
 * `-` prefix, URL or drive-relative `C:name`), at most 60 475 bytes. A
 * relative line resolves against the manifest's own directory. Line order
 * means nothing. A manifest is an operator-supplied path list, not evidence.
 *
 * Usage and manifest-contract errors exit 2 before any report is read:
 *
 * - an unknown option, `--reports-manifest=value`, or a repeated manifest option;
 * - a manifest option without exactly one following path (none, empty or
 *   starting with `-`), or any argument besides it;
 * - explicit paths mixed with a manifest option;
 * - no report path, an empty path, a path starting with `-` (write `./-name`),
 *   a path longer than 1024 UTF-8 bytes, or more than
 *   `LOG_RECOVERY_LIMITS.maxLogs` paths;
 * - `--` anywhere but before the first real argument (pnpm forwards a leading one);
 * - the same report path twice (compared after resolution; on Windows
 *   case-insensitively, ignoring trailing dots and spaces; file system
 *   identity such as links or 8.3 names is not consulted);
 * - a manifest that cannot be read, exceeds its byte limit (checked before and
 *   after reading) or breaks the grammar.
 *
 * Exit 0 only for a complete, parseable, provenance-consistent campaign with
 * zero blockers and zero missing slots; 1 otherwise; 2 for a usage or
 * manifest-contract error.
 *
 * Manual and outside every gate, like the campaign itself: nothing in
 * `pnpm verify` or CI runs it. It reads only the named manifest and the named
 * or listed reports, writes nothing, scans no directory, expands no glob,
 * reads no GitHub state and no job conclusion, never prints a path, argument,
 * manifest line or OS error, and applies no threshold or interpretation — the
 * § 6 branches remain a human step. All accounting logic is in
 * `aggregation-campaign-accounting-lib.mjs`.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { accountCampaign, formatAccounting } from './aggregation-campaign-accounting-lib.mjs';
import { LOG_RECOVERY_LIMITS } from './aggregation-campaign-log-recovery-lib.mjs';
import {
  REPORT_PATH_LIMITS,
  exceedsPathBytes,
  findPathCollision,
  loadReportManifest,
  pathApiFor,
} from './aggregation-campaign-report-manifest-lib.mjs';

const USAGE =
  'usage: node scripts/aggregation-campaign-accounting.mjs <report> [<report> ...] | --reports-manifest <file>';

const MANIFEST_OPTION = '--reports-manifest';

/** More explicit report paths than this are refused before any file is read. */
export const MAX_REPORT_PATHS = LOG_RECOVERY_LIMITS.maxLogs;

/** Fixed usage messages; no argument text is ever echoed. */
export const USAGE_ERROR = Object.freeze({
  unknownOption: 'unknown option',
  inlineValue: '--reports-manifest takes no inline value',
  repeatedOption: '--reports-manifest given more than once',
  manifestValue: '--reports-manifest needs exactly one manifest path',
  extraArgument: 'unexpected argument after the manifest path',
  mixedModes: 'explicit report paths and --reports-manifest cannot be mixed',
  noReport: 'no report given',
  emptyPath: 'report path is empty',
  pathTooLong: 'path exceeds the path byte limit',
  tooManyPaths: 'more report paths than the accounting limit',
  lateSeparator: '-- is accepted only before the first argument',
  duplicatePath: 'the same report path is listed twice',
});

const usage = (reason) => ({ ok: false, exitCode: 2, output: `${reason}\n${USAGE}\n` });

/**
 * Splits arguments into one of the two modes, deterministically, or a usage
 * error. Returns `{ ok: true, mode: 'paths', paths }` or
 * `{ ok: true, mode: 'manifest', manifest }`. `platform` and `cwd` only decide
 * how explicit paths are compared for duplicates.
 */
export function parseAccountingArgs(
  argv,
  { platform = process.platform, cwd = process.cwd(), limits = REPORT_PATH_LIMITS } = {},
) {
  const paths = [];
  let manifest = null;
  let awaitingManifest = false;
  let seenArgument = false;
  for (const arg of (Array.isArray(argv) ? argv : []).map(String)) {
    if (awaitingManifest) {
      if (arg === '' || arg.startsWith('-')) return usage(USAGE_ERROR.manifestValue);
      if (exceedsPathBytes(arg, limits)) return usage(USAGE_ERROR.pathTooLong);
      manifest = arg;
      awaitingManifest = false;
      continue;
    }
    if (arg === '--') {
      if (seenArgument) return usage(USAGE_ERROR.lateSeparator);
      continue;
    }
    seenArgument = true;
    if (arg === MANIFEST_OPTION) {
      if (manifest !== null) return usage(USAGE_ERROR.repeatedOption);
      if (paths.length > 0) return usage(USAGE_ERROR.mixedModes);
      awaitingManifest = true;
      continue;
    }
    if (arg.startsWith(`${MANIFEST_OPTION}=`)) return usage(USAGE_ERROR.inlineValue);
    if (arg.startsWith('-')) return usage(USAGE_ERROR.unknownOption);
    if (manifest !== null) return usage(USAGE_ERROR.extraArgument);
    if (arg === '') return usage(USAGE_ERROR.emptyPath);
    if (exceedsPathBytes(arg, limits)) return usage(USAGE_ERROR.pathTooLong);
    paths.push(arg);
    if (paths.length > MAX_REPORT_PATHS) return usage(USAGE_ERROR.tooManyPaths);
  }
  if (awaitingManifest) return usage(USAGE_ERROR.manifestValue);
  if (manifest !== null) return { ok: true, mode: 'manifest', manifest };
  if (paths.length === 0) return usage(USAGE_ERROR.noReport);

  const api = pathApiFor(platform);
  const collision = findPathCollision(
    { reports: paths.map((path) => api.resolve(cwd, path)) },
    { platform },
  );
  if (collision !== null) return usage(USAGE_ERROR.duplicatePath);
  return { ok: true, mode: 'paths', paths };
}

/**
 * The CLI as a value: arguments in, text and an exit code out. `readText`
 * reads reports; `manifestSizeOf` and `readManifestBytes` read the report-path
 * manifest. Those three are the only file system access, and are injectable so
 * a test can prove a usage or manifest failure reads no report, an oversized
 * manifest is never read, and a file that cannot be read is counted, not
 * named. `platform` and `cwd` are injectable so Windows path comparison can be
 * tested on any host. A path never reaches the output — the result is a
 * function of the report contents only.
 */
export function runAccountingCli({
  argv = [],
  readText = (path) => readFileSync(path, 'utf8'),
  manifestSizeOf = (path) => statSync(path).size,
  readManifestBytes = (path) => readFileSync(path),
  platform = process.platform,
  cwd = process.cwd(),
} = {}) {
  const parsed = parseAccountingArgs(argv, { platform, cwd });
  if (!parsed.ok) return { exitCode: parsed.exitCode, output: parsed.output };

  let { paths } = parsed;
  if (parsed.mode === 'manifest') {
    const manifest = loadReportManifest(parsed.manifest, {
      sizeOf: manifestSizeOf,
      readBytes: readManifestBytes,
      platform,
      cwd,
    });
    if (!manifest.ok) return usage(`reports manifest: ${manifest.problem}`);
    if (findPathCollision({ reports: manifest.paths }, { platform }) !== null) {
      return usage(USAGE_ERROR.duplicatePath);
    }
    paths = manifest.paths;
  }

  const inputs = paths.map((path) => {
    try {
      return { text: readText(path) };
    } catch {
      return { unreadable: true };
    }
  });
  const result = accountCampaign(inputs);
  return { exitCode: result.exitCode, output: formatAccounting(result) };
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { exitCode, output } = runAccountingCli({ argv: process.argv.slice(2) });
  process.stdout.write(output);
  process.exitCode = exitCode;
}
