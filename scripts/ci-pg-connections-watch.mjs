#!/usr/bin/env node
/**
 * Samples PostgreSQL's client sessions once a second until it is stopped,
 * into the file named by PG_CONNECTIONS_SAMPLES (JSON lines: a start record
 * with its pid and process group, the limits, one record per sample or
 * failed sample, and a stop record). Connects with the standard PG* variables
 * as the cluster's administrator, which may use the reserved superuser slots,
 * so it still gets in when the ceiling is reached.
 *
 * Every psql it starts — the limits query and each sample — runs bounded
 * (runBounded: TERM at its deadline, KILL after a grace). On SIGTERM or SIGINT
 * it stops the psql in flight the same way, waits for it to be gone, records
 * the stop and exits 0, within termGraceMs + killWaitMs. The workflow starts
 * it under `setsid`, so the report step can also end its whole process group.
 * Reads nothing from its command line. See ci-pg-connections-lib.mjs.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import {
  LIMITS_SQL,
  parseLimits,
  parseSample,
  runBounded,
  SAMPLE_SQL,
  TIMING,
} from './ci-pg-connections-lib.mjs';

let active = null;
let stopping = false;
let wake = () => {};

async function stop() {
  if (stopping) return;
  stopping = true;
  wake();
  if (active) await active.stop();
  record({ stopped: Date.now() });
  process.exit(0);
}
// Installed before the first child exists: no psql can start unwatched.
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

const file = process.env.PG_CONNECTIONS_SAMPLES;
if (!file) {
  console.error('ci-pg-connections-watch: PG_CONNECTIONS_SAMPLES is not set');
  process.exit(2);
}

function record(entry) {
  try {
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // A lost line is a stretch without a sample, which the report counts.
  }
}

/** This process's group id, from /proc (Linux); null when unreadable. */
function ownProcessGroup() {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  } catch {
    return null;
  }
}

async function psql(sql) {
  active = runBounded('psql', ['-X', '-A', '-t', '-F', '|', '-c', sql], {
    env: { ...process.env, PGCONNECT_TIMEOUT: '5', PGAPPNAME: 'ci-pg-connections' },
    deadlineMs: TIMING.queryDeadlineMs,
    termGraceMs: TIMING.termGraceMs,
    killWaitMs: TIMING.killWaitMs,
  });
  const result = await active.done;
  active = null;
  return result;
}

writeFileSync(file, '');
record({ started: Date.now(), pid: process.pid, pgid: ownProcessGroup() });
const limits = await psql(LIMITS_SQL);
if (!stopping) {
  const parsed = limits.ok ? parseLimits(limits.stdout) : null;
  record({ limits: parsed, ...(parsed ? {} : { reason: limits.reason ?? 'unreadable' }) });
}

while (!stopping) {
  const started = Date.now();
  const result = await psql(SAMPLE_SQL);
  if (stopping) break;
  const parsed = result.ok ? parseSample(result.stdout) : { reason: result.reason };
  record(parsed.sample ?? { failed: started, reason: parsed.reason });
  await new Promise((resolve) => {
    wake = resolve;
    setTimeout(resolve, Math.max(0, TIMING.periodMs - (Date.now() - started)));
  });
}
// stop() records the stop and exits once the child in flight is gone.
