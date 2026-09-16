#!/usr/bin/env node
/**
 * Recovers ADR-055 calibration reports from GitHub Actions job-log text and
 * accounts for the 59 campaign slots from the recovered content — offline.
 *
 *   node scripts/aggregation-campaign-log-recovery.mjs <job-log> [<job-log> ...]
 *   pnpm run recover:aggregation-campaign-logs -- <job-log> [<job-log> ...]
 *
 * Give it every job log explicitly, already on disk. It reads only those files,
 * recovers reports between the calibration header and footer, validates each
 * with the strict slot-report parser, runs the unchanged slot accounting in
 * memory, and prints recovery counts, the accounting and one verdict. It writes
 * nothing, downloads nothing and calls no network or GitHub API.
 *
 * Exit 0 only when every log was recovered without a single rejection and the
 * accounting is complete with zero blockers and zero missing slots; 1 for an
 * unreadable log, any recovery or validation rejection, or an incomplete or
 * blocked campaign; 2 for a usage error.
 *
 * Manual and outside every gate: nothing in `pnpm verify`, the test phases or
 * CI runs it. It never prints a path. All logic is in
 * `aggregation-campaign-log-recovery-lib.mjs`.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOG_RECOVERY_LIMITS,
  formatRecovery,
  recoverAndAccount,
} from './aggregation-campaign-log-recovery-lib.mjs';

const USAGE = 'usage: node scripts/aggregation-campaign-log-recovery.mjs <job-log> [<job-log> ...]';

/**
 * The CLI as a value: arguments in, text and an exit code out. The file system
 * is injectable so a test can prove unreadable and oversized logs are counted,
 * not named, and that an oversized log is never read.
 */
export function runLogRecoveryCli({
  argv = [],
  sizeOf = (path) => statSync(path).size,
  readText = (path) => readFileSync(path, 'utf8'),
  limits = LOG_RECOVERY_LIMITS,
} = {}) {
  const paths = [];
  for (const arg of argv.map(String)) {
    // `pnpm run <script> -- …` forwards the separator itself.
    if (arg === '--') continue;
    if (arg.startsWith('-')) return { exitCode: 2, output: `unknown option\n${USAGE}\n` };
    paths.push(arg);
  }
  if (paths.length === 0) return { exitCode: 2, output: `no job log given\n${USAGE}\n` };

  // Sizes first, so a log that alone or together breaks a byte limit is never read.
  const sizes = paths.map((path) => {
    try {
      return sizeOf(path);
    } catch {
      return null;
    }
  });
  const statTotal = sizes.reduce((sum, size) => sum + (size ?? 0), 0);
  const logs = paths.map((path, index) => {
    const size = sizes[index];
    if (size === null) return { unreadable: true };
    if (size > limits.maxLogBytes || statTotal > limits.maxTotalBytes) {
      return { oversized: size > limits.maxLogBytes, unreadable: true, bytes: size };
    }
    try {
      return { text: readText(path) };
    } catch {
      return { unreadable: true };
    }
  });

  const result = recoverAndAccount(logs, { limits });
  return { exitCode: result.exitCode, output: formatRecovery(result) };
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { exitCode, output } = runLogRecoveryCli({ argv: process.argv.slice(2) });
  process.stdout.write(output);
  process.exitCode = exitCode;
}
