#!/usr/bin/env node
// Usage: node scripts/ci-trivy-db.mjs fetch <trivy-cache-dir>
//        node scripts/ci-trivy-db.mjs check <trivy-cache-dir> <producer-key>
//        node scripts/ci-trivy-db.mjs pack <trivy-cache-dir> <archive-file>
//        node scripts/ci-trivy-db.mjs unpack <artifact-dir> <trivy-cache-dir>
// See ci-trivy-db-lib.mjs for why, for the time budget and for what a usable
// DB is.
//   fetch   download the DB (mirror.gcr.io, then ghcr.io; bounded retries on any
//           failure), validate it, and write `key=<producer key>` to
//           $GITHUB_OUTPUT
//   check   fail unless the DB in the directory is the copy the producer named
//           by <producer-key> validated, intact, and no older than 24 h; prints
//           the evidence line on success
//   pack    write the validated directory as the producer's archive
//   unpack  admit the downloaded artifact (exactly the producer's archive)
//           and replace the directory with it; `check` follows
// Production policy only: the repositories, retries, deadlines and the clock
// are the library's fixed values. There are no test knobs here (a knob that
// can loosen a security gate is not a gate); tests drive the library. The
// only inputs are the run's identity (GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT), the
// key, and `trivy` and `zstd` on PATH; the workflow installs Trivy at a
// pinned version. Refusals never repeat a path or an unmatched key.
import { appendFileSync, mkdirSync } from 'node:fs';
import { checkDb, fetchDb, packDb, unpackDb } from './ci-trivy-db-lib.mjs';

const ARITY = { fetch: 1, check: 2, pack: 2, unpack: 2 };
const [mode, ...args] = process.argv.slice(2);
if (!Object.hasOwn(ARITY, mode) || args.length !== ARITY[mode] || args.some((a) => !a)) {
  process.stderr.write(
    'usage: ci-trivy-db.mjs fetch <trivy-cache-dir> | check <trivy-cache-dir> <producer-key>' +
      ' | pack <trivy-cache-dir> <archive-file> | unpack <artifact-dir> <trivy-cache-dir>\n',
  );
  process.exit(2);
}
const run = { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
const refuse = (reason) => {
  process.stderr.write(`::error::trivy-db: ${reason}\n`);
  process.exit(1);
};

try {
  if (mode === 'fetch') {
    const [cacheDir] = args;
    if (!process.env.GITHUB_OUTPUT) refuse('GITHUB_OUTPUT is not set; nowhere to publish the key');
    mkdirSync(cacheDir, { recursive: true });
    const result = await fetchDb(cacheDir, { run });
    if (!result.ok) refuse(result.reason);
    appendFileSync(process.env.GITHUB_OUTPUT, `key=${result.key}\n`);
  } else if (mode === 'check') {
    const [cacheDir, key] = args;
    const result = checkDb(cacheDir, { now: new Date(), key, run });
    if (!result.ok) refuse(result.reason);
    const { source } = result;
    process.stdout.write(
      `trivy-db: shared copy ok - ${source.key} from repository ${source.repository}, fetched by run ${source.runId} attempt ${source.runAttempt} at ${source.fetchedAt}, UpdatedAt ${result.updatedAt} (${result.ageHours.toFixed(1)} h old, limit 24 h), ${result.buckets} buckets, sha256 verified\n`,
    );
  } else if (mode === 'pack') {
    const [cacheDir, archive] = args;
    const result = await packDb(cacheDir, archive);
    if (!result.ok) refuse(result.reason);
    process.stdout.write(`trivy-db: packed, ${result.bytes} bytes\n`);
  } else {
    const [artifactDir, cacheDir] = args;
    const result = await unpackDb(artifactDir, cacheDir);
    if (!result.ok) refuse(result.reason);
    process.stdout.write(`trivy-db: archive admitted, ${result.bytes} bytes unpacked\n`);
  }
} catch {
  // The library returns its refusals; anything else is a refusal too, with no detail.
  refuse('failed unexpectedly; refusing');
}
