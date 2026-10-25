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
 * repository in turn, retrying on ANY failure inside a time window per
 * repository, and every scan restores that exact copy and scans with
 * `TRIVY_SKIP_DB_UPDATE`. Skip mode makes Trivy validate the schema only and
 * never age or content, so `checkDb` is the gate: it is the one acceptance
 * boundary, used by the producer before it publishes and by every consumer
 * before it scans.
 *
 * This module reads no environment and has no defaults that loosen anything:
 * every input (clock, run identity, key) is a parameter, and the defaults ARE
 * the production policy. Tests inject through these parameters; the CLI
 * (ci-trivy-db.mjs) passes only the run identity and the producer's key.
 * Node built-ins only, so it runs before Trivy is installed and in the
 * producer's sparse checkout.
 *
 * The scan itself (severity, exit code, ignore-unfixed, ignore files, images)
 * is not touched.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Tried in order, and the only repositories a published copy may name. Same
 * pair Trivy v0.70.0 defaults to, but here tried on ANY failure.
 */
export const REPOSITORIES = Object.freeze([
  'mirror.gcr.io/aquasec/trivy-db:2',
  'ghcr.io/aquasecurity/trivy-db:2',
]);
/** Wait before each retry within one repository; its length is the retry count (3 attempts). */
export const BACKOFF_MS = Object.freeze([5_000, 15_000]);

/**
 * Time limits of the producer (F3 of the PR #435 review: a stalled mirror must
 * not eat the job before ghcr.io gets its turn). Each repository owns a fixed
 * window that the previous one cannot spend, and every child process is
 * killed at its deadline (SIGTERM, then SIGKILL `killGraceMs` later), so:
 *
 *   fetch <= 2 windows x 180 s + 2 x 20 s of in-process validation
 *            (structure, content, sha256 of ~1.6 GB) that may start just
 *            before a window closes                                 = 400 s
 *
 * against the `trivy-db` job (ci.yml): checkout 2 min + setup-trivy 3 min +
 * this step 7 min (420 s >= 400 s) + cache save 3 min = 15 min = its
 * `timeout-minutes`. Every one of those steps carries its own
 * `timeout-minutes`, so none can borrow another's share.
 */
export const BUDGET = Object.freeze({
  repositoryWindowMs: 180_000,
  /** One `--download-db-only`; a normal download takes 5-20 s. */
  attemptMs: 120_000,
  /** One canary scan; it takes well under a second. */
  canaryMs: 60_000,
  killGraceMs: 5_000,
  /** An attempt is not started with less than this left in its window. */
  minAttemptMs: 20_000,
  /**
   * Not a limit but an allowance: the in-process checks (reader, sha256) of
   * one copy, which may start just before a window closes. Measured: 76 ms
   * for the reader and up to 8 s per sha256 of the 1.6 GB DB, twice per copy.
   */
  validationSlopMs: 20_000,
});

/**
 * Oldest `UpdatedAt` a scan may use (inclusive). Aquasec publishes every 6
 * hours and stamps `NextUpdate` exactly 24 h after `UpdatedAt`; Trivy's own
 * online mode treats the DB as current until that moment. The same 24 h on
 * `UpdatedAt` therefore keeps the offline gate as strict as the online one,
 * and still tolerates a missed publish or two. In nanoseconds, because Trivy
 * writes nanosecond timestamps and the bound is exact.
 */
export const MAX_AGE_NS = 24n * 3600n * 1_000_000_000n;
/** A timestamp more than this ahead of the runner's clock is a clock error or a forgery. */
export const MAX_FUTURE_SKEW_NS = 5n * 60n * 1_000_000_000n;
export const SCHEMA_VERSION = 2;
/** Provenance file written beside `db/`, so a consumer can prove where its copy came from. */
export const SOURCE_FILE = 'ci-trivy-db-source.json';

/**
 * What a scan of this repository's images needs from the DB (F1/A of the
 * review). Trivy in skip mode opens any bbolt file and, when these are
 * missing or empty, reports nothing and exits 0: a hollow DB is a green scan
 * that protects nothing (shown with trivy 0.70.0, PR #435 round 2). So each of
 * these must exist AND be non-empty:
 *  - `vulnerability`: details, including the severity the CRITICAL,HIGH
 *    filter reads; without it every finding is UNKNOWN and filtered out;
 *  - `data-source`: which feed each advisory bucket came from;
 *  - the npm advisories (every service image ships node_modules);
 *  - an Alpine release (every image, the ClamAV one included, is Alpine:
 *    `Detected OS family="alpine"` in all 18 scan logs).
 */
