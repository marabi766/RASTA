#!/usr/bin/env node
/**
 * Recovers ADR-055 calibration reports from GitHub Actions job-log text and
 * accounts for the 59 campaign slots from the recovered content — offline.
 *
 *   node scripts/aggregation-campaign-log-recovery.mjs [--output-dir <new-directory>] <job-log> [<job-log> ...]
 *   pnpm run recover:aggregation-campaign-logs -- [--output-dir <new-directory>] <job-log> [<job-log> ...]
 *
 * Give it every job log explicitly, already on disk. It reads only those files,
 * recovers reports between the calibration header and footer, validates each
 * with the strict slot-report parser, runs the unchanged slot accounting in
 * memory, and prints recovery counts, the accounting and one verdict. It
 * downloads nothing and calls no network or GitHub API.
 *
 * **Without `--output-dir` it writes nothing** — the read-only form, whose
 * output and exit codes are unchanged.
 *
 * **With `--output-dir <new-directory>`** it writes the recovered reports as
 * files, so the existing `account:aggregation-campaign` and
 * `review:aggregation-campaign-image-cohort` commands can consume them — but
 * only when recovery is clean and the accounting is complete. Then, and only
 * then, it:
 *
 * - refuses a destination that exists in any form (file, directory, link or
 *   junction) and a parent that is not a plain directory;
 * - creates one uniquely named staging directory inside that parent, creates
 *   `slot-01.txt` … `slot-59.txt` in it exclusively (never overwriting), reads
 *   every file back and compares its bytes with the accepted recovered text,
 *   and checks the staging directory holds exactly those files;
 * - renames the staging directory to the destination in one step, so no
 *   partial destination is ever visible.
 *
 * On any failure before that rename it removes only the files it created and
 * then its own empty staging directory — never recursively, never anything it
 * did not create. It never merges with, cleans or deletes a destination.
 *
 * Exit 0 only when every log was recovered without a single rejection, the
 * accounting is complete with zero blockers and zero missing slots and, with
 * `--output-dir`, every file was written; 1 for an unreadable log, any
 * recovery or validation rejection, an incomplete or blocked campaign, or a
 * materialization failure; 2 for a usage error.
 *
 * Manual and outside every gate: nothing in `pnpm verify`, the test phases or
 * CI runs it. It never prints a path or a recovered value. All recovery logic
 * is in `aggregation-campaign-log-recovery-lib.mjs`.
 */
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOG_RECOVERY_LIMITS,
  MATERIALIZATION_CLEANUP,
  MATERIALIZATION_REASON,
  formatRecovery,
  planReportFiles,
  recoverAndAccount,
} from './aggregation-campaign-log-recovery-lib.mjs';

const USAGE =
  'usage: node scripts/aggregation-campaign-log-recovery.mjs [--output-dir <new-directory>] <job-log> [<job-log> ...]';

const OUTPUT_DIR_OPTION = '--output-dir';

/** The staging directory's name prefix; `mkdtemp` appends a unique suffix. */
export const STAGING_PREFIX = '.adr-055-recovered-reports-staging-';

/**
 * The file system operations materialization uses, and nothing else. Every
 * one is synchronous and none follows or replaces an existing entry except
 * `rename`, which is called once, onto a destination just seen absent.
 */
export const NODE_MATERIALIZATION_FS = Object.freeze({
  lstat: (path) => lstatSync(path),
  mkdtemp: (prefix) => mkdtempSync(prefix),
  /** `wx`: O_CREAT | O_EXCL — fails on any existing entry, links included. */
  writeExclusive: (path, bytes) => writeFileSync(path, bytes, { flag: 'wx' }),
  readBytes: (path) => readFileSync(path),
  readdir: (path) => readdirSync(path),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
  /** Non-recursive: fails unless the directory is empty. */
  rmdir: (path) => rmdirSync(path),
});

