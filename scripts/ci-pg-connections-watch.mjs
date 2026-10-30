#!/usr/bin/env node
/**
 * Samples PostgreSQL's client sessions once a second until it is stopped,
 * into the file named by PG_CONNECTIONS_SAMPLES (JSON lines: a start record
 * with its start time, the limits, one record per sample or
 * failed sample, and a stop record). Connects with the standard PG* variables
 * as the cluster's administrator, which may use the reserved superuser slots,
 * so it still gets in when the ceiling is reached.
 *
 * Every psql it starts — the limits query and each sample — runs bounded
 * (3 s connect timeout + 3 s server statement timeout, independently of this leader).
 * runBounded also enforces a local deadline. On SIGTERM, SIGINT or SIGHUP
 * it stops the psql in flight the same way, waits for it to be gone, records
 * the stop and exits 0, within termGraceMs + killWaitMs. The workflow starts
 * it in a detached process group, so the report step can also end its whole process group.
 * Reads nothing from its command line. See ci-pg-connections-lib.mjs.
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import {
  errorCode,
  processIdentity,
  writeOwner,
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
  record('stop', { stopped: Date.now() });
  process.exit(0);
}
// Installed before the first child exists: no psql can start unwatched.
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGHUP', stop);

const file = process.env.PG_CONNECTIONS_SAMPLES;
if (!file) {
  console.error('ci-pg-connections-watch: PG_CONNECTIONS_SAMPLES is not set');
  process.exit(2);
}

const ownerFile = process.env.PG_CONNECTIONS_OWNER;
// The launcher supplies an absolute deadline, so a delayed handshake cannot reset the budget.
const suppliedDeadline = Number(process.env.PG_CONNECTIONS_DEADLINE);
const expires = Math.min(
  Number.isFinite(suppliedDeadline) ? suppliedDeadline : Infinity,
  Date.now() + TIMING.watcherLifetimeMs,
);
const requested = () => existsSync(`${ownerFile}.stop`) || Date.now() >= expires;
if (requested()) process.exit(0);
setTimeout(stop, Math.max(0, expires - Date.now()));
setInterval(() => {
  if (requested()) void stop();
}, TIMING.stopPollMs);
const owner = { pid: process.pid, ...processIdentity(), run: process.env.PG_CONNECTIONS_RUN };
// A query is forbidden until independent ownership has been committed atomically.
try {
  if (!ownerFile || !owner.run || owner.pgid !== process.pid) throw { code: 'EINVAL' };
  writeOwner(ownerFile, owner);
} catch (error) {
  console.error(`[pg-connections] watcher did not start (${errorCode(error)})`);
  process.exit(2);
}

function record(phase, entry) {
  try {
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return true;
  } catch (error) {
    owner.failure ??= { phase, code: errorCode(error) };
    try {
      writeOwner(ownerFile, owner);
    } catch {
      // The status device may also be full. Missing stop still means incomplete.
    }
    console.error(`[pg-connections] append failed (${owner.failure.phase}:${owner.failure.code})`);
    // Never issue another query after losing the ability to retain its answer.
    process.exit(0);
  }
}

async function psql(sql) {
  if (stopping || requested()) {
    void stop();
    return { ok: false, reason: 'stopped' };
  }
  active = runBounded('psql', ['-X', '-A', '-t', '-F', '|', '-c', sql], {
    env: {
      ...process.env,
      PGCONNECT_TIMEOUT: String(TIMING.connectTimeoutS),
      PGOPTIONS: `-c statement_timeout=${TIMING.statementTimeoutMs}`,
      PGAPPNAME: 'ci-pg-connections',
    },
    deadlineMs: TIMING.queryDeadlineMs,
    termGraceMs: TIMING.termGraceMs,
    killWaitMs: TIMING.killWaitMs,
  });
  const result = await active.done;
  active = null;
  return result;
}

try {
  writeFileSync(file, '');
} catch (error) {
  owner.failure = { phase: 'start', code: errorCode(error) };
  try {
    writeOwner(ownerFile, owner);
  } catch {
    /* report sees missing records */
  }
  process.exit(0);
}
record('start', { started: Date.now() });
const limits = await psql(LIMITS_SQL);
if (!stopping) {
  const parsed = limits.ok ? parseLimits(limits.stdout) : null;
  record('limits', {
    limits: parsed,
    ...(parsed ? {} : { reason: limits.reason ?? 'unreadable' }),
  });
}

while (!stopping) {
  const started = Date.now();
  const result = await psql(SAMPLE_SQL);
  if (stopping) break;
  const parsed = result.ok ? parseSample(result.stdout) : { reason: result.reason };
  record('sample', parsed.sample ?? { failed: started, reason: parsed.reason });
  await new Promise((resolve) => {
    wake = resolve;
    setTimeout(resolve, Math.max(0, TIMING.periodMs - (Date.now() - started)));
  });
}
// stop() records the stop and exits once the child in flight is gone.