export const REQUIRED_BUCKETS = Object.freeze([
  'vulnerability',
  'data-source',
  'npm::GitHub Security Advisory npm',
]);
export const REQUIRED_BUCKET_FAMILIES = Object.freeze([
  Object.freeze({ label: 'alpine <major>.<minor>', pattern: /^alpine \d+\.\d+$/ }),
]);
/**
 * Before publishing, the producer makes Trivy itself scan a lockfile with a
 * long-known vulnerable package against the downloaded DB: the DB must open
 * in Trivy, find the advisory and resolve its severity into the gate's set.
 * Consumers then accept only the exact bytes that passed (sha256 in the
 * provenance), which is what makes the canary cover them too.
 */
export const CANARY = Object.freeze({
  pkg: 'lodash',
  version: '4.17.20',
  vulnerability: 'CVE-2021-23337',
  severities: Object.freeze(['HIGH', 'CRITICAL']),
});
const CANARY_LOCKFILE = {
  name: 'ci-trivy-db-canary',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': {
      name: 'ci-trivy-db-canary',
      version: '1.0.0',
      dependencies: { [CANARY.pkg]: CANARY.version },
    },
    [`node_modules/${CANARY.pkg}`]: {
      version: CANARY.version,
      resolved: `https://registry.npmjs.org/${CANARY.pkg}/-/${CANARY.pkg}-${CANARY.version}.tgz`,
    },
  },
};

// --- instants ----------------------------------------------------------------

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Strict RFC 3339 instant -> epoch nanoseconds (BigInt), or null. Calendar
 * fields must round-trip (2026-02-30 is not silently March 2nd, 24:00 is not
 * the next day), the offset is applied exactly, and up to nine fraction
 * digits are kept: `...01:20:33.190884269Z` and `...06:50:33.190884269+05:30`
 * are the same instant.
 */
