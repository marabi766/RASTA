/**
 * The Trivy vulnerability DB, fetched once per CI run and checked wherever it
 * is used.
 *
 * Why this exists (main run 40163416703, #380): ten of seventeen image scans
 * died with `failed to download vulnerability DB ... mirror.gcr.io ... failed
 * to fetch the layer: GET https://mirror.gcr.io/artifacts-downloads/...:
 * unexpected status code 404 Not Found`, and the rerun failed the same way on
 * api-gateway. Trivy's own fallback to ghcr.io (pkg/oci/artifact.go) applies
 * only to errors it recognises as transient or BLOB_UNKNOWN; a 404 on the
 * layer is neither, so ghcr.io was never tried. trivy-action's daily cache
 * did not help either: every job restored `cache-trivy-<date>` and still logged
 * `Need to update DB`, then downloaded 129 MB on its own.
 *
 * So: one producer job runs `trivy image --download-db-only` against each
 * repository in turn, retrying on ANY failure, and every scan restores that
 * exact copy and scans with `TRIVY_SKIP_DB_UPDATE`. Skip mode makes Trivy
 * validate the schema only and never age, so `checkDb` is the freshness gate.
 *
 * The scan itself (severity, exit code, ignore-unfixed, ignore files, images)
 * is not touched.
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** Tried in order. Same pair Trivy v0.70.0 defaults to, but tried on ANY failure. */
export const DEFAULT_REPOSITORIES = [
  'mirror.gcr.io/aquasec/trivy-db:2',
  'ghcr.io/aquasecurity/trivy-db:2',
];
/** Sleep before each retry within one repository; the length is the retry count (3 attempts). */
export const DEFAULT_BACKOFF_SECONDS = [5, 15];

/**
 * Oldest `UpdatedAt` a scan may use. Aquasec publishes every 6 hours and stamps
 * `NextUpdate` exactly 24 h after `UpdatedAt`; Trivy's own online mode treats
 * the DB as current until that moment. The same 24 h on `UpdatedAt` therefore
 * keeps the offline gate as strict as the online one, and still tolerates a
 * missed publish or two. Not overridable by environment: a knob that can
 * loosen a security gate is not a gate.
 */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A timestamp this far ahead of the runner's clock is a clock error or a forgery. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const SCHEMA_VERSION = 2;
/** Provenance file written beside `db/`, so a consumer can prove where its copy came from. */
export const SOURCE_FILE = 'ci-trivy-db-source.json';
const BBOLT_MAGIC = 0xed0cdaed; // little-endian uint32 at offset 16 of a bbolt file
const MIN_DB_BYTES = 1024 * 1024;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** @returns {{ok: true, updatedAt: string, ageHours: number, source: object} | {ok: false, reason: string}} */
export function checkDb(cacheDir, now = new Date(), env = process.env) {
  const dbDir = join(cacheDir, 'db');
  const metaPath = join(dbDir, 'metadata.json');
  const dbPath = join(dbDir, 'trivy.db');
  const fail = (reason) => ({ ok: false, reason });

  if (!existsSync(metaPath)) return fail(`missing ${metaPath}`);
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return fail(`${metaPath} is not valid JSON`);
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return fail(`${metaPath} is not a JSON object`);
  }
  if (meta.Version !== SCHEMA_VERSION) {
    return fail(`metadata Version is ${JSON.stringify(meta.Version)}, expected ${SCHEMA_VERSION}`);
  }
  if (typeof meta.UpdatedAt !== 'string' || !RFC3339.test(meta.UpdatedAt)) {
    return fail(
      `metadata UpdatedAt is missing or not an RFC 3339 timestamp: ${JSON.stringify(meta.UpdatedAt)}`,
    );
  }
  const updated = Date.parse(meta.UpdatedAt);
  if (Number.isNaN(updated)) return fail(`metadata UpdatedAt does not parse: ${meta.UpdatedAt}`);
  const age = now.getTime() - updated;
  if (age < -MAX_FUTURE_SKEW_MS) {
    return fail(
      `metadata UpdatedAt ${meta.UpdatedAt} is in the future (runner clock ${now.toISOString()})`,
    );
  }
  if (age > MAX_AGE_MS) {
    return fail(
      `vulnerability DB is stale: UpdatedAt ${meta.UpdatedAt} is ${(age / 3600000).toFixed(1)} h old, limit ${MAX_AGE_MS / 3600000} h`,
    );
  }

  if (!existsSync(dbPath)) return fail(`missing ${dbPath}`);
  if (statSync(dbPath).size < MIN_DB_BYTES)
    return fail(`${dbPath} is smaller than ${MIN_DB_BYTES} bytes`);
  const head = Buffer.alloc(4);
  const fd = openSync(dbPath, 'r');
  try {
    readSync(fd, head, 0, 4, 16);
  } finally {
    closeSync(fd);
  }
  if (head.readUInt32LE(0) !== BBOLT_MAGIC)
    return fail(`${dbPath} is not a bbolt database (bad magic)`);

  const sourcePath = join(cacheDir, SOURCE_FILE);
  if (!existsSync(sourcePath))
    return fail(`missing ${sourcePath}: this DB was not produced by the shared download`);
  let source;
  try {
    source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  } catch {
    return fail(`${sourcePath} is not valid JSON`);
  }
  if (source === null || typeof source !== 'object' || typeof source.repository !== 'string') {
    return fail(`${sourcePath} does not name the repository the DB came from`);
  }
  if (env.GITHUB_RUN_ID && String(source.runId) !== String(env.GITHUB_RUN_ID)) {
    return fail(`DB was fetched by run ${source.runId}, this is run ${env.GITHUB_RUN_ID}`);
  }
  return { ok: true, updatedAt: meta.UpdatedAt, ageHours: age / 3600000, source };
}

