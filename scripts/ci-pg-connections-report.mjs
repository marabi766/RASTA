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
  errorCode,
  readSeries,
  readOwner,
  stopWatcher,
  requestStop,
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
  const ownerFile = process.env.PG_CONNECTIONS_OWNER;
  requestStop(ownerFile);
  const owner = readOwner(ownerFile, process.env.PG_CONNECTIONS_RUN);
  const stopped = await stopWatcher(owner ?? {}, {
    waitMs: TIMING.stopWaitMs,
    killWaitMs: TIMING.killWaitMs,
  });
  console.log(`[pg-connections] watcher: ${stopped}`);
  const finalOwner = readOwner(ownerFile, process.env.PG_CONNECTIONS_RUN);
  // If the status rename also failed (e.g. a full device), use only the
  // watcher's sanitized code from its captured stderr, never raw log text.
  let appendFailure = finalOwner?.failure;
  if (owner && !appendFailure) {
    try {
      const match =
        /^\[pg-connections\] append failed \((start|limits|sample|stop):(E[A-Z0-9]{1,15})\)$/m.exec(
          readFileSync(`${ownerFile}.log`, 'utf8'),
        );
      if (match) appendFailure = { phase: match[1], code: match[2] };
    } catch {
      /* unavailable log: missing records still mean incomplete */
    }
  }
  const ownershipProblem = !owner
    ? 'watcher did not start'
    : appendFailure
      ? `append failed (${appendFailure.phase}:${appendFailure.code})`
      : /not stopped|still present/.test(stopped)
        ? 'watcher shutdown unconfirmed'
        : null;
  if (ownershipProblem)
    console.log(`::warning title=PostgreSQL connection margin::${ownershipProblem}`);
  const memory = containerMemory(
    process.env.PG_CONTAINER_ID,
    (path) => readFileSync(path, 'utf8').trim(),
    totalmem(),
  );
  const { lines, warnings } = summarize(readSeries(read()), {
    cpus: availableParallelism(),
    now: Date.now(),
    memory,
    ownershipProblem,
  });
  for (const line of lines) console.log(line);
  for (const text of warnings) console.log(`::warning title=PostgreSQL connection margin::${text}`);
} catch (error) {
  console.log(`[pg-connections] the report itself failed (${errorCode(error)}): margin unknown`);
  console.log(
    '::warning title=PostgreSQL connection margin::the connection report failed: margin unknown',
  );
}
process.exit(0);
