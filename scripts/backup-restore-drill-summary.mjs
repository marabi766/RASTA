#!/usr/bin/env node
// Prints the allowlisted summary of one scheduled drill run (backup-drill-monthly.yml) and
// exits non-zero unless the run passed on every gate. It reads the CLI's report, exit status and
// stderr from files the workflow keeps private; it prints none of their contents except what
// summarizeDrillReport allows (booleans, bounded counts, names of the service registry, closed
// stage names). Every failure of this script itself is one fixed message: a thrown error would
// print a stack with source paths, and a malformed report is untrusted input.

const OPTIONS = new Set(['--report', '--exit-code', '--progress']);
const USAGE =
  'Usage: backup-restore-drill-summary --report <report.json> --exit-code <status> [--progress <stderr file>]';
const FAILED = [
  '## Monthly backup/restore drill: FAILED',
  '',
  'The summary could not be built from the drill output; nothing from it is printed.',
  'Treat the run as failed and re-run the drill locally: scripts/backup-restore-drill --report <new file>.',
  '',
].join('\n');

// The progress file is the CLI's stderr: stage lines only, so far below this.
const MAX_PROGRESS_BYTES = 8 * 1024 * 1024;

async function main() {
  const values = new Map();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    // Refused by position, not repeated: an argument is a path or a value the operator chose.
    if (!OPTIONS.has(args[index]) || index + 1 >= args.length || values.has(args[index])) {
      console.error(USAGE);
      return 2;
    }
    values.set(args[index], args[index + 1]);
  }
  if (!values.has('--report') || !values.has('--exit-code')) {
    console.error(USAGE);
    return 2;
  }
  // Loaded here, not at the top, so that a failing import is also one fixed message.
  const {
    MAX_REPORT_BYTES,
    lastAllowedStage,
    readRegularFile,
    renderDrillSummary,
    summarizeDrillReport,
    summaryRegistry,
  } = await import('./backup-restore-drill-lib.mjs');
  // Either input may be anything the filesystem holds: a FIFO must not block the summary, a
  // huge file must not be read whole, and what cannot be read as a regular file is "no input".
  const readOrNull = (path, maxBytes, parse) => {
    try {
      return parse(readRegularFile(path, { maxBytes }));
    } catch {
      return null;
    }
  };
  const { servicesFromLibrary } = await import('./infra-preflight-lib.mjs');
  // The real registry (the list the drill iterates), not names taken from the run's own output.
  const services = servicesFromLibrary();
  if (!services.length) throw new Error('empty registry');
  // A missing or non-numeric status means the CLI never reported one (timeout, cancellation).
  const exitCode = /^\d{1,3}$/.test(values.get('--exit-code'))
    ? Number(values.get('--exit-code'))
    : null;
  const report = readOrNull(values.get('--report'), MAX_REPORT_BYTES, JSON.parse);
  const lastStage = values.has('--progress')
    ? readOrNull(values.get('--progress'), MAX_PROGRESS_BYTES, (text) =>
        lastAllowedStage(text, summaryRegistry(services)),
      )
    : null;
  const summary = summarizeDrillReport(report, { exitCode, lastStage, services });
  process.stdout.write(renderDrillSummary(summary));
  return summary.passed ? 0 : 1;
}

function failClosed() {
  process.stdout.write(FAILED);
  console.error('backup-restore-drill-summary: the summary could not be built');
  process.exitCode = 1;
}
process.on('uncaughtException', failClosed);
try {
  process.exitCode = await main();
} catch {
  failClosed();
}