export function parseInstant(text) {
  if (typeof text !== 'string') return null;
  const m = RFC3339.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, 0);
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getUTCSeconds() !== s
  ) {
    return null;
  }
  let offsetMinutes = 0;
  if (m[8]) {
    const oh = Number(m[9]);
    const om = Number(m[10]);
    if (oh > 23 || om > 59) return null;
    offsetMinutes = (m[8] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const fraction = BigInt((m[7] ?? '').padEnd(9, '0'));
  return (
    BigInt(date.getTime()) * 1_000_000n + fraction - BigInt(offsetMinutes) * 60n * 1_000_000_000n
  );
}

/** The runner's clock in epoch nanoseconds, or null when it is not a real instant. */
function clockNs(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null;
  return BigInt(now.getTime()) * 1_000_000n;
}

// --- run identity --------------------------------------------------------------

const POSITIVE = /^[1-9]\d{0,19}$/;
const KEY = /^trivy-db-([1-9]\d{0,19})-([1-9]\d{0,19})$/;

/** The key (artifact name) the producer of run `run.id`, attempt `run.attempt` publishes under. */
export function producerKey(run) {
  if (!POSITIVE.test(String(run?.id ?? '')) || !POSITIVE.test(String(run?.attempt ?? ''))) {
    return null;
  }
  return `trivy-db-${run.id}-${run.attempt}`;
}

/**
 * The producer a consumer must accept, derived from the key it was handed
 * (needs.trivy-db.outputs.key), never from its own attempt number: after
 * "Re-run failed jobs" a consumer on attempt 2 legitimately restores the copy
 * producer attempt 1 published.
 */
export function expectedProducer(key, run) {
  const m = KEY.exec(typeof key === 'string' ? key : '');
  // Refused by name: an unmatched key is never repeated (scripts/cli-contract.mjs).
  if (!m) return { ok: false, reason: 'the producer key is not trivy-db-<run>-<attempt>' };
  if (!POSITIVE.test(String(run?.id ?? '')) || !POSITIVE.test(String(run?.attempt ?? ''))) {
    return { ok: false, reason: 'this job does not know its own run id and attempt' };
  }
  const [, runId, runAttempt] = m;
  if (runId !== String(run.id)) {
    return {
      ok: false,
      reason: `producer key ${key} belongs to run ${runId}, this is run ${run.id}`,
    };
  }
  if (BigInt(runAttempt) > BigInt(run.attempt)) {
    return {
      ok: false,
      reason: `producer key ${key} names attempt ${runAttempt}, later than this job's attempt ${run.attempt}`,
    };
  }
  return { ok: true, key, runId, runAttempt };
}

// --- bbolt ---------------------------------------------------------------------

const BOLT_MAGIC = 0xed0cdaed;
const BOLT_VERSION = 2;
const PAGE_HEADER = 16;
const BRANCH_PAGE = 0x01;
const LEAF_PAGE = 0x02;
const META_PAGE = 0x04;
const BUCKET_LEAF = 0x01;
const NO_FREELIST = 0xffffffffffffffffn;
const MAX_PAGES_VISITED = 65_536;
const MAX_DEPTH = 32;

function fnv1a64(bytes) {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  return h;
}

/** One bbolt meta page (go.etcd.io/bbolt internal/common/meta.go): fields, then problems. */
function readMeta(page, expectedId) {
  if (page.length < PAGE_HEADER + 64) return { problem: 'is truncated' };
  const at = PAGE_HEADER;
  const meta = {
    id: page.readBigUInt64LE(0),
    flags: page.readUInt16LE(8),
    magic: page.readUInt32LE(at),
    version: page.readUInt32LE(at + 4),
    pageSize: page.readUInt32LE(at + 8),
    root: page.readBigUInt64LE(at + 16),
    freelist: page.readBigUInt64LE(at + 32),
    pgid: page.readBigUInt64LE(at + 40),
    txid: page.readBigUInt64LE(at + 48),
    checksum: page.readBigUInt64LE(at + 56),
  };
  const ps = meta.pageSize;
  if (meta.magic !== BOLT_MAGIC) meta.problem = 'has no bbolt magic';
  else if (meta.version !== BOLT_VERSION)
    meta.problem = `has version ${meta.version}, expected ${BOLT_VERSION}`;
  else if (ps < 1024 || ps > 65536 || (ps & (ps - 1)) !== 0) meta.problem = `has page size ${ps}`;
  else if (meta.id !== BigInt(expectedId) || (meta.flags & META_PAGE) === 0)
    meta.problem = 'is not a meta page';
  else if (fnv1a64(page.subarray(at, at + 56)) !== meta.checksum)
    meta.problem = 'fails its checksum';
  return meta;
}

/**
 * Opens a bbolt file the way bbolt does, but strictly (a freshly published,
 * closed DB has two valid meta pages), and lists the top-level buckets with
 * their entry counts. Reads only the pages it needs, so a 1.6 GB DB takes
 * milliseconds. Problems are returned, never thrown, and never name the
 * path (a refusal does not repeat what the operator passed).
 * @returns {{ok: true, buckets: Map<string, number>} | {ok: false, reason: string}}
 */
export function inspectBolt(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    return { ok: false, reason: `cannot open it (${e.code ?? 'error'})` };
  }
  const fail = (reason) => ({ ok: false, reason });
  try {
    const size = BigInt(fstatSync(fd).size);
    const read = (offset, length) => {
      const buf = Buffer.alloc(length);
      const n = readSync(fd, buf, 0, length, Number(offset));
      return buf.subarray(0, n);
    };
    const meta0 = readMeta(read(0, PAGE_HEADER + 64), 0);
    if (meta0.problem) return fail(`meta page 0 ${meta0.problem}`);
    const ps = BigInt(meta0.pageSize);
    const meta1 = readMeta(read(ps, PAGE_HEADER + 64), 1);
    if (meta1.problem) return fail(`meta page 1 ${meta1.problem}`);
    if (meta1.pageSize !== meta0.pageSize) return fail('meta pages disagree on the page size');
    const meta = meta1.txid > meta0.txid ? meta1 : meta0;
    if (meta.pgid < 3n || size < meta.pgid * ps) {
      return fail(`is truncated: ${size} bytes, its meta page needs ${meta.pgid} pages of ${ps}`);
    }
    if (meta.root < 2n || meta.root >= meta.pgid)
      return fail(`root page ${meta.root} is out of range`);
    if (meta.freelist !== NO_FREELIST && (meta.freelist < 2n || meta.freelist >= meta.pgid)) {
      return fail(`freelist page ${meta.freelist} is out of range`);
    }

    let visited = 0;
    const seen = new Set();
    const readPage = (id) => {
      if (id < 2n || id >= meta.pgid) return { problem: `page ${id} is out of range` };
      if (seen.has(id)) return { problem: `page ${id} is referenced twice` };
      seen.add(id);
      if (++visited > MAX_PAGES_VISITED) return { problem: 'has too many top-level pages' };
      const header = read(id * ps, PAGE_HEADER);
      if (header.length < PAGE_HEADER) return { problem: `page ${id} is truncated` };
      const overflow = BigInt(header.readUInt32LE(12));
      if (id + overflow >= meta.pgid) return { problem: `page ${id} overflows the file` };
      return parsePage(read(id * ps, Number((overflow + 1n) * ps)), id);
    };
    const parsePage = (buf, id) => {
      if (buf.length < PAGE_HEADER) return { problem: `page ${id} is truncated` };
      if (id !== undefined && buf.readBigUInt64LE(0) !== id) {
        return { problem: `page ${id} carries id ${buf.readBigUInt64LE(0)}` };
      }
      const flags = buf.readUInt16LE(8);
      const count = buf.readUInt16LE(10);
      if (flags !== BRANCH_PAGE && flags !== LEAF_PAGE) {
        return { problem: `page ${id ?? '(inline)'} has flags ${flags}, not a branch or leaf` };
      }
      if (PAGE_HEADER + count * 16 > buf.length) {
        return { problem: `page ${id ?? '(inline)'} has more elements than fit` };
      }
      return { buf, flags, count };
    };
    const element = (page, i) => {
      const at = PAGE_HEADER + i * 16;
      const b = page.buf;
      if (page.flags === BRANCH_PAGE) {
        const pos = b.readUInt32LE(at);
        const ksize = b.readUInt32LE(at + 4);
        if (at + pos + ksize > b.length) return { problem: 'a branch element overruns its page' };
        return { child: b.readBigUInt64LE(at + 8) };
      }
      const flags = b.readUInt32LE(at);
      const pos = b.readUInt32LE(at + 4);
      const ksize = b.readUInt32LE(at + 8);
      const vsize = b.readUInt32LE(at + 12);
      if (at + pos + ksize + vsize > b.length)
        return { problem: 'a leaf element overruns its page' };
      return {
        flags,
        key: b.toString('utf8', at + pos, at + pos + ksize),
        value: b.subarray(at + pos + ksize, at + pos + ksize + vsize),
      };
    };

    const entries = [];
    const walk = (id, depth) => {
      if (depth > MAX_DEPTH) return 'the root bucket is nested too deep';
      const page = readPage(id);
      if (page.problem) return page.problem;
      for (let i = 0; i < page.count; i++) {
        const el = element(page, i);
        if (el.problem) return `page ${id}: ${el.problem}`;
        if (page.flags === BRANCH_PAGE) {
          const problem = walk(el.child, depth + 1);
          if (problem) return problem;
        } else {
          entries.push(el);
        }
      }
      return null;
    };
    const problem = walk(meta.root, 0);
    if (problem) return fail(problem);

    const buckets = new Map();
    for (const el of entries) {
      if ((el.flags & BUCKET_LEAF) === 0 || el.value.length < 16) {
        return fail(`top-level key ${JSON.stringify(el.key)} is not a bucket`);
      }
      const root = el.value.readBigUInt64LE(0);
      const page = root === 0n ? parsePage(el.value.subarray(16), undefined) : readPage(root);
      if (page.problem) return fail(`bucket ${JSON.stringify(el.key)}: ${page.problem}`);
      buckets.set(el.key, page.count);
    }
    return { ok: true, buckets };
  } finally {
    closeSync(fd);
  }
}

