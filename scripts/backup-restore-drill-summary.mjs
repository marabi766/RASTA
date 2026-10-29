#!/usr/bin/env node
// Prints the allowlisted summary of one scheduled drill run (backup-drill-monthly.yml) and
// exits non-zero unless the run passed on every gate. It reads the CLI's report, exit status and
// stderr from files the workflow keeps private; it prints none of their contents except what
// summarizeDrillReport allows (booleans, bounded counts, generated names, closed stage names).
import { readFileSync } from 'node:fs';
import {
  lastAllowedStage,
  renderDrillSummary,
  summarizeDrillReport,
} from './backup-restore-drill-lib.mjs';

const OPTIONS = new Set(['--report', '--exit-code', '--progress']);
const values = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  // Refused by position, not repeated: an argument is a path or a value the operator chose.
  if (!OPTIONS.has(args[index]) || index + 1 >= args.length || values.has(args[index])) {
    console.error(
      'Usage: backup-restore-drill-summary --report <report.json> --exit-code <status> [--progress <stderr file>]',
    );
    process.exit(2);
  }
  values.set(args[index], args[index + 1]);
}
if (!values.has('--report') || !values.has('--exit-code')) {
  console.error('Usage: backup-restore-drill-summary --report <report.json> --exit-code <status>');
  process.exit(2);
}

function readOrNull(path, parse) {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
// A missing or non-numeric status means the CLI never reported one (timeout, cancellation).
const exitCode = /^\d{1,3}$/.test(values.get('--exit-code'))
  ? Number(values.get('--exit-code'))
  : null;
const report = readOrNull(values.get('--report'), JSON.parse);
const lastStage = values.has('--progress')
  ? readOrNull(values.get('--progress'), lastAllowedStage)
  : null;
const summary = summarizeDrillReport(report, { exitCode, lastStage });
process.stdout.write(renderDrillSummary(summary));
process.exitCode = summary.passed ? 0 : 1;
