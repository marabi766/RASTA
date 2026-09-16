#!/usr/bin/env node
/**
 * Accounts for the preregistered ADR-055 fresh-run campaign's 59 slots from
 * the content of its calibration reports.
 *
 *   node scripts/aggregation-campaign-accounting.mjs <report> [<report> ...]
 *   pnpm run account:aggregation-campaign -- <report> [<report> ...]
 *
 * Give it every campaign report explicitly — one per slot, produced by
 * `calibrate:aggregation-stress -- --pairs 1 --slot <S>`. It enumerates slots
 * `1..59`, resolves each to `non-event`, `event`, `blocker` or `missing` from
 * the report text alone (preregistration § 8.4), prints every slot and the
 * totals, and asserts `non-events + events + blockers + missing == 59`.
 *
 * Exit 0 only for a complete, parseable, provenance-consistent campaign with
 * zero blockers and zero missing slots; 1 otherwise; 2 for a usage error.
 *
 * Manual and outside every gate, like the campaign itself: nothing in
 * `pnpm verify` or CI runs it. It reads no GitHub state and no job conclusion,
 * never prints a path, and applies no threshold or interpretation — the § 6
 * branches remain a human step. All logic is in
 * `aggregation-campaign-accounting-lib.mjs`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { accountCampaign, formatAccounting } from './aggregation-campaign-accounting-lib.mjs';

const USAGE = 'usage: node scripts/aggregation-campaign-accounting.mjs <report> [<report> ...]';

/**
 * The CLI as a value: paths in, text and an exit code out. The reader is
 * injectable so a test can prove a file that cannot be read is counted, not
 * named. A path never reaches the output — the result is a function of the
 * report contents only.
 */
export function runAccountingCli({
  argv = [],
  readText = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const paths = [];
  for (const arg of argv.map(String)) {
    // `pnpm run <script> -- …` forwards the separator itself.
    if (arg === '--') continue;
    if (arg.startsWith('-')) {
      return { exitCode: 2, output: `unknown option ${JSON.stringify(arg)}\n${USAGE}\n` };
    }
    paths.push(arg);
  }
  if (paths.length === 0) return { exitCode: 2, output: `no report given\n${USAGE}\n` };

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