// --- the acceptance boundary ---------------------------------------------------------

function sha256File(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(8 << 20);
    let n;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

const DIGESTED = Object.freeze(['trivy.db', 'metadata.json']);

/**
 * The metadata Trivy needs (pkg/db/metadata.go): schema Version, the
 * publisher's UpdatedAt and NextUpdate, and the DownloadedAt Trivy itself
 * writes when a download completes.
 */
function checkMetadata(meta, nowNs) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return { problem: 'is not a JSON object' };
  }
  if (meta.Version !== SCHEMA_VERSION) {
    return { problem: `Version is ${JSON.stringify(meta.Version)}, expected ${SCHEMA_VERSION}` };
  }
  const at = {};
  for (const field of ['UpdatedAt', 'NextUpdate', 'DownloadedAt']) {
    at[field] = parseInstant(meta[field]);
    if (at[field] === null) {
      return {
        problem: `${field} is missing or not a valid RFC 3339 instant: ${JSON.stringify(meta[field])}`,
      };
    }
  }
  if (at.NextUpdate <= at.UpdatedAt) {
    return { problem: `NextUpdate ${meta.NextUpdate} is not after UpdatedAt ${meta.UpdatedAt}` };
  }
  for (const field of ['UpdatedAt', 'DownloadedAt']) {
    if (at[field] - nowNs > MAX_FUTURE_SKEW_NS) {
      return { problem: `${field} ${meta[field]} is in the future`, future: true };
    }
  }
  return { updatedNs: at.UpdatedAt };
}

