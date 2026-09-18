#!/usr/bin/env node
/**
 * Checks the ADR-055 launch preflight bundle offline: one launch record, the
 * exact workflow snapshot intended for installation, and the image-cohort
 * manifest, linked to each other by SHA-256 and by the campaign commit.
 *
 *   node scripts/aggregation-campaign-preflight.mjs <launch-record> <workflow-snapshot> <image-cohort-manifest>
 *   pnpm run check:aggregation-campaign-preflight -- <launch-record> <workflow-snapshot> <image-cohort-manifest>
 *
 * It reads exactly those three files as bytes, after checking each size, writes
 * nothing, calls no network or GitHub API, and never prints a path, digest,
 * commit, timestamp or file content. The manifest's chronology is checked
 * against the time the command runs.
 *
 * Exit 0 only for `PREFLIGHT: COMPLETE`; 1 for `PREFLIGHT: REJECTED`, whatever
 * the reason; 2 for a usage error.
 *
 * Manual and outside every gate: nothing in `pnpm verify`, the test phases or
 * CI runs it. It installs nothing and proves no live fact. All logic is in
 * `aggregation-campaign-preflight-lib.mjs`.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PREFLIGHT_INPUT_LIMITS,
  checkPreflightBundle,
  formatPreflight,
} from './aggregation-campaign-preflight-lib.mjs';

const USAGE =
  'usage: node scripts/aggregation-campaign-preflight.mjs <launch-record> <workflow-snapshot> <image-cohort-manifest>';

/**
 * The CLI as a value: arguments in, text and an exit code out. The file system
 * and the clock are injectable so a test can prove unreadable and oversized
 * files are counted, not named or read, and that the review time is explicit.
 */
export function runPreflightCli({
  argv = [],
  sizeOf = (path) => statSync(path).size,
  readBytes = (path) => readFileSync(path),
  now = new Date(),
} = {}) {
  const paths = [];
  for (const arg of argv.map(String)) {
    // `pnpm run <script> -- …` forwards the separator itself.
    if (arg === '--') continue;
    if (arg.startsWith('-')) return { exitCode: 2, output: `unknown option\n${USAGE}\n` };
    paths.push(arg);
  }
  if (paths.length !== 3) {
    return {
      exitCode: 2,
      output: `expected exactly three inputs, got ${paths.length}\n${USAGE}\n`,
    };
  }

  /** `{ bytes }`, or a state without reading when the size is unknown or too big. */
  const load = (path, limit) => {
    try {
      if (sizeOf(path) > limit) return { oversized: true };
      return { bytes: readBytes(path) };
    } catch {
      return { unreadable: true };
    }
  };

  const [recordPath, workflowPath, manifestPath] = paths;
  const result = checkPreflightBundle({
    record: load(recordPath, PREFLIGHT_INPUT_LIMITS.record),
    workflow: load(workflowPath, PREFLIGHT_INPUT_LIMITS.workflow),
    manifest: load(manifestPath, PREFLIGHT_INPUT_LIMITS.manifest),
    now,
  });
  return { exitCode: result.exitCode, output: formatPreflight(result) };
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { exitCode, output } = runPreflightCli({ argv: process.argv.slice(2) });
  process.stdout.write(output);
  process.exitCode = exitCode;
}
