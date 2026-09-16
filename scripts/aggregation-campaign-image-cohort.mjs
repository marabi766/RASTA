#!/usr/bin/env node
/**
 * Reviews the runner/image cohort of the preregistered ADR-055 fresh-run
 * campaign: the pre-launch release snapshot, then the post-run comparison of
 * the 59 campaign reports.
 *
 *   node scripts/aggregation-campaign-image-cohort.mjs <review-manifest> <report> [<report> ...]
 *   pnpm run review:aggregation-campaign-image-cohort -- <review-manifest> <report> [<report> ...]
 *
 * The first path is the JSON review manifest written before launch; every
 * other path is one campaign report. It reads only those files, writes
 * nothing, calls no network or GitHub API, and never prints a path or a
 * manifest value.
 *
 * Exit 0 only for `COHORT: CONSISTENT` — an accepted snapshot and a complete,
 * single-commit, single-topology accounting of the 59 slots; 1 for
 * `COHORT: BRANCH C`, whatever the reason; 2 for a usage error.
 *
 * Manual and outside every gate: nothing in `pnpm verify`, the test phases or
 * CI runs it. It decides comparability only and verifies no readiness row.
 * All logic is in `aggregation-campaign-image-cohort-lib.mjs`.
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

const USAGE =
  'usage: node scripts/aggregation-campaign-image-cohort.mjs <review-manifest> <report> [<report> ...]';

/** The per-report byte bound shared with log recovery; a report is about 3.3 KiB. */
export const MAX_REPORT_BYTES = LOG_RECOVERY_LIMITS.maxCandidateBytes;
/** More report paths than this are refused before any file is read. */
export const MAX_REPORT_PATHS = LOG_RECOVERY_LIMITS.maxLogs;

/**
 * The CLI as a value: arguments in, text and an exit code out. The file system
 * and the clock are injectable so a test can prove unreadable and oversized
 * files are counted, not named or read, and that the review time is explicit.
 */
export function runImageCohortCli({
  argv = [],
  sizeOf = (path) => statSync(path).size,
  readText = (path) => readFileSync(path, 'utf8'),
  now = new Date(),
} = {}) {
  const paths = [];
  for (const arg of argv.map(String)) {
    // `pnpm run <script> -- …` forwards the separator itself.
    if (arg === '--') continue;
    if (arg.startsWith('-')) return { exitCode: 2, output: `unknown option\n${USAGE}\n` };
    paths.push(arg);
  }
  if (paths.length === 0) return { exitCode: 2, output: `no manifest given\n${USAGE}\n` };
  if (paths.length === 1) return { exitCode: 2, output: `no report given\n${USAGE}\n` };
  const [manifestPath, ...reportPaths] = paths;
  if (reportPaths.length > MAX_REPORT_PATHS) {
    return { exitCode: 2, output: `too many reports given\n${USAGE}\n` };
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

  const manifest = load(manifestPath, MAX_MANIFEST_BYTES);
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
