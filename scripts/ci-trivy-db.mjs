#!/usr/bin/env node
// Usage: node scripts/ci-trivy-db.mjs fetch <trivy-cache-dir>
//        node scripts/ci-trivy-db.mjs check <trivy-cache-dir> <producer-key>
// See ci-trivy-db-lib.mjs for why, for the time budget and for what a usable
// DB is.
//   fetch  download the DB (mirror.gcr.io, then ghcr.io; bounded retries on any
//          failure), validate it, and write `key=<producer key>` to
//          $GITHUB_OUTPUT
//   check  fail unless the DB in the directory is the copy the producer named
//          by <producer-key> validated, intact, and no older than 24 h; prints
//          the evidence line on success
// Production policy only: the repositories, retries, deadlines and the clock
// are the library's fixed values. There are no test knobs here (a knob that
// can loosen a security gate is not a gate); tests drive the library. The
// only inputs are the run's identity (GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT), the
// key, and `trivy` on PATH, which the workflow installs at a pinned version.
import { appendFileSync, mkdirSync } from 'node:fs';
import { checkDb, fetchDb } from './ci-trivy-db-lib.mjs';

const [mode, cacheDir, key, ...rest] = process.argv.slice(2);
const usage =
  rest.length > 0 ||
  !cacheDir ||
  !((mode === 'fetch' && key === undefined) || (mode === 'check' && key !== undefined));
if (usage) {
  process.stderr.write(
    'usage: ci-trivy-db.mjs fetch <trivy-cache-dir> | check <trivy-cache-dir> <producer-key>\n',
  );
  process.exit(2);
}
const run = { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
const refuse = (reason) => {
  process.stderr.write(`::error::trivy-db: ${reason}\n`);
  process.exit(1);
};

if (mode === 'fetch') {
  if (!process.env.GITHUB_OUTPUT) refuse('GITHUB_OUTPUT is not set; nowhere to publish the key');
  mkdirSync(cacheDir, { recursive: true });
  const result = await fetchDb(cacheDir, { run });
  if (!result.ok) refuse(result.reason);
  appendFileSync(process.env.GITHUB_OUTPUT, `key=${result.key}\n`);
} else {
  const result = checkDb(cacheDir, { now: new Date(), key, run });
  if (!result.ok) refuse(result.reason);
  const { source } = result;
  process.stdout.write(
    `trivy-db: shared copy ok - ${source.key} from repository ${source.repository}, fetched by run ${source.runId} attempt ${source.runAttempt} at ${source.fetchedAt}, UpdatedAt ${result.updatedAt} (${result.ageHours.toFixed(1)} h old, limit 24 h), ${result.buckets} buckets, sha256 verified\n`,
  );
}
