#!/usr/bin/env node
/**
 * Compares two complete retrievals of the preregistered ADR-055 fresh-run
 * campaign byte for byte: the 59 downloaded per-slot artifact reports and the
 * 59 reports materialized from job logs.
 *
 * Two input modes; both cohorts always use the same one.
 *
 *   Explicit paths:
 *   node scripts/aggregation-campaign-retrieval-comparison.mjs --artifacts <report> ... --fallback <report> ...
 *   pnpm run compare:aggregation-campaign-retrievals -- --artifacts <report> ... --fallback <report> ...
 *
 *   Cohort manifests (recommended on Windows, where `pnpm run` passes 118 long
 *   paths through `cmd.exe` and its command-line length limit):
 *   node scripts/aggregation-campaign-retrieval-comparison.mjs --artifacts-manifest <file> --fallback-manifest <file>
 *   pnpm run compare:aggregation-campaign-retrievals -- --artifacts-manifest <file> --fallback-manifest <file>
 *
 * **Explicit paths.** `--artifacts` and `--fallback` each appear exactly once,
 * in either order, and each is followed by that cohort's report paths up to
 * the other option or the end. Every path belongs to the option that precedes
 * it. A cohort must list exactly 59 paths to be compared.
 *
 * **Manifests.** `--artifacts-manifest` and `--fallback-manifest` each appear
 * exactly once, in either order, each followed by exactly one manifest path. A
 * manifest is strict UTF-8 without BOM: exactly 59 non-empty lines, each ended
 * by LF (no CR), each one report path of at most 1024 UTF-8 bytes with no
 * leading or trailing whitespace, not starting with `-`, `#`, `"` or `'`, not
 * ending with a quote, not a `scheme:` URL and not a drive-relative `C:name`,
 * and with no NUL, tab or other control character. There are no comments,
 * quoting or escapes. A relative entry resolves against the directory holding
 * that manifest. Line order means nothing. A manifest is an operator-supplied
 * path list, not evidence.
 *
 * Usage and manifest-contract errors exit 2 before any report is read:
 *
 * - a missing, repeated or unknown option, `--option=value`, or mixed modes;
 * - a path before the first cohort option, a cohort option with no path, a
 *   manifest option without exactly one following path, or any extra argument;
 * - an empty path, a path starting with `-` (write `./-name` instead), or a
 *   path longer than 1024 UTF-8 bytes;
 * - `--` anywhere but before the first option (pnpm forwards a leading one);
 * - the same path twice within a cohort, or in both cohorts (compared after
 *   resolution; on Windows case-insensitively, ignoring trailing dots/spaces);
 * - the same manifest for both cohorts;
 * - more than `RETRIEVAL_COMPARISON_LIMITS.maxPathsPerCohort` paths in a cohort;
 * - a manifest that cannot be read, exceeds its byte limit (checked before and
 *   after reading) or breaks the grammar above.
 *
 * It reads only the named manifests and the report files named explicitly or
 * listed in them, each only after its size is within its byte limit, writes
 * nothing, scans no directory, expands no glob and calls no network or GitHub
 * API. Output is fixed text and counts: never a path, file name, manifest
 * line, OS error, report content, slot of a difference, commit, topology,
 * timestamp or run value.
 *
 * Exit 0 only for `COMPARISON: MATCH` — both cohorts complete and valid under
 * the unchanged slot accounting, and every slot byte-identical; 1 for
 * `COMPARISON: DIFFERENT` or `COMPARISON: REJECTED`; 2 for a usage or
 * manifest-contract error.
 *
 * Manual, optional and outside every gate: nothing in `pnpm verify`, the test
 * phases or CI runs it. A match establishes equality of the supplied bytes
 * only. All comparison logic is in
 * `aggregation-campaign-retrieval-comparison-lib.mjs`; the manifest grammar,
 * bounds and path collision policy are in
 * `aggregation-campaign-report-manifest-lib.mjs`.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CAMPAIGN_SLOT_COUNT } from './aggregation-campaign-accounting-lib.mjs';
import {
  exceedsPathBytes,
  findPathCollision,
  loadReportManifest,
  pathApiFor,
} from './aggregation-campaign-report-manifest-lib.mjs';
import {
  RETRIEVAL_COMPARISON_LIMITS,
  compareRetrievals,
  formatRetrievalComparison,
} from './aggregation-campaign-retrieval-comparison-lib.mjs';

const USAGE =
  'usage: node scripts/aggregation-campaign-retrieval-comparison.mjs --artifacts <report> [<report> ...] --fallback <report> [<report> ...] | --artifacts-manifest <file> --fallback-manifest <file>';

const COHORT_OPTIONS = Object.freeze({ '--artifacts': 'artifacts', '--fallback': 'fallback' });
const MANIFEST_OPTIONS = Object.freeze({
  '--artifacts-manifest': 'artifacts',
  '--fallback-manifest': 'fallback',
});
const ALL_OPTIONS = Object.freeze([
  ...Object.keys(COHORT_OPTIONS),
  ...Object.keys(MANIFEST_OPTIONS),
]);
const COHORT_NAMES = Object.freeze(['artifacts', 'fallback']);

/** Fixed usage messages; no argument text is ever echoed. */
export const USAGE_ERROR = Object.freeze({
  unknownOption: 'unknown option',
  inlineValue: 'cohort options take no inline value',
  repeatedOption: 'cohort option given more than once',
  missingOption: 'both --artifacts and --fallback are required',
  pathBeforeOption: 'report path given before a cohort option',
  emptyCohort: 'cohort option needs at least one report path',
  emptyPath: 'report path is empty',
  lateSeparator: '-- is accepted only before the first cohort option',
  sharedPath: 'the same report path is listed in both cohorts',
  tooManyPaths: 'more report paths in a cohort than the comparison limit',
  mixedModes: 'explicit report paths and manifests cannot be mixed',
  missingManifest: 'both --artifacts-manifest and --fallback-manifest are required',
  manifestValue: 'manifest option needs exactly one manifest path',
  extraArgument: 'unexpected argument after a manifest path',
  pathTooLong: 'path exceeds the path byte limit',
  duplicatePath: 'the same report path is listed twice in one cohort',
  sharedManifest: 'the same manifest is given for both cohorts',
});