/**
 * Downloads the DB, repository by repository, attempt by attempt, until one
 * copy downloads AND passes `checkDb` (a mirror serving a stale copy is a
 * failed attempt, so the next repository gets its turn).
 * @returns {{ok: true, repository: string, check: object} | {ok: false, reason: string}}
 */
export function fetchDb(cacheDir, opts = {}) {
  const {
    trivy = 'trivy',
    repositories = DEFAULT_REPOSITORIES,
    backoffSeconds = DEFAULT_BACKOFF_SECONDS,
    now = () => new Date(),
    sleep = (s) => {
      if (s > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
    },
    log = (line) => process.stderr.write(`${line}\n`),
    env = process.env,
  } = opts;
  const attempts = backoffSeconds.length + 1;
  const failures = [];
  for (const repository of repositories) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // A half-written DB must never be mistaken for the previous attempt's result.
      rmSync(join(cacheDir, 'db'), { recursive: true, force: true });
      rmSync(join(cacheDir, SOURCE_FILE), { force: true });
      const run = spawnSync(
        trivy,
        [
          'image',
          '--download-db-only',
          '--no-progress',
          '--db-repository',
          repository,
          '--cache-dir',
          cacheDir,
        ],
        { stdio: ['ignore', 'inherit', 'inherit'], env },
      );
      let problem = null;
      if (run.error) problem = `could not run ${trivy}: ${run.error.message}`;
      else if (run.status !== 0) problem = `trivy exited ${run.status}`;
      if (problem === null) {
        writeFileSync(
          join(cacheDir, SOURCE_FILE),
          `${JSON.stringify({
            repository,
            attempt,
            fetchedAt: now().toISOString(),
            runId: env.GITHUB_RUN_ID ?? null,
            runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
          })}\n`,
        );
        const check = checkDb(cacheDir, now(), env);
        if (check.ok) {
          log(
            `trivy-db: ${repository} attempt ${attempt}/${attempts} ok (UpdatedAt ${check.updatedAt})`,
          );
          return { ok: true, repository, check };
        }
        problem = `downloaded copy rejected: ${check.reason}`;
      }
      failures.push(`${repository} attempt ${attempt}/${attempts}: ${problem}`);
      log(`::warning::trivy-db: ${failures.at(-1)}`);
      if (attempt < attempts) sleep(backoffSeconds[attempt - 1]);
    }
  }
  rmSync(join(cacheDir, 'db'), { recursive: true, force: true });
  return { ok: false, reason: `no repository yielded a usable DB:\n  ${failures.join('\n  ')}` };
}
