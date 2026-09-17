#!/usr/bin/env node
/**
 * Recovers ADR-055 calibration reports from GitHub Actions job-log text and
 * accounts for the 59 campaign slots from the recovered content — offline.
 *
 * Two input modes:
 *
 *   Explicit paths:
 *   node scripts/aggregation-campaign-log-recovery.mjs [--output-dir <new-directory>] <job-log> [<job-log> ...]
 *   pnpm run recover:aggregation-campaign-logs -- [--output-dir <new-directory>] <job-log> [<job-log> ...]
 *
 *   Job-log path manifest (recommended on Windows, where `pnpm run` passes
 *   long paths through `cmd.exe` and its 8191-character command-line limit):
 *   node scripts/aggregation-campaign-log-recovery.mjs [--output-dir <new-directory>] --logs-manifest <file>
 *   pnpm run recover:aggregation-campaign-logs -- [--output-dir <new-directory>] --logs-manifest <file>
 *
 * Give it every job log, already on disk, named explicitly or listed in the
 * manifest. It reads only the manifest and those files,
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
 * materialization failure; 2 for a usage or manifest-contract error.
 *
 * **Manifest.** `--logs-manifest <file>` appears once, followed by exactly one
 * manifest path. The manifest has the grammar of the report-path manifests
 * (`aggregation-campaign-report-manifest-lib.mjs`, `parsePathManifest`) with
 * another entry count: strict UTF-8 without BOM, 1 to
 * `LOG_RECOVERY_LIMITS.maxLogs` (128) LF-terminated lines of one job-log path
 * each (at most 1024 UTF-8 bytes, no whitespace padding, control character,
 * comment, quoting, `-` prefix, URL or drive-relative `C:name`), at most
 * 131 200 bytes. A relative line resolves against the manifest's own
 * directory. Lines are recovered in manifest order, which, like explicit
 * order, means nothing: slots come from report content. A manifest is an
 * operator-supplied path list, not evidence.
 *
 * **Argument order.** One `--` may lead (pnpm forwards it). `--output-dir
 * <new-directory>` may appear once, anywhere between the other arguments:
 * before, between or after explicit logs, or before or after `--logs-manifest
 * <file>`. Usage and manifest-contract errors exit 2 before any log is read
 * and before any output file system call, with a fixed line that never echoes
 * an argument, path, manifest line or OS error:
 *
 * - an unknown option (`--output-dir=value` included), `--logs-manifest=value`,
 *   or a repeated `--logs-manifest` or `--output-dir`;
 * - an option without its value (none, empty or starting with `-`), or a
 *   manifest path over 1024 UTF-8 bytes;
 * - explicit logs mixed with `--logs-manifest`, or any other argument after
 *   the manifest path;
 * - `--` anywhere but once, first;
 * - no log, an empty explicit path, an explicit path over 1024 UTF-8 bytes,
 *   or more than `LOG_RECOVERY_LIMITS.maxLogs` explicit paths;
 * - the same log path twice, in either mode (compared after resolution; on
 *   Windows case-insensitively, ignoring trailing dots and spaces; file system
 *   identity such as hard links, symlinks, junctions or 8.3 names is not
 *   consulted);
 * - a manifest that cannot be read, exceeds its byte limit (checked before and
 *   after reading) or breaks the grammar.
 *
 * A listed log that cannot be read or is too large stays a recovery failure
 * (exit 1), counted and never named, exactly as for explicit logs.
 *
 * Manual and outside every gate: nothing in `pnpm verify`, the test phases or
 * CI runs it. It scans no directory, expands no glob and reads no GitHub
 * state. It never prints a path or a recovered value. All recovery logic
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
import {
  REPORT_PATH_LIMITS,
  exceedsPathBytes,
  findPathCollision,
  loadPathManifest,
  pathApiFor,
} from './aggregation-campaign-report-manifest-lib.mjs';

const USAGE =
  'usage: node scripts/aggregation-campaign-log-recovery.mjs [--output-dir <new-directory>] <job-log> [<job-log> ...] | [--output-dir <new-directory>] --logs-manifest <file>';

const OUTPUT_DIR_OPTION = '--output-dir';
const MANIFEST_OPTION = '--logs-manifest';

/** Fixed usage messages; no argument text is ever echoed. */
export const USAGE_ERROR = Object.freeze({
  unknownOption: 'unknown option',
  inlineValue: '--logs-manifest takes no inline value',
  outputRepeated: 'output directory given more than once',
  outputValue: 'output directory option needs a value',
  manifestRepeated: '--logs-manifest given more than once',
  manifestValue: '--logs-manifest needs exactly one manifest path',
  extraArgument: 'unexpected argument after the manifest path',
  mixedModes: 'explicit job-log paths and --logs-manifest cannot be mixed',
  noLog: 'no job log given',
  emptyPath: 'job-log path is empty',
  pathTooLong: 'path exceeds the path byte limit',
  tooManyPaths: 'more job-log paths than the recovery limit',
  lateSeparator: '-- is accepted only once, before the first argument',
  duplicatePath: 'the same job-log path is listed twice',
});

