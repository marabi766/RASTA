#!/usr/bin/env node
/**
 * Samples PostgreSQL's client sessions once a second until it is killed, into
 * the file named by PG_CONNECTIONS_SAMPLES (JSON lines). Connects with the
 * standard PG* variables as the cluster's administrator, which may use the
 * reserved superuser slots, so it still gets in when the ceiling is reached.
 * Reads nothing from its command line. See ci-pg-connections-lib.mjs.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { LIMITS_SQL, parseLimits, parseSample, SAMPLE_SQL } from './ci-pg-connections-lib.mjs';

const run = promisify(execFile);
const file = process.env.PG_CONNECTIONS_SAMPLES;
if (!file) {
  console.error('ci-pg-connections-watch: PG_CONNECTIONS_SAMPLES is not set');
  process.exit(2);
}
const psql = (sql) =>
  run('psql', ['-X', '-A', '-t', '-F', '|', '-c', sql], {
    env: { ...process.env, PGCONNECT_TIMEOUT: '5', PGAPPNAME: 'ci-pg-connections' },
    timeout: 10_000,
  });

writeFileSync(file, '');
const limits = parseLimits((await psql(LIMITS_SQL).catch(() => ({ stdout: '' }))).stdout);
appendFileSync(file, `${JSON.stringify({ limits })}\n`);

for (;;) {
  const started = Date.now();
  try {
    const sample = parseSample((await psql(SAMPLE_SQL)).stdout);
    if (sample) appendFileSync(file, `${JSON.stringify(sample)}\n`);
  } catch {
    // A refused or slow sample is a gap in the series, never a failure of the job.
  }
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1000 - (Date.now() - started))));
}
