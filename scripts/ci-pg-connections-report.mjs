#!/usr/bin/env node
/**
 * Prints the connection peak the watcher recorded (PG_CONNECTIONS_SAMPLES)
 * against max_connections, and a `::warning::` annotation when less than a
 * fifth of the usable slots was left. Never fails: the verdict of the job is
 * its tests', and a monitor that could not sample says so instead.
 * Reads nothing from its command line. See ci-pg-connections-lib.mjs.
 */
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { summarize } from './ci-pg-connections-lib.mjs';

let limits = null;
const samples = [];
try {
  for (const line of readFileSync(process.env.PG_CONNECTIONS_SAMPLES ?? '', 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if ('limits' in row) limits = row.limits;
    else samples.push(row);
  }
} catch {
  // Missing or unreadable: summarize() reports that there was nothing to report.
}
const { lines, warning } = summarize(samples, limits, availableParallelism());
for (const line of lines) console.log(line);
if (warning) {
  console.log(
    '::warning title=PostgreSQL connection margin::less than 20% of the usable connection slots ' +
      'was left at the peak (or the monitor could not measure it); see the [pg-connections] lines',
  );
}
