#!/usr/bin/env node
/**
 * Stops the watcher (stopWatcher: TERM, a bounded wait for its process group
 * to empty, KILL for what is left), then prints the connection peaks it
 * recorded (PG_CONNECTIONS_SAMPLES) against max_connections, the postgres
 * container's memory (PG_CONTAINER_ID, cgroup v2), and a `::warning::`
 * annotation when less than a fifth of the usable slots was left or the
 * telemetry has gaps. Never fails: the verdict of the job is its tests', and
 * a monitor that could not measure says so instead.
 * Reads nothing from its command line. See ci-pg-connections-lib.mjs.
 */
import { readFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import {
  containerMemory,
  readSeries,
  stopWatcher,
  summarize,
  TIMING,
} from './ci-pg-connections-lib.mjs';

try {
  const file = process.env.PG_CONNECTIONS_SAMPLES ?? '';
  const read = () => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  const stopped = await stopWatcher(readSeries(read()), {
    waitMs: TIMING.stopWaitMs,
    killWaitMs: TIMING.killWaitMs,
  });
  console.log(`[pg-connections] watcher: ${stopped}`);
  const memory = containerMemory(
    process.env.PG_CONTAINER_ID,
    (path) => readFileSync(path, 'utf8').trim(),
    totalmem(),
  );
  const { lines, warnings } = summarize(readSeries(read()), {
    cpus: availableParallelism(),
    now: Date.now(),
    memory,
  });
  for (const line of lines) console.log(line);
  for (const text of warnings) console.log(`::warning title=PostgreSQL connection margin::${text}`);
} catch (error) {
  console.log(
    `[pg-connections] the report itself failed (${error?.name ?? 'error'}): margin unknown`,
  );
  console.log(
    '::warning title=PostgreSQL connection margin::the connection report failed: margin unknown',
  );
}
process.exit(0);