/**
 * The copy itself, before anyone vouches for it: metadata, age, bbolt
 * structure and the buckets a scan needs.
 * @returns {{ok: true, updatedAt: string, ageHours: number, buckets: number} | {ok: false, reason: string}}
 */
function checkContent(cacheDir, now, nowNs) {
  const fail = (reason) => ({ ok: false, reason });
  const dbDir = join(cacheDir, 'db');
  const metaPath = join(dbDir, 'metadata.json');
  const dbPath = join(dbDir, 'trivy.db');
  if (!existsSync(metaPath)) return fail(`missing db/metadata.json`);
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return fail(`db/metadata.json is not valid JSON`);
  }
  const m = checkMetadata(meta, nowNs);
  if (m.problem) return fail(`metadata ${m.problem} (runner clock ${now.toISOString()})`);
  const ageNs = nowNs - m.updatedNs;
  const ageHours = Number(ageNs / 1_000_000n) / 3_600_000;
  if (ageNs > MAX_AGE_NS) {
    return fail(
      `vulnerability DB is stale: UpdatedAt ${meta.UpdatedAt} is ${ageHours.toFixed(1)} h old, limit 24 h`,
    );
  }

  if (!existsSync(dbPath)) return fail(`missing db/trivy.db`);
  const bolt = inspectBolt(dbPath);
  if (!bolt.ok) return fail(`db/trivy.db: ${bolt.reason} (not a usable bbolt database)`);
  for (const name of REQUIRED_BUCKETS) {
    if (!bolt.buckets.has(name)) return fail(`db/trivy.db has no bucket "${name}"`);
    if (bolt.buckets.get(name) === 0) return fail(`db/trivy.db has an empty bucket "${name}"`);
  }
  for (const family of REQUIRED_BUCKET_FAMILIES) {
    if (![...bolt.buckets].some(([name, count]) => family.pattern.test(name) && count > 0)) {
      return fail(`db/trivy.db has no non-empty "${family.label}" bucket`);
    }
  }
  return { ok: true, updatedAt: meta.UpdatedAt, ageHours, buckets: bolt.buckets.size };
}

/**
 * Accepts a Trivy cache directory only if every part of it is what the
 * producer named by `key` validated: metadata, age, bbolt structure, the
 * buckets a scan needs, provenance from an allowed repository, and the exact
 * bytes (sha256). Anything unknown, unreadable or missing is a refusal.
 * @param {string} cacheDir
 * @param {{now: Date, key: string, run: {id: string, attempt: string}}} ctx
 *   `now` the runner's clock; `key` the producer's key; `run` this
 *   job's GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT.
 * @returns {{ok: true, updatedAt: string, ageHours: number, buckets: number, source: object}
 *   | {ok: false, reason: string}}
 */
