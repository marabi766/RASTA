#!/usr/bin/env node
// Usage: node scripts/ci-trivy-db.mjs fetch|check <trivy-cache-dir>
// See ci-trivy-db-lib.mjs for why, and for the freshness bound.
//   fetch  download the DB (mirror.gcr.io, then ghcr.io; bounded retries on any failure)
//   check  fail unless the DB in the directory is present, intact, from this run's
//          download, and no older than 24 h; prints the evidence line on success
// Test-only knobs: CI_TRIVY_BIN, CI_TRIVY_DB_REPOSITORIES (space separated),
// CI_TRIVY_DB_BACKOFF (seconds, space separated), CI_TRIVY_DB_NOW (ISO instant).
import { mkdirSync } from 'node:fs';
import {
  checkDb,
  DEFAULT_BACKOFF_SECONDS,
  DEFAULT_REPOSITORIES,
  fetchDb,
} from './ci-trivy-db-lib.mjs';

const [mode, cacheDir] = process.argv.slice(2);
if (!['fetch', 'check'].includes(mode) || !cacheDir) {
  process.stderr.write('usage: ci-trivy-db.mjs fetch|check <trivy-cache-dir>\n');
  process.exit(2);
}
const words = (value) => value.split(/\s+/).filter(Boolean);
const nowValue = process.env.CI_TRIVY_DB_NOW;
const clock = () => (nowValue ? new Date(nowValue) : new Date());

if (mode === 'fetch') {
  mkdirSync(cacheDir, { recursive: true });
  const result = fetchDb(cacheDir, {
    trivy: process.env.CI_TRIVY_BIN || 'trivy',
    repositories: process.env.CI_TRIVY_DB_REPOSITORIES
      ? words(process.env.CI_TRIVY_DB_REPOSITORIES)
      : DEFAULT_REPOSITORIES,
    backoffSeconds: process.env.CI_TRIVY_DB_BACKOFF
      ? words(process.env.CI_TRIVY_DB_BACKOFF).map(Number)
      : DEFAULT_BACKOFF_SECONDS,
    now: clock,
  });
  if (!result.ok) {
    process.stderr.write(`::error::trivy-db: ${result.reason}\n`);
    process.exit(1);
  }
} else {
  const result = checkDb(cacheDir, clock());
  if (!result.ok) {
    process.stderr.write(`::error::trivy-db: ${result.reason}\n`);
    process.exit(1);
  }
  const { source } = result;
  process.stdout.write(
    `trivy-db: shared copy ok - repository ${source.repository}, fetched by run ${source.runId} attempt ${source.runAttempt} at ${source.fetchedAt}, UpdatedAt ${result.updatedAt} (${result.ageHours.toFixed(1)} h old, limit 24 h)\n`,
  );
}
