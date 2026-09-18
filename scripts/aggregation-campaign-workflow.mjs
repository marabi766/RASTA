#!/usr/bin/env node
/**
 * Statically checks the ADR-055 fresh-run campaign workflow draft against its
 * no-retry / manual-rerun contract.
 *
 *   node scripts/aggregation-campaign-workflow.mjs <draft>
 *   pnpm run check:aggregation-campaign-workflow -- <draft>
 *
 * Give it the draft path explicitly — today
 * `docs/evidence/adr-055/fresh-run-campaign-workflow-draft-2026-09-16.yaml.txt`,
 * and at a future launch the installed copy, before it is pushed. It reads only
 * that one file and prints a bounded, deterministic verdict that never contains
 * the path.
 *
 * Exit 0 only when the whole contract holds; 1 for a violated contract, a
 * malformed draft or an unreadable file; 2 for a usage error.
 *
 * Manual and outside every gate: nothing in `pnpm verify`, the test phases or
 * CI runs it. It installs, pushes and dispatches nothing and calls no GitHub
 * API. All logic is in `aggregation-campaign-workflow-lib.mjs`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatWorkflowCheck,
  validateWorkflowDraft,
} from './aggregation-campaign-workflow-lib.mjs';

const USAGE = 'usage: node scripts/aggregation-campaign-workflow.mjs <draft>';

/**
 * The CLI as a value: arguments in, text and an exit code out. The reader is
 * injectable so a test can prove an unreadable draft fails without naming it.
 */
export function runWorkflowCheckCli({
  argv = [],
  readText = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const paths = [];
  for (const arg of argv.map(String)) {
    // `pnpm run <script> -- …` forwards the separator itself.
    if (arg === '--') continue;
    if (arg.startsWith('-')) return { exitCode: 2, output: `unknown option\n${USAGE}\n` };
    paths.push(arg);
  }
  if (paths.length !== 1) {
    return { exitCode: 2, output: `expected exactly one draft, got ${paths.length}\n${USAGE}\n` };
  }

  let text;
  try {
    text = readText(paths[0]);
  } catch {
    return {
      exitCode: 1,
      output: formatWorkflowCheck({ ok: false, problems: ['draft could not be read'] }),
    };
  }
  const result = validateWorkflowDraft(text);
  return { exitCode: result.ok ? 0 : 1, output: formatWorkflowCheck(result) };
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { exitCode, output } = runWorkflowCheckCli({ argv: process.argv.slice(2) });
  process.stdout.write(output);
  process.exitCode = exitCode;
}