export function checkDb(cacheDir, { now, key, run } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  const nowNs = clockNs(now);
  if (nowNs === null) return fail(`the runner clock is not a valid instant: ${String(now)}`);
  const producer = expectedProducer(key, run);
  if (!producer.ok) return fail(producer.reason);
  const content = checkContent(cacheDir, now, nowNs);
  if (!content.ok) return content;

  const sourcePath = join(cacheDir, SOURCE_FILE);
  if (!existsSync(sourcePath)) {
    return fail(`missing ${SOURCE_FILE}: this DB was not produced by the shared download`);
  }
  let source;
  try {
    source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  } catch {
    return fail(`${SOURCE_FILE} is not valid JSON`);
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return fail(`${SOURCE_FILE} is not a JSON object`);
  }
  if (
    source.key !== producer.key ||
    source.runId !== producer.runId ||
    source.runAttempt !== producer.runAttempt
  ) {
    return fail(
      `DB was published as ${JSON.stringify(source.key)} by run ${source.runId} attempt ${source.runAttempt}, expected ${producer.key}`,
    );
  }
  if (!REPOSITORIES.includes(source.repository)) {
    return fail(
      `DB names repository ${JSON.stringify(source.repository)}, not one of ${REPOSITORIES.join(', ')}`,
    );
  }
  for (const file of DIGESTED) {
    const want = source.sha256?.[file];
    if (typeof want !== 'string' || !/^[0-9a-f]{64}$/.test(want)) {
      return fail(`${SOURCE_FILE} carries no sha256 for ${file}`);
    }
    if (sha256File(join(cacheDir, 'db', file)) !== want) {
      return fail(`db/${file} is not the copy the producer validated (sha256 differs)`);
    }
  }
  return { ...content, source };
}

// --- the producer ------------------------------------------------------------------

/**
 * Runs a child with a hard deadline: SIGTERM to its process group at
 * `limitMs - graceMs`, SIGKILL at `limitMs`, and the promise settles by
 * `limitMs + graceMs` even if the child is unkillable.
 */
export function runBounded(command, args, { limitMs, graceMs, env, capture = false }) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const chunks = [];
    const timers = [];
    const settle = (result) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      resolve({ ...result, timedOut, stdout: Buffer.concat(chunks).toString('utf8') });
    };
    let child;
    try {
      child = spawn(command, args, {
        detached: true,
        env,
        stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
      });
    } catch (error) {
      settle({ error });
      return;
    }
    const signal = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    if (capture) child.stdout.on('data', (b) => chunks.push(b));
    timers.push(
      setTimeout(
        () => {
          timedOut = true;
          signal('SIGTERM');
        },
        Math.max(0, limitMs - graceMs),
      ),
      setTimeout(() => signal('SIGKILL'), limitMs),
      setTimeout(() => settle({ status: null, signal: 'SIGKILL' }), limitMs + graceMs),
    );
    child.on('error', (error) => settle({ error }));
    child.on('close', (status, sig) => settle({ status, signal: sig }));
  });
}

const describe = (cmd, r) =>
  r.error
    ? `could not run ${cmd}: ${r.error.message}`
    : r.timedOut
      ? `${cmd} did not finish within its deadline and was killed`
      : r.status !== 0
        ? `${cmd} exited ${r.status ?? r.signal}`
        : null;

const trivyTimeout = (limitMs, graceMs) =>
  `${Math.max(1, Math.floor((limitMs - 2 * graceMs) / 1000))}s`;