/** The fixed line-count problem of a job-log manifest under `limits`. */
export const logsManifestCountProblem = (limits = LOG_RECOVERY_LIMITS) =>
  `manifest does not list between 1 and ${limits.maxLogs} job-log paths`;

const usage = (reason) => ({ ok: false, exitCode: 2, output: `${reason}\n${USAGE}\n` });

/**
 * Splits arguments into one of the two modes, deterministically, or a usage
 * error, before any file is touched. Returns
 * `{ ok: true, mode: 'paths', paths, outputDir }` or
 * `{ ok: true, mode: 'manifest', manifest, outputDir }` (`outputDir` is
 * `undefined` for the read-only form). `platform` and `cwd` only decide how
 * explicit paths are compared for duplicates; paths are returned as given.
 */
export function parseRecoveryArgs(
  argv,
  {
    platform = process.platform,
    cwd = process.cwd(),
    limits = LOG_RECOVERY_LIMITS,
    pathLimits = REPORT_PATH_LIMITS,
  } = {},
) {
  const paths = [];
  let manifest;
  let outputDir;
  const args = (Array.isArray(argv) ? argv : []).map(String);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    // `pnpm run <script> -- …` forwards the separator itself, once, first.
    if (arg === '--') {
      if (index !== 0) return usage(USAGE_ERROR.lateSeparator);
      continue;
    }
    if (arg === OUTPUT_DIR_OPTION) {
      const value = args[index + 1];
      if (outputDir !== undefined) return usage(USAGE_ERROR.outputRepeated);
      if (value === undefined || value === '' || value.startsWith('-')) {
        return usage(USAGE_ERROR.outputValue);
      }
      outputDir = value;
      index += 1;
      continue;
    }
    if (arg === MANIFEST_OPTION) {
      const value = args[index + 1];
      if (manifest !== undefined) return usage(USAGE_ERROR.manifestRepeated);
      if (paths.length > 0) return usage(USAGE_ERROR.mixedModes);
      if (value === undefined || value === '' || value.startsWith('-')) {
        return usage(USAGE_ERROR.manifestValue);
      }
      if (exceedsPathBytes(value, pathLimits)) return usage(USAGE_ERROR.pathTooLong);
      manifest = value;
      index += 1;
      continue;
    }
    if (arg.startsWith(`${MANIFEST_OPTION}=`)) return usage(USAGE_ERROR.inlineValue);
    if (arg.startsWith('-')) return usage(USAGE_ERROR.unknownOption);
    if (manifest !== undefined) return usage(USAGE_ERROR.extraArgument);
    if (arg === '') return usage(USAGE_ERROR.emptyPath);
    if (exceedsPathBytes(arg, pathLimits)) return usage(USAGE_ERROR.pathTooLong);
    paths.push(arg);
    if (paths.length > limits.maxLogs) return usage(USAGE_ERROR.tooManyPaths);
  }
  if (manifest !== undefined) return { ok: true, mode: 'manifest', manifest, outputDir };
  if (paths.length === 0) return usage(USAGE_ERROR.noLog);

  const api = pathApiFor(platform);
  const collision = findPathCollision(
    { logs: paths.map((path) => api.resolve(cwd, path)) },
    { platform },
  );
  if (collision !== null) return usage(USAGE_ERROR.duplicatePath);
  return { ok: true, mode: 'paths', paths, outputDir };
}

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
 * touches nothing it does not own. `manifestSizeOf` and `readManifestBytes`
 * read only the job-log manifest; `platform` and `cwd` are injectable so
 * Windows path comparison can be tested on any host.
 */
export function runLogRecoveryCli({
  argv = [],
  sizeOf = (path) => statSync(path).size,
  readText = (path) => readFileSync(path, 'utf8'),
  manifestSizeOf = (path) => statSync(path).size,
  readManifestBytes = (path) => readFileSync(path),
  platform = process.platform,
  cwd = process.cwd(),
  limits = LOG_RECOVERY_LIMITS,
  fs = NODE_MATERIALIZATION_FS,
} = {}) {
  const parsed = parseRecoveryArgs(argv, { platform, cwd, limits });
  if (!parsed.ok) return { exitCode: parsed.exitCode, output: parsed.output };
  const { outputDir } = parsed;

  let { paths } = parsed;
  if (parsed.mode === 'manifest') {
    const manifest = loadPathManifest(parsed.manifest, {
      sizeOf: manifestSizeOf,
      readBytes: readManifestBytes,
      platform,
      cwd,
      minEntries: 1,
      maxEntries: limits.maxLogs,
      countProblem: logsManifestCountProblem(limits),
    });
    if (!manifest.ok) return usage(`logs manifest: ${manifest.problem}`);
    if (findPathCollision({ logs: manifest.paths }, { platform }) !== null) {
      return usage(USAGE_ERROR.duplicatePath);
    }
    paths = manifest.paths;
  }

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