const usage = (reason) => ({ ok: false, exitCode: 2, output: `${reason}\n${USAGE}\n` });

/**
 * Splits arguments into one of the two modes, deterministically, or a usage
 * error. Returns `{ ok: true, mode: 'paths', cohorts: { artifacts, fallback } }`
 * or `{ ok: true, mode: 'manifest', manifests: { artifacts, fallback } }`.
 * `platform` and `cwd` only decide how paths are compared for duplicates.
 */
export function parseComparisonArgs(
  argv,
  { limits = RETRIEVAL_COMPARISON_LIMITS, platform = process.platform, cwd = process.cwd() } = {},
) {
  const cohorts = {};
  const manifests = {};
  let current = null;
  let awaitingManifest = null;
  let seenOption = false;
  for (const arg of (Array.isArray(argv) ? argv : []).map(String)) {
    if (awaitingManifest !== null) {
      if (arg === '' || arg.startsWith('-')) return usage(USAGE_ERROR.manifestValue);
      if (exceedsPathBytes(arg, limits)) return usage(USAGE_ERROR.pathTooLong);
      manifests[awaitingManifest] = arg;
      awaitingManifest = null;
      continue;
    }
    if (arg === '--') {
      if (seenOption) return usage(USAGE_ERROR.lateSeparator);
      continue;
    }
    if (Object.hasOwn(COHORT_OPTIONS, arg)) {
      if (Object.keys(manifests).length > 0) return usage(USAGE_ERROR.mixedModes);
      const name = COHORT_OPTIONS[arg];
      if (current !== null && cohorts[current].length === 0) return usage(USAGE_ERROR.emptyCohort);
      if (Object.hasOwn(cohorts, name)) return usage(USAGE_ERROR.repeatedOption);
      cohorts[name] = [];
      current = name;
      seenOption = true;
      continue;
    }
    if (Object.hasOwn(MANIFEST_OPTIONS, arg)) {
      if (Object.keys(cohorts).length > 0) return usage(USAGE_ERROR.mixedModes);
      const name = MANIFEST_OPTIONS[arg];
      if (Object.hasOwn(manifests, name)) return usage(USAGE_ERROR.repeatedOption);
      awaitingManifest = name;
      seenOption = true;
      continue;
    }
    if (ALL_OPTIONS.some((option) => arg.startsWith(`${option}=`))) {
      return usage(USAGE_ERROR.inlineValue);
    }
    if (arg.startsWith('-')) return usage(USAGE_ERROR.unknownOption);
    if (arg === '') return usage(USAGE_ERROR.emptyPath);
    if (Object.keys(manifests).length > 0) return usage(USAGE_ERROR.extraArgument);
    if (current === null) return usage(USAGE_ERROR.pathBeforeOption);
    if (exceedsPathBytes(arg, limits)) return usage(USAGE_ERROR.pathTooLong);
    cohorts[current].push(arg);
  }
  if (awaitingManifest !== null) return usage(USAGE_ERROR.manifestValue);

  const api = pathApiFor(platform);
  const absolute = (path) => api.resolve(cwd, path);

  if (Object.keys(manifests).length > 0) {
    if (!COHORT_NAMES.every((name) => Object.hasOwn(manifests, name))) {
      return usage(USAGE_ERROR.missingManifest);
    }
    const collision = findPathCollision(
      { artifacts: [absolute(manifests.artifacts)], fallback: [absolute(manifests.fallback)] },
      { platform },
    );
    if (collision !== null) return usage(USAGE_ERROR.sharedManifest);
    return {
      ok: true,
      mode: 'manifest',
      manifests: { artifacts: manifests.artifacts, fallback: manifests.fallback },
    };
  }

  if (!COHORT_NAMES.every((name) => Object.hasOwn(cohorts, name))) {
    return usage(USAGE_ERROR.missingOption);
  }
  if (cohorts.artifacts.length === 0 || cohorts.fallback.length === 0) {
    return usage(USAGE_ERROR.emptyCohort);
  }
  if (
    cohorts.artifacts.length > limits.maxPathsPerCohort ||
    cohorts.fallback.length > limits.maxPathsPerCohort
  ) {
    return usage(USAGE_ERROR.tooManyPaths);
  }
  const collision = findPathCollision(
    { artifacts: cohorts.artifacts.map(absolute), fallback: cohorts.fallback.map(absolute) },
    { platform },
  );
  if (collision === 'duplicate') return usage(USAGE_ERROR.duplicatePath);
  if (collision === 'shared') return usage(USAGE_ERROR.sharedPath);
  return {
    ok: true,
    mode: 'paths',
    cohorts: { artifacts: cohorts.artifacts, fallback: cohorts.fallback },
  };
}