/** Trivy scans the canary lockfile against `cacheDir`; null when it found what it must. */
async function canaryScan(trivy, cacheDir, { limitMs, graceMs, env }) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-trivy-db-canary-'));
  try {
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(CANARY_LOCKFILE));
    const r = await runBounded(
      trivy,
      [
        'fs',
        '--cache-dir',
        cacheDir,
        '--cache-backend',
        'memory',
        '--skip-db-update',
        '--skip-java-db-update',
        '--offline-scan',
        '--scanners',
        'vuln',
        '--format',
        'json',
        '--quiet',
        '--timeout',
        trivyTimeout(limitMs, graceMs),
        dir,
      ],
      { limitMs, graceMs, env, capture: true },
    );
    const problem = describe('the canary scan', r);
    if (problem) return problem;
    let report;
    try {
      report = JSON.parse(r.stdout);
    } catch {
      return 'the canary scan printed no JSON report';
    }
    const found = (report?.Results ?? [])
      .flatMap((x) => x?.Vulnerabilities ?? [])
      .find((v) => v?.VulnerabilityID === CANARY.vulnerability && v?.PkgName === CANARY.pkg);
    if (!found) {
      return `Trivy found no ${CANARY.vulnerability} in ${CANARY.pkg} ${CANARY.version} with this DB`;
    }
    if (!CANARY.severities.includes(found.Severity)) {
      return `Trivy rates ${CANARY.vulnerability} ${JSON.stringify(found.Severity)} with this DB, expected ${CANARY.severities.join(' or ')}`;
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Downloads the DB, repository by repository, attempt by attempt, until one
 * copy downloads, passes the canary and passes `checkDb` (a mirror serving a
 * stale, hollow or damaged copy is a failed attempt, so the next attempt or
 * repository gets its turn). Each repository has its own time window.
 * @param {string} cacheDir dedicated directory; emptied before every attempt
 * @param {{run: {id: string, attempt: string}}} opts the producer's run; the
 *   rest (trivy, repositories, backoffMs, budget, now, log, env) default to
 *   the production policy and exist for tests.
 * @returns {Promise<{ok: true, key: string, repository: string, check: object} | {ok: false, reason: string}>}
 */
export async function fetchDb(cacheDir, opts) {
  const {
    run,
    trivy = 'trivy',
    repositories = REPOSITORIES,
    backoffMs = BACKOFF_MS,
    budget = BUDGET,
    now = () => new Date(),
    log = (line) => process.stderr.write(`${line}\n`),
    env = process.env,
  } = opts;
  const key = producerKey(run);
  if (key === null)
    return { ok: false, reason: 'the producer does not know its run id and attempt' };
  const attempts = backoffMs.length + 1;
  const failures = [];
  const reset = () => {
    // Nothing from a previous attempt may be mistaken for this one's result.
    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });
  };
  for (const repository of repositories) {
    const windowEnd = performance.now() + budget.repositoryWindowMs;
    const left = () => windowEnd - performance.now();
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const label = `${repository} attempt ${attempt}/${attempts}`;
      if (attempt > 1) {
        const wait = backoffMs[attempt - 2];
        if (left() - wait < budget.minAttemptMs) {
          failures.push(
            `${label}: not started, ${Math.round(left() / 1000)} s left in this repository's window`,
          );
          log(`::warning::trivy-db: ${failures.at(-1)}`);
          break;
        }
        await delay(wait);
      }
      reset();
      const limitMs = Math.min(budget.attemptMs, left());
      const download = await runBounded(
        trivy,
        [
          'image',
          '--download-db-only',
          '--no-progress',
          '--db-repository',
          repository,
          '--cache-dir',
          cacheDir,
          '--timeout',
          trivyTimeout(limitMs, budget.killGraceMs),
        ],
        { limitMs, graceMs: budget.killGraceMs, env },
      );
      let problem = describe(trivy, download);
      if (problem === null) {
        // The copy itself first (cheap: a stale or hollow copy costs no canary),
        // then Trivy's canary, then the provenance that vouches for exactly
        // these bytes, then the same full check every consumer runs.
        const now0 = now();
        const nowNs = clockNs(now0);
        const content =
          nowNs === null
            ? { ok: false, reason: `the runner clock is not a valid instant: ${String(now0)}` }
            : checkContent(cacheDir, now0, nowNs);
        if (!content.ok) problem = `downloaded copy rejected: ${content.reason}`;
      }
      if (problem === null) {
        const canary = await canaryScan(trivy, cacheDir, {
          limitMs: Math.max(1_000, Math.min(budget.canaryMs, left())),
          graceMs: budget.killGraceMs,
          env,
        });
        if (canary !== null) problem = `downloaded copy rejected: ${canary}`;
      }
      if (problem === null) {
        writeFileSync(
          join(cacheDir, SOURCE_FILE),
          `${JSON.stringify({
            key,
            repository,
            runId: String(run.id),
            runAttempt: String(run.attempt),
            attempt,
            fetchedAt: now().toISOString(),
            sha256: Object.fromEntries(
              DIGESTED.map((file) => [file, sha256File(join(cacheDir, 'db', file))]),
            ),
          })}\n`,
        );
        const check = checkDb(cacheDir, { now: now(), key, run });
        if (check.ok) {
          log(
            `trivy-db: ${label} ok (UpdatedAt ${check.updatedAt}, canary ${CANARY.vulnerability} found)`,
          );
          return { ok: true, key, repository, check };
        }
        problem = `downloaded copy rejected: ${check.reason}`;
      }
      failures.push(`${label}: ${problem}`);
      log(`::warning::trivy-db: ${failures.at(-1)}`);
      if (left() < budget.minAttemptMs) break;
    }
  }
  rmSync(cacheDir, { recursive: true, force: true });
  return { ok: false, reason: `no repository yielded a usable DB:\n  ${failures.join('\n  ')}` };
}
