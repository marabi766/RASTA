#!/usr/bin/env node
/**
 * Compares two complete retrievals of the preregistered ADR-055 fresh-run
 * campaign byte for byte: the 59 downloaded per-slot artifact reports and the
 * 59 reports materialized from job logs.
 *
 *   node scripts/aggregation-campaign-retrieval-comparison.mjs --artifacts <report> ... --fallback <report> ...
 *   pnpm run compare:aggregation-campaign-retrievals -- --artifacts <report> ... --fallback <report> ...
 *
 * `--artifacts` and `--fallback` each appear exactly once, in either order, and
 * each is followed by that cohort's report paths up to the other option or the
 * end. Every path belongs to the option that precedes it; a path is never
 * assigned by name or position within a cohort. A cohort must list exactly 59
 * paths to be compared. Usage errors, all exit 2 before any file is read:
 *
 * - a missing, repeated or unknown option, or `--artifacts=…` / `--fallback=…`;
 * - a path before the first cohort option, or a cohort option with no path;
 * - an empty path, or a path starting with `-` (write `./-name` instead);
 * - `--` anywhere but before the first option (pnpm forwards a leading one);
 * - the same path, after `resolve`, listed in both cohorts;
 * - more than `RETRIEVAL_COMPARISON_LIMITS.maxPathsPerCohort` paths in a cohort.
 *
 * It reads only the files named, each only after its size is within the report
 * byte limit, writes nothing, scans no directory, and calls no network or
 * GitHub API. Output is fixed text and counts: never a path, file name, report
 * content, slot of a difference, commit, topology, timestamp or run value.
 *
 * Exit 0 only for `COMPARISON: MATCH` — both cohorts complete and valid under
 * the unchanged slot accounting, and every slot byte-identical; 1 for
 * `COMPARISON: DIFFERENT` or `COMPARISON: REJECTED`; 2 for a usage error.
 *
 * Manual, optional and outside every gate: nothing in `pnpm verify`, the test
 * phases or CI runs it. A match establishes equality of the supplied bytes
 * only. All comparison logic is in
 * `aggregation-campaign-retrieval-comparison-lib.mjs`.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CAMPAIGN_SLOT_COUNT } from './aggregation-campaign-accounting-lib.mjs';
import {
  RETRIEVAL_COMPARISON_LIMITS,
  compareRetrievals,
  formatRetrievalComparison,
} from './aggregation-campaign-retrieval-comparison-lib.mjs';

const USAGE =
  'usage: node scripts/aggregation-campaign-retrieval-comparison.mjs --artifacts <report> [<report> ...] --fallback <report> [<report> ...]';

const COHORT_OPTIONS = Object.freeze({ '--artifacts': 'artifacts', '--fallback': 'fallback' });

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
});

const usage = (reason) => ({ ok: false, exitCode: 2, output: `${reason}\n${USAGE}\n` });

/**
 * Splits arguments into the two cohorts, deterministically, or a usage error.
 * Returns `{ ok: true, cohorts: { artifacts, fallback } }` of path lists.
 */
export function parseComparisonArgs(argv, { limits = RETRIEVAL_COMPARISON_LIMITS } = {}) {
  const cohorts = {};
  let current = null;
  for (const arg of (Array.isArray(argv) ? argv : []).map(String)) {
    if (arg === '--') {
      if (current !== null) return usage(USAGE_ERROR.lateSeparator);
      continue;
    }
    if (Object.hasOwn(COHORT_OPTIONS, arg)) {
      const name = COHORT_OPTIONS[arg];
      if (current !== null && cohorts[current].length === 0) return usage(USAGE_ERROR.emptyCohort);
      if (Object.hasOwn(cohorts, name)) return usage(USAGE_ERROR.repeatedOption);
      cohorts[name] = [];
      current = name;
      continue;
    }
    if (Object.keys(COHORT_OPTIONS).some((option) => arg.startsWith(`${option}=`))) {
      return usage(USAGE_ERROR.inlineValue);
    }
    if (arg.startsWith('-')) return usage(USAGE_ERROR.unknownOption);
    if (arg === '') return usage(USAGE_ERROR.emptyPath);
    if (current === null) return usage(USAGE_ERROR.pathBeforeOption);
    cohorts[current].push(arg);
  }
  if (!Object.hasOwn(cohorts, 'artifacts') || !Object.hasOwn(cohorts, 'fallback')) {
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
  const artifactPaths = new Set(cohorts.artifacts.map((path) => resolve(path)));
  if (cohorts.fallback.some((path) => artifactPaths.has(resolve(path)))) {
    return usage(USAGE_ERROR.sharedPath);
  }
  return { ok: true, cohorts: { artifacts: cohorts.artifacts, fallback: cohorts.fallback } };
}

/**
 * The CLI as a value: arguments in, text and an exit code out. `sizeOf` and
 * `readBytes` are the only file system access, and are injectable so a test
 * can prove what is read, that an oversized report is never read, and that an
 * unreadable one is counted rather than named.
 */
export function runRetrievalComparisonCli({
  argv = [],
  sizeOf = (path) => statSync(path).size,
  readBytes = (path) => readFileSync(path),
  limits = RETRIEVAL_COMPARISON_LIMITS,
} = {}) {
  const parsed = parseComparisonArgs(argv, { limits });
  if (!parsed.ok) return { exitCode: parsed.exitCode, output: parsed.output };

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
      artifacts: loadCohort(parsed.cohorts.artifacts),
      fallback: loadCohort(parsed.cohorts.fallback),
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