/** `true` when `lstat` says nothing is there; `false` when something is; throws otherwise. */
function absent(fs, path) {
  try {
    fs.lstat(path);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

/**
 * Writes the planned files into a new directory, all or nothing. Returns
 * `{ written: true, count }` or `{ written: false, reason, cleanup }` with
 * fixed sentences only; no path or value is ever part of the result.
 */
export function materializeReportFiles({ outputDir, files, fs = NODE_MATERIALIZATION_FS }) {
  const fail = (reason, cleanup) => ({ written: false, reason, cleanup });

  const target = resolve(outputDir);
  const parent = dirname(target);
  const name = basename(target);
  if (parent === target || name === '' || name === '.' || name === '..') {
    return fail(MATERIALIZATION_REASON.invalidName, MATERIALIZATION_CLEANUP.none);
  }

  try {
    if (!absent(fs, target))
      return fail(MATERIALIZATION_REASON.exists, MATERIALIZATION_CLEANUP.none);
  } catch {
    return fail(MATERIALIZATION_REASON.uncheckable, MATERIALIZATION_CLEANUP.none);
  }
  try {
    const stats = fs.lstat(parent);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return fail(MATERIALIZATION_REASON.parent, MATERIALIZATION_CLEANUP.none);
    }
  } catch {
    return fail(MATERIALIZATION_REASON.parent, MATERIALIZATION_CLEANUP.none);
  }

  let staging;
  try {
    staging = fs.mkdtemp(join(parent, STAGING_PREFIX));
  } catch {
    return fail(MATERIALIZATION_REASON.staging, MATERIALIZATION_CLEANUP.none);
  }
  const stagingName = typeof staging === 'string' ? basename(staging) : '';
  const owned =
    typeof staging === 'string' &&
    dirname(staging) === parent &&
    stagingName.startsWith(STAGING_PREFIX) &&
    stagingName.length > STAGING_PREFIX.length &&
    join(parent, stagingName) === staging;
  if (!owned) {
    // Not provably ours inside the intended parent: write nothing, remove nothing.
    return fail(MATERIALIZATION_REASON.stagingOutside, MATERIALIZATION_CLEANUP.notRemoved);
  }

  const created = [];
  const cleanUp = () => {
    let clean = true;
    for (const file of created) {
      try {
        fs.unlink(join(staging, file));
      } catch {
        clean = false;
      }
    }
    try {
      fs.rmdir(staging);
    } catch {
      clean = false;
    }
    return clean ? MATERIALIZATION_CLEANUP.removed : MATERIALIZATION_CLEANUP.incomplete;
  };

  for (const file of files) {
    const bytes = Buffer.from(file.text, 'utf8');
    try {
      fs.writeExclusive(join(staging, file.name), bytes);
      created.push(file.name);
    } catch {
      return fail(MATERIALIZATION_REASON.create, cleanUp());
    }
    let readBack;
    try {
      readBack = fs.readBytes(join(staging, file.name));
    } catch {
      return fail(MATERIALIZATION_REASON.verify, cleanUp());
    }
    if (!Buffer.isBuffer(readBack) || !readBack.equals(bytes)) {
      return fail(MATERIALIZATION_REASON.verify, cleanUp());
    }
  }

  try {
    const entries = [...fs.readdir(staging)].map(String).sort();
    const expected = files.map((file) => file.name).sort();
    if (entries.length !== expected.length || entries.some((entry, i) => entry !== expected[i])) {
      return fail(MATERIALIZATION_REASON.entries, cleanUp());
    }
  } catch {
    return fail(MATERIALIZATION_REASON.entries, cleanUp());
  }

  // Look again immediately before the one rename that makes the output visible.
  try {
    if (!absent(fs, target)) return fail(MATERIALIZATION_REASON.exists, cleanUp());
  } catch {
    return fail(MATERIALIZATION_REASON.uncheckable, cleanUp());
  }
  try {
    fs.rename(staging, target);
  } catch {
    return fail(MATERIALIZATION_REASON.rename, cleanUp());
  }

  try {
    const stats = fs.lstat(target);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('not a directory');
  } catch {
    return fail(MATERIALIZATION_REASON.placed, MATERIALIZATION_CLEANUP.leftInPlace);
  }
  return { written: true, count: files.length };
}

/**
 * The CLI as a value: arguments in, text and an exit code out. The file system
 * is injectable so a test can prove unreadable and oversized logs are counted,
 * not named, that an oversized log is never read, and that materialization
 * touches nothing it does not own.
 */
export function runLogRecoveryCli({
  argv = [],
  sizeOf = (path) => statSync(path).size,
  readText = (path) => readFileSync(path, 'utf8'),
  limits = LOG_RECOVERY_LIMITS,
  fs = NODE_MATERIALIZATION_FS,
} = {}) {
  const paths = [];
  let outputDir;
  const args = argv.map(String);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    // `pnpm run <script> -- …` forwards the separator itself.
    if (arg === '--') continue;
    if (arg === OUTPUT_DIR_OPTION) {
      const value = args[index + 1];
      if (outputDir !== undefined) {
        return { exitCode: 2, output: `output directory given more than once\n${USAGE}\n` };
      }
      if (value === undefined || value === '' || value.startsWith('-')) {
        return { exitCode: 2, output: `output directory option needs a value\n${USAGE}\n` };
      }
      outputDir = value;
      index += 1;
      continue;
    }
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
  if (outputDir === undefined) {
    return { exitCode: result.exitCode, output: formatRecovery(result) };
  }

  const plan = planReportFiles(result);
  const materialization = plan.ok
    ? materializeReportFiles({ outputDir, files: plan.files, fs })
    : { written: false, reason: plan.reason, cleanup: MATERIALIZATION_CLEANUP.none };
  const exitCode = result.exitCode === 0 && materialization.written ? 0 : 1;
  return { exitCode, output: formatRecovery(result, { materialization }) };
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { exitCode, output } = runLogRecoveryCli({ argv: process.argv.slice(2) });
  process.stdout.write(output);
  process.exitCode = exitCode;
}