/**
 * The CLI as a value: arguments in, text and an exit code out. `sizeOf` and
 * `readBytes` read reports; `manifestSizeOf` and `readManifestBytes` read the
 * two manifests. Those four are the only file system access, and are
 * injectable so a test can prove what is read, that an oversized report or
 * manifest is never read, that a rejected manifest causes no report read, and
 * that an unreadable file is counted rather than named. `platform` and `cwd`
 * are injectable so Windows path comparison can be tested on any host.
 */
export function runRetrievalComparisonCli({
  argv = [],
  sizeOf = (path) => statSync(path).size,
  readBytes = (path) => readFileSync(path),
  manifestSizeOf = (path) => statSync(path).size,
  readManifestBytes = (path) => readFileSync(path),
  platform = process.platform,
  cwd = process.cwd(),
  limits = RETRIEVAL_COMPARISON_LIMITS,
} = {}) {
  const parsed = parseComparisonArgs(argv, { limits, platform, cwd });
  if (!parsed.ok) return { exitCode: parsed.exitCode, output: parsed.output };

  let reportPaths = parsed.cohorts;
  if (parsed.mode === 'manifest') {
    reportPaths = {};
    for (const name of COHORT_NAMES) {
      const manifest = loadReportManifest(parsed.manifests[name], {
        sizeOf: manifestSizeOf,
        readBytes: readManifestBytes,
        platform,
        cwd,
        limits,
      });
      if (!manifest.ok) return usage(`${name} manifest: ${manifest.problem}`);
      reportPaths[name] = manifest.paths;
    }
    const collision = findPathCollision(reportPaths, { platform });
    if (collision === 'duplicate') return usage(USAGE_ERROR.duplicatePath);
    if (collision === 'shared') return usage(USAGE_ERROR.sharedPath);
  }

  /** `{ bytes }`, or a state without reading when the size is unknown or too big. */
  const load = (path) => {
    try {
      if (!(sizeOf(path) <= limits.maxReportBytes)) return { oversized: true };
      return { bytes: readBytes(path) };
    } catch {
      return { unreadable: true };
    }
  };
  // A cohort that cannot be complete is not read at all; the library rejects it on its size.
  const loadCohort = (paths) =>
    paths.length === CAMPAIGN_SLOT_COUNT ? paths.map(load) : paths.map(() => ({ notRead: true }));

  const result = compareRetrievals(
    {
      artifacts: loadCohort(reportPaths.artifacts),
      fallback: loadCohort(reportPaths.fallback),
    },
    { limits },
  );
  return { exitCode: result.exitCode, output: formatRetrievalComparison(result) };
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { exitCode, output } = runRetrievalComparisonCli({ argv: process.argv.slice(2) });
  process.stdout.write(output);
  process.exitCode = exitCode;
}
