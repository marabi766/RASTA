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
 * never age or content, so `checkDb` is the shared admission gate,
 * used by the producer before it publishes and by every consumer
 * before it scans. The producer also runs the official bbolt v1.4.3
 * Tx.Check on EACH download attempt before sealing. Consumers keep their
 * current checks. The copy travels as one archive; `packDb` writes it and
 * `unpackDb` is the one boundary that admits it (PR #435 round 3).
 *
 * This module reads no environment and has no defaults that loosen anything:
 * every input (clock, run identity, key) is a parameter, and the defaults ARE
 * the production policy. Tests inject through these parameters, and the ones
 * a consumer's check takes (a deadline) can only tighten it; the CLI
 * (ci-trivy-db.mjs) passes only the run identity and the producer's key.
 * Threat model (D-076): (1) transit/storage corruption after sealing is
 * detected by every consumer's sha256. (2) Broken/truncated upstream bytes
 * face structural sanity, official bbolt consistency checking and sampled
 * per-ecosystem canaries, including a real Trivy lookup scan. (3a) Producer
 * compromise is out of scope. (3b) Malicious or subtly wrong upstream bytes
 * that pass those checks remain a residual risk: an uncompromised producer
 * hashes whatever passed. Trust ends at the OCI artifact resolved by Trivy
 * from mirror.gcr.io/aquasec/trivy-db:2, then ghcr.io/aquasecurity/trivy-db:2.
 * The manifest/layer digests come from that registry's tag resolution; we
 * neither pin an upstream digest nor verify a signature/attestation. The
 * upstream trivy-db cron workflow publishes via oras push and declares no
 * signing/attestation step (reviewed 2026-10-27); Trivy binary/image signing
 * is separate and supplies no DB authenticity proof here.
 *
 * Node built-ins only (plus `zstd`, `trivy` and `trivy-db-check` as children), so it runs
 * before Trivy is installed and in the producer's sparse checkout.
 *
 * Refusals are fixed texts: they never repeat a path, an archive member's
 * name, a key or value from the DB, a page id or a size read from a file
 * (scripts/cli-contract.mjs).
 *
 * The scan itself (severity, exit code, ignore-unfixed, ignore files, images)
 * is not touched.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
 * Time limits, all enforced (F3 of the PR #435 r1 review; addendum A of r3).
 * Each repository owns a fixed window that the previous one cannot spend,
 * every child process is killed at its deadline (SIGTERM to its process
 * group, then SIGKILL `killGraceMs` later, even when the leader already
 * exited), and the in-process checks of a copy stop at their own deadline:
 *
 *   fetch <= 2 x (165 s window + 120 s validation + 5 s cleanup) = 580 s
 *
 * against the `trivy-db` job (ci.yml): checkout 1 min + setup-go 1 min +
 * build/checker controls 2 min + setup-trivy 2 min + fetch 10 min
 * (600 s >= 580 s) + pack 2 min + upload 2 min = 20 min = its
 * `timeout-minutes`. Every one of those steps carries its own
 * `timeout-minutes`, so none can borrow another's share.
 *
 * Measured on this host with the real DB (1.64 GB of 2026-10-25, 397 943
 * pages, 7.4 million elements): the full bbolt walk 3.3-3.8 s, one sha256
 * 6.7 s, the canary scan 0.23 s; one consumer check 9.4-10.1 s (limit 60 s),
 * round-3 validation 22.4 s (now limit 120 s), pack 2.7-3.1 s and unpack
 * 4.2-5.0 s (limits 90 s and 120 s). The runner hashed faster than this host
 * on run 40197545703 (a whole check, sha256 included, in 3.5 s).
 * Round 4: official check 74.4 s / 1.45 GB peak on that saved DB (cold),
 * 1.9 s on the fresh 1.64 GB DB of 2026-10-27; whole fresh fetch 31.9 s.
 */
export const BUDGET = Object.freeze({
  repositoryWindowMs: 165_000,
  /** One `--download-db-only`; a normal download takes 5-20 s. */
  attemptMs: 120_000,
  /** One canary scan (measured 0.23 s). */
  canaryMs: 30_000,
  /** Official bbolt check, inside the same validation deadline. */
  officialCheckMs: 90_000,
  killGraceMs: 5_000,
  /** An attempt is not started with less than this left in its window. */
  minAttemptMs: 20_000,
  /** All validation of one copy, official checker and canaries included. */
  validationMs: 120_000,
  /** One `checkDb` in a consumer: the walk and both sha256 (measured 9.4-10.1 s). */
  checkMs: 60_000,
  /** `packDb` (measured 2.7-3.1 s) and `unpackDb` (4.2-5.0 s), compressor included. */
  packMs: 90_000,
  unpackMs: 120_000,
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
 * The Alpine release of every image the scans read, by base image (all 18
 * scan logs of run 40197545703: `Detected OS family="alpine"
 * version="3.24.2"`). A test reads every service Dockerfile and the ClamAV
 * pin in ci.yml and fails when a base is not listed here, so a base bump
 * cannot leave the DB check guarding a release nobody scans.
 */
export const SCANNED_BASES = Object.freeze({
  'node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402': '3.24',
  'clamav/clamav:1.5.4@sha256:bda39705e291105049c3936e2803ac90b955172af8030f94f05dce1252df6c6d':
    '3.24',
});
export const ALPINE_RELEASES = Object.freeze([...new Set(Object.values(SCANNED_BASES))].sort());

/** A HIGH or CRITICAL advisory Trivy must find; the gate's severities. */
const GATE_SEVERITIES = Object.freeze(['HIGH', 'CRITICAL']);
/**
 * The advisory sources the scans read, one per ecosystem the 18 images
 * contain (same logs: `[alpine]` in all 18, `[node-pkg]` in the 17 service
 * images, `[cargo]` in marketplace-service, from
 * @temporalio/core-bridge/Cargo.lock), each with a canary: a long-known
 * advisory Trivy reports at HIGH or CRITICAL for `version`.
 * F1/A of the review: Trivy in skip mode opens any bbolt file and, when
 * these are missing or empty, reports nothing and exits 0; a hollow DB is a
 * green scan that protects nothing (shown with trivy 0.70.0, round 2).
 */
export const ECOSYSTEMS = Object.freeze([
  ...ALPINE_RELEASES.map((release) =>
    Object.freeze({
      bucket: `alpine ${release}`,
      type: 'alpine',
      release,
      canary: Object.freeze({ pkg: 'zlib', version: '1.2.12-r0', id: 'CVE-2022-37434' }),
    }),
  ),
  Object.freeze({
    bucket: 'npm::GitHub Security Advisory npm',
    type: 'node-pkg',
    canary: Object.freeze({ pkg: 'lodash', version: '4.17.20', id: 'CVE-2021-23337' }),
  }),
  Object.freeze({
    bucket: 'cargo::GitHub Security Advisory Rust',
    type: 'cargo',
    canary: Object.freeze({ pkg: 'tokio', version: '1.8.0', id: 'CVE-2021-45710' }),
  }),
]);
/**
 * Every bucket a scan needs, each present and non-empty: `vulnerability`
 * (details, including the severity the CRITICAL,HIGH filter reads; without
 * it every finding is UNKNOWN and filtered out), `data-source` (which feed
 * each advisory bucket came from) and the advisory bucket of each ecosystem,
 * in which no package bucket may be empty either.
 */
export const REQUIRED_BUCKETS = Object.freeze([
  'vulnerability',
  'data-source',
  ...ECOSYSTEMS.map((e) => e.bucket),
]);

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
const ELEMENT = 16;
const BUCKET_HEADER = 16;
const BRANCH_PAGE = 0x01;
const LEAF_PAGE = 0x02;
const META_PAGE = 0x04;
const FREELIST_PAGE = 0x10;
const BUCKET_LEAF = 0x01;
const NO_FREELIST = 0xffffffffffffffffn;

/**
 * Bounds of the bbolt walk (F1 of the PR #435 round-2 review, addendum D):
 * the walk visits every reachable page, so each bound is set against the
 * real DB with margin. Measured on the real DB (UpdatedAt
 * 2026-10-25T01:20:33Z, 1.63 GB, 397 943 pages): see the values below.
 */
export const BOLT_LIMITS = Object.freeze({
  /** trivy.db itself (real: 1.63 GB). */
  fileBytes: 4 * 1024 ** 3,
  /** One page with its overflow pages, the largest single allocation (real: 64 KiB). */
  pageSpanBytes: 8 * 1024 ** 2,
  /** Branch levels within one bucket (real: 3). */
  treeDepth: 12,
  /** Buckets within buckets, the root's children at 1 (real: 2). */
  bucketNesting: 4,
  /** Keys and values, inline buckets included (real: 4.6 million). */
  elements: 40_000_000,
  /** A value the content check reads (a canary advisory). */
  foundValueBytes: 64 * 1024,
});

/** A refusal with a fixed text: never a name, a key, a page id or a size from the file. */
class Refusal extends Error {}
const refuse = (text) => {
  throw new Refusal(text);
};
/** An error's code when it is a plain system code (EIO, ENOENT), else a fixed word. */
const errorCode = (e) =>
  typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(e.code)
    ? e.code
    : e instanceof RangeError
      ? 'out of range'
      : 'error';

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
  else if (meta.version !== BOLT_VERSION) meta.problem = `is not format version ${BOLT_VERSION}`;
  else if (ps < 1024 || ps > 65536 || (ps & (ps - 1)) !== 0)
    meta.problem = 'has an invalid page size';
  else if (meta.id !== BigInt(expectedId) || (meta.flags & META_PAGE) === 0)
    meta.problem = 'is not a meta page';
  else if (fnv1a64(page.subarray(at, at + 56)) !== meta.checksum)
    meta.problem = 'fails its checksum';
  return meta;
}

/**
 * Opens a bbolt file the way bbolt does, but strictly (a freshly published,
 * closed DB has two valid meta pages), and walks all reachable records
 * (structural sanity, NOT a full bbolt verifier: branch separators are not
 * checked against child key ranges; the producer's official checker does
 * that). Round 2 read only the first page of each top-level
 * bucket, so a corrupt nested page, inline bucket or branch child passed:
 *  - every page reachable from the root bucket, through branch pages, leaf
 *    pages, nested buckets and inline buckets, in range, carrying its own id,
 *    a branch or leaf page (an inline bucket: a leaf page with id 0 and no
 *    sub-buckets, exactly as long as its elements), every element inside its
 *    page and after the element table, keys non-empty and strictly ascending
 *    across each bucket, leaf flags 0 or bucket, a bucket header exactly 16
 *    bytes unless inline;
 *  - the freelist page and every page it lists in range;
 *  - every page below the high-water mark owned exactly once: by a meta
 *    page, the freelist, a reachable node or the freelist's list (a page
 *    reachable twice, or reachable and free, or neither, is refused);
 *  - within BOLT_LIMITS and by `deadline` (performance.now() milliseconds).
 * For each top-level bucket it returns the advisories under it (`values`,
 * nested buckets included), its nested buckets and how many of those are
 * empty. `find` names values to return: [top-level, ...nested buckets, key].
 * `limits` may lower any of BOLT_LIMITS, never raise one.
 * Never throws; a problem is a fixed text (refusals do not repeat the file's
 * contents or the path), and an I/O or allocation error is `error: true`.
 * @returns {{ok: true, buckets: Map<string, {values: number, buckets: number, emptyBuckets: number}>, found: Map<string, Buffer>, stats: object}
 *   | {ok: false, reason: string, error?: true}}
 */
export function inspectBolt(path, { deadline = Infinity, find = [], limits = {} } = {}) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    return { ok: false, reason: `cannot be opened (${errorCode(e)})`, error: true };
  }
  try {
    // `limits` can only tighten BOLT_LIMITS (tests drive each bound with it).
    const bounds = Object.fromEntries(
      Object.entries(BOLT_LIMITS).map(([k, v]) => [k, Math.min(v, limits[k] ?? v)]),
    );
    return walkBolt(fd, deadline, find, bounds);
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.message };
    return { ok: false, reason: `could not be read (${errorCode(e)})`, error: true };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // nothing was written; the descriptor is gone either way
    }
  }
}

/** Byte-wise order of a[aAt, aEnd) and b[bAt, bEnd): <0, 0, >0 (a JS loop: keys are short). */
function compareKeys(a, aAt, aEnd, b, bAt, bEnd) {
  const n = Math.min(aEnd - aAt, bEnd - bAt);
  for (let i = 0; i < n; i++) {
    const d = a[aAt + i] - b[bAt + i];
    if (d !== 0) return d;
  }
  return aEnd - aAt - (bEnd - bAt);
}

/** `find` paths -> a tree of Maps; a leaf is the joined path the value is reported under. */
function findTree(find) {
  const root = new Map();
  for (const path of find) {
    let node = root;
    path.forEach((part, i) => {
      if (i === path.length - 1) node.set(part, path.join('/'));
      else {
        if (!(node.get(part) instanceof Map)) node.set(part, new Map());
        node = node.get(part);
      }
    });
  }
  return root;
}

function walkBolt(fd, deadline, find, L) {
  const size = fstatSync(fd).size;
  if (size > L.fileBytes) refuse('is larger than allowed');
  const readExact = (offset, length) => {
    const buf = Buffer.allocUnsafe(length);
    let n = 0;
    while (n < length) {
      const got = readSync(fd, buf, n, length - n, offset + n);
      if (got === 0) break;
      n += got;
    }
    return buf.subarray(0, n);
  };
  const meta0 = readMeta(readExact(0, PAGE_HEADER + 64), 0);
  if (meta0.problem) refuse(`meta page 0 ${meta0.problem}`);
  const ps = meta0.pageSize;
  const meta1 = readMeta(readExact(ps, PAGE_HEADER + 64), 1);
  if (meta1.problem) refuse(`meta page 1 ${meta1.problem}`);
  if (meta1.pageSize !== ps) refuse('meta pages disagree on the page size');
  const meta = meta1.txid > meta0.txid ? meta1 : meta0;
  if (meta.pgid < 3n || BigInt(size) < meta.pgid * BigInt(ps)) {
    refuse('is truncated: shorter than its meta page says');
  }
  const pgid = Number(meta.pgid); // size <= fileBytes, so this is exact
  const pageId = (big) =>
    big >= 2n && big < meta.pgid ? Number(big) : refuse('a page id is out of range');
  const rootId = pageId(meta.root);

  // Reads go through a small block cache (BLOCK bytes per read, at most
  // BLOCKS blocks held): one syscall per page made the walk of the real DB
  // take seconds longer.
  const BLOCK = 256 * 1024;
  const BLOCKS = 128;
  const blocks = new Map();
  const block = (index) => {
    let b = blocks.get(index);
    if (b === undefined) {
      b = readExact(index * BLOCK, BLOCK);
      if (blocks.size >= BLOCKS) blocks.delete(blocks.keys().next().value);
      blocks.set(index, b);
    }
    return b;
  };
  const read = (offset, length) => {
    const index = Math.floor(offset / BLOCK);
    const at = offset - index * BLOCK;
    if (at + length <= BLOCK) {
      const b = block(index);
      return b.subarray(at, Math.min(at + length, b.length));
    }
    return readExact(offset, length);
  };

  // Who owns each page: every page below pgid exactly once.
  const owned = new Uint8Array(pgid);
  owned[0] = owned[1] = 1;
  const own = (id, span) => {
    for (let i = id; i < id + span; i++) {
      if (owned[i]) refuse('a page is referenced twice');
      owned[i] = 1;
    }
  };
  let pages = 0;
  let maxOverflow = 0;
  /** A page with its overflow, owned by the caller. */
  const loadPage = (id) => {
    // The clock is read on the first page and every 256th after it.
    if ((++pages & 0xff) === 1 && performance.now() > deadline) {
      refuse('took longer than its time limit');
    }
    const first = read(id * ps, ps);
    if (first.length < ps) refuse('a page is truncated');
    if (
      first.readUInt32LE(0) !== id % 2 ** 32 ||
      first.readUInt32LE(4) !== Math.floor(id / 2 ** 32)
    ) {
      refuse('a page carries another id');
    }
    const overflow = first.readUInt32LE(12);
    if (id + overflow >= pgid) refuse('a page overflows the file');
    if ((overflow + 1) * ps > L.pageSpanBytes) refuse('a page is larger than allowed');
    own(id, overflow + 1);
    if (overflow > maxOverflow) maxOverflow = overflow;
    if (overflow === 0) return first;
    const all = readExact(id * ps, (overflow + 1) * ps);
    if (all.length < (overflow + 1) * ps) refuse('a page is truncated');
    return all;
  };

  if (meta.freelist !== NO_FREELIST) {
    const page = loadPage(pageId(meta.freelist));
    if (page.readUInt16LE(8) !== FREELIST_PAGE) refuse('the freelist page is not a freelist');
    let count = page.readUInt16LE(10);
    let at = PAGE_HEADER;
    if (count === 0xffff) {
      const big = page.readBigUInt64LE(PAGE_HEADER);
      if (big > BigInt(pgid)) refuse('the freelist lists more pages than exist');
      count = Number(big);
      at += 8;
    }
    if (at + count * 8 > page.length) refuse('the freelist lists more pages than fit');
    for (let i = 0; i < count; i++) own(pageId(page.readBigUInt64LE(at + i * 8)), 1);
  }

  let elements = 0;
  const countElements = (buf, count) => {
    const dataStart = PAGE_HEADER + count * ELEMENT;
    if (dataStart > buf.length) refuse('a page has more elements than fit');
    elements += count;
    if (elements > L.elements) refuse('has more elements than allowed');
    return dataStart;
  };
  /**
   * Calls `onLeaf(buf, flags, keyAt, keyEnd, valueEnd)` for each element of a
   * leaf page, by offset (no per-element objects: the real DB has millions).
   */
  const leafElements = (buf, count, onLeaf) => {
    // bbolt writes each element's key and value right after the previous
    // one's, starting after the element table: no gap, no overlap.
    let next = countElements(buf, count);
    for (let i = 0, at = PAGE_HEADER; i < count; i++, at += ELEMENT) {
      const flags = buf.readUInt32LE(at);
      const keyAt = at + buf.readUInt32LE(at + 4);
      const keyEnd = keyAt + buf.readUInt32LE(at + 8);
      const end = keyEnd + buf.readUInt32LE(at + 12);
      if (keyAt !== next) refuse('a page does not lay its elements out back to back');
      if (keyEnd === keyAt || end > buf.length) refuse('a leaf element overruns its page');
      if (flags !== 0 && flags !== BUCKET_LEAF) refuse('a leaf element has unknown flags');
      onLeaf(buf, flags, keyAt, keyEnd, end);
      next = end;
    }
    return next;
  };

  const found = new Map();
  const tops = new Map();
  let maxTreeDepth = 0;
  let maxNesting = 0;
  let inlineBuckets = 0;
  /** Walks one bucket: `header` is its 16-byte header, followed by the inline page if it has one. */
  const visitBucket = (header, nesting, want) => {
    if (nesting > L.bucketNesting) refuse('buckets are nested too deep');
    if (nesting > maxNesting) maxNesting = nesting;
    if (header.length < BUCKET_HEADER) refuse('a bucket header is truncated');
    const stats = { values: 0, buckets: 0, emptyBuckets: 0 };
    // The previous key of this bucket: keys ascend strictly across all its leaves.
    let lastBuf = null;
    let lastAt = 0;
    let lastEnd = 0;
    const onLeaf = (buf, flags, keyAt, keyEnd, valueEnd) => {
      if (lastBuf !== null && compareKeys(lastBuf, lastAt, lastEnd, buf, keyAt, keyEnd) >= 0) {
        refuse('bucket keys are not in order');
      }
      lastBuf = buf;
      lastAt = keyAt;
      lastEnd = keyEnd;
      const target = want?.get(buf.toString('utf8', keyAt, keyEnd));
      if (flags === BUCKET_LEAF) {
        const sub = visitBucket(
          buf.subarray(keyEnd, valueEnd),
          nesting + 1,
          target instanceof Map ? target : undefined,
        );
        if (nesting === 0) tops.set(buf.toString('utf8', keyAt, keyEnd), sub);
        stats.buckets += 1;
        stats.values += sub.values;
        stats.emptyBuckets += sub.emptyBuckets + (sub.values === 0 && sub.buckets === 0 ? 1 : 0);
        return;
      }
      if (nesting === 0) refuse('the root holds a value, not a bucket');
      stats.values += 1;
      if (typeof target === 'string') {
        if (valueEnd - keyEnd > L.foundValueBytes) refuse('a canary value is larger than allowed');
        found.set(target, Buffer.from(buf.subarray(keyEnd, valueEnd)));
      }
    };
    const root = header.readBigUInt64LE(0);
    if (root === 0n) {
      // Inline (bbolt Bucket.write): a leaf page with id 0 right after the
      // header, never holding a bucket, exactly as long as its elements.
      inlineBuckets += 1;
      const page = header.subarray(BUCKET_HEADER);
      if (page.length < PAGE_HEADER) refuse('an inline bucket is truncated');
      if (page.readBigUInt64LE(0) !== 0n || page.readUInt16LE(8) !== LEAF_PAGE) {
        refuse('an inline bucket is not an inline leaf page');
      }
      if (page.readUInt32LE(12) !== 0) refuse('an inline bucket claims overflow pages');
      const end = leafElements(page, page.readUInt16LE(10), (buf, flags, ...rest) => {
        if (flags !== 0) refuse('an inline bucket holds a bucket');
        onLeaf(buf, flags, ...rest);
      });
      if (end !== page.length) refuse('an inline bucket is not exactly as long as its elements');
      return stats;
    }
    if (header.length !== BUCKET_HEADER) refuse('a bucket header has trailing bytes');
    const walk = (id, depth) => {
      if (depth > L.treeDepth) refuse('a bucket tree is too deep');
      if (depth > maxTreeDepth) maxTreeDepth = depth;
      const buf = loadPage(id);
      const flags = buf.readUInt16LE(8);
      const count = buf.readUInt16LE(10);
      if (flags === LEAF_PAGE) {
        if (count === 0 && depth > 0) refuse('a non-root page is empty');
        leafElements(buf, count, onLeaf);
        return;
      }
      if (flags !== BRANCH_PAGE) refuse('a page is neither a branch nor a leaf');
      if (count === 0) refuse('a non-root page is empty');
      let prevAt = 0;
      let prevEnd = countElements(buf, count);
      for (let i = 0, at = PAGE_HEADER; i < count; i++, at += ELEMENT) {
        const keyAt = at + buf.readUInt32LE(at);
        const keyEnd = keyAt + buf.readUInt32LE(at + 4);
        if (keyAt !== prevEnd) refuse('a page does not lay its elements out back to back');
        if (keyEnd === keyAt || keyEnd > buf.length) refuse('a branch element overruns its page');
        if (i > 0 && compareKeys(buf, prevAt, prevEnd, buf, keyAt, keyEnd) >= 0) {
          refuse('page keys are not in order');
        }
        prevAt = keyAt;
        prevEnd = keyEnd;
        walk(pageId(buf.readBigUInt64LE(at + 8)), depth + 1);
      }
    };
    walk(pageId(root), 0);
    return stats;
  };

  // The root bucket's header lives in the meta page ({root, sequence}).
  const rootHeader = Buffer.alloc(BUCKET_HEADER);
  rootHeader.writeBigUInt64LE(BigInt(rootId), 0);
  visitBucket(rootHeader, 0, findTree(find));

  for (let i = 2; i < pgid; i++) if (!owned[i]) refuse('a page is neither reachable nor free');
  return {
    ok: true,
    buckets: tops,
    found,
    stats: {
      pages: pgid,
      elements,
      maxTreeDepth,
      maxNesting,
      inlineBuckets,
      maxPageSpanBytes: (maxOverflow + 1) * ps,
    },
  };
}

// --- the acceptance boundary ---------------------------------------------------------

/** sha256 of a file, read in 8 MiB chunks; refuses once `deadline` has passed. */
function sha256File(path, deadline) {
  const hash = createHash('sha256');
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const buf = Buffer.allocUnsafe(8 << 20);
    for (;;) {
      if (performance.now() > deadline) refuse('took longer than its time limit');
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

const DIGESTED = Object.freeze(['trivy.db', 'metadata.json']);
/** metadata.json and the provenance file are small; anything larger is not Trivy's or ours. */
const SMALL_FILE_BYTES = 64 * 1024;

/** A small JSON file (at most SMALL_FILE_BYTES) as an object, or a fixed problem. */
function readJsonObject(path) {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined) return { problem: 'is missing' };
  if (!st.isFile()) return { problem: 'is not a regular file' };
  if (st.size > SMALL_FILE_BYTES) return { problem: 'is larger than allowed' };
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e instanceof SyntaxError) return { problem: 'is not valid JSON' };
    throw e;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { problem: 'is not a JSON object' };
  }
  return { value };
}

/**
 * The metadata Trivy needs (pkg/db/metadata.go): schema Version, the
 * publisher's UpdatedAt and NextUpdate, and the DownloadedAt Trivy itself
 * writes when a download completes. A value is repeated only after it parsed
 * as a strict RFC 3339 instant.
 */
function checkMetadata(meta, nowNs) {
  if (meta.Version !== SCHEMA_VERSION) return { problem: `Version is not ${SCHEMA_VERSION}` };
  const at = {};
  for (const field of ['UpdatedAt', 'NextUpdate', 'DownloadedAt']) {
    at[field] = parseInstant(meta[field]);
    if (at[field] === null) {
      return { problem: `${field} is missing or not a valid RFC 3339 instant` };
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

/** What the content check reads from the DB: each canary advisory, its details, its feed. */
const CONTENT_FIND = Object.freeze(
  ECOSYSTEMS.flatMap(({ bucket, canary }) => [
    [bucket, canary.pkg, canary.id],
    ['vulnerability', canary.id],
    ['data-source', bucket],
  ]),
);
const parseObject = (buf) => {
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/**
 * The copy itself, before anyone vouches for it: metadata, age, the whole
 * bbolt structure, every required bucket non-empty, no empty package bucket
 * in an ecosystem a scan reads, and each ecosystem's canary advisory present
 * with its details rated HIGH or CRITICAL and its feed recorded. Throws
 * (Refusal or an I/O error); `checkDb` and `fetchDb` turn both into refusals.
 * @returns {{ok: true, updatedAt: string, ageHours: number, buckets: number} | {ok: false, reason: string}}
 */
function checkContent(cacheDir, now, nowNs, deadline) {
  const fail = (reason) => ({ ok: false, reason });
  const meta = readJsonObject(join(cacheDir, 'db', 'metadata.json'));
  if (meta.problem) return fail(`db/metadata.json ${meta.problem}`);
  const m = checkMetadata(meta.value, nowNs);
  if (m.problem) return fail(`metadata ${m.problem} (runner clock ${now.toISOString()})`);
  const ageNs = nowNs - m.updatedNs;
  const ageHours = Number(ageNs / 1_000_000n) / 3_600_000;
  if (ageNs > MAX_AGE_NS) {
    return fail(
      `vulnerability DB is stale: UpdatedAt ${meta.value.UpdatedAt} is ${ageHours.toFixed(1)} h old, limit 24 h`,
    );
  }

  const dbPath = join(cacheDir, 'db', 'trivy.db');
  const st = lstatSync(dbPath, { throwIfNoEntry: false });
  if (st === undefined) return fail('missing db/trivy.db');
  if (!st.isFile()) return fail('db/trivy.db is not a regular file');
  const bolt = inspectBolt(dbPath, { deadline, find: CONTENT_FIND });
  if (!bolt.ok && bolt.error)
    return { ok: false, reason: `db/trivy.db ${bolt.reason}`, error: true };
  if (!bolt.ok) return fail(`db/trivy.db: ${bolt.reason} (not a usable bbolt database)`);
  for (const name of REQUIRED_BUCKETS) {
    const b = bolt.buckets.get(name);
    if (b === undefined) return fail(`db/trivy.db has no bucket "${name}"`);
    if (b.values === 0) return fail(`db/trivy.db has an empty bucket "${name}"`);
  }
  for (const { bucket, canary } of ECOSYSTEMS) {
    if (bolt.buckets.get(bucket).emptyBuckets > 0) {
      return fail(`db/trivy.db has an empty package bucket in "${bucket}"`);
    }
    const advisory = bolt.found.get(`${bucket}/${canary.pkg}/${canary.id}`);
    if (advisory === undefined || parseObject(advisory) === null) {
      return fail(
        `db/trivy.db has no canary advisory ${canary.id} for ${canary.pkg} in "${bucket}"`,
      );
    }
    const details = bolt.found.get(`vulnerability/${canary.id}`);
    const severity = details && parseObject(details)?.Severity;
    if (!GATE_SEVERITIES.includes(severity)) {
      return fail(`db/trivy.db does not rate ${canary.id} ${GATE_SEVERITIES.join(' or ')}`);
    }
    const feed = bolt.found.get(`data-source/${bucket}`);
    if (feed === undefined || parseObject(feed) === null) {
      return fail(`db/trivy.db records no data source for "${bucket}"`);
    }
  }
  return { ok: true, updatedAt: meta.value.UpdatedAt, ageHours, buckets: bolt.buckets.size };
}

/**
 * Accepts a Trivy cache directory only if every part of it is what the
 * producer named by `key` validated: metadata, age, bbolt structure, the
 * content a scan needs, provenance from an allowed repository, and the exact
 * bytes (sha256). Anything unknown, unreadable or missing is a refusal, and
 * so is any error while inspecting (it never throws).
 * @param {string} cacheDir
 * @param {{now: Date, key: string, run: {id: string, attempt: string}, deadline?: number}} ctx
 *   `now` the runner's clock; `key` the producer's key; `run` this
 *   job's GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT; `deadline` (performance.now()
 *   milliseconds) can only bring the check's own BUDGET.checkMs forward.
 * @returns {{ok: true, updatedAt: string, ageHours: number, buckets: number, source: object}
 *   | {ok: false, reason: string, error?: true}}
 */
export function checkDb(cacheDir, { now, key, run, deadline = Infinity } = {}) {
  const until = Math.min(deadline, performance.now() + BUDGET.checkMs);
  try {
    return checkDbWithin(cacheDir, now, key, run, until);
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: `the copy ${e.message}` };
    return { ok: false, reason: `the copy could not be inspected (${errorCode(e)})`, error: true };
  }
}

function checkDbWithin(cacheDir, now, key, run, deadline) {
  const fail = (reason) => ({ ok: false, reason });
  const nowNs = clockNs(now);
  if (nowNs === null) return fail('the runner clock is not a valid instant');
  const producer = expectedProducer(key, run);
  if (!producer.ok) return fail(producer.reason);
  const content = checkContent(cacheDir, now, nowNs, deadline);
  if (!content.ok) return content;

  const read = readJsonObject(join(cacheDir, SOURCE_FILE));
  if (read.problem) {
    return fail(
      read.problem === 'is missing'
        ? `missing ${SOURCE_FILE}: this DB was not produced by the shared download`
        : `${SOURCE_FILE} ${read.problem}`,
    );
  }
  const source = read.value;
  if (
    source.key !== producer.key ||
    source.runId !== producer.runId ||
    source.runAttempt !== producer.runAttempt
  ) {
    // Not repeated: what the file says is unchecked.
    return fail(`DB was not published by the producer that key names (expected ${producer.key})`);
  }
  if (!REPOSITORIES.includes(source.repository)) {
    return fail(`DB names a repository that is not one of ${REPOSITORIES.join(', ')}`);
  }
  // The evidence line repeats it, so it must be an instant, not any text.
  if (parseInstant(source.fetchedAt) === null) {
    return fail(`${SOURCE_FILE} carries no valid fetchedAt instant`);
  }
  for (const file of DIGESTED) {
    const want = source.sha256?.[file];
    if (typeof want !== 'string' || !/^[0-9a-f]{64}$/.test(want)) {
      return fail(`${SOURCE_FILE} carries no sha256 for ${file}`);
    }
    if (sha256File(join(cacheDir, 'db', file), deadline) !== want) {
      return fail(`db/${file} is not the copy the producer validated (sha256 differs)`);
    }
  }
  return { ...content, source };
}

// --- child processes -----------------------------------------------------------------

/**
 * Starts a child in its own process group with a hard deadline: SIGTERM to
 * the group at `limitMs - graceMs`, SIGKILL `graceMs` later. Once that
 * escalation has begun it runs to completion whether or not the leader
 * exits first (PR #435 r2 R2-2: a leader that exits on SIGTERM must not
 * cancel the SIGKILL its SIGTERM-ignoring descendants still need), and the
 * result settles by `limitMs + graceMs` even if the child is unkillable.
 * When the leader exits on its own, whatever it left in its group is killed:
 * nothing it started may outlive it. `stop()` kills the group now (a
 * refusal). Captured stdout is bounded by `captureLimit` bytes: one more
 * byte stops the child (`overflow`). stderr goes to the job log, or nowhere.
 * @returns {{child: import('node:child_process').ChildProcess | undefined, stop: () => void, result: Promise<object>}}
 */
export function startBounded(
  command,
  args,
  {
    limitMs,
    graceMs,
    env,
    stdin = 'ignore',
    stdout = 'inherit',
    stderr = 'inherit',
    captureLimit = 0,
    onStdout,
  },
) {
  let settled = false;
  let timedOut = false;
  let stopped = false;
  let overflow = false;
  let escalating = false;
  let killed = false;
  let exit = null;
  const chunks = [];
  let captured = 0;
  const timers = [];
  let resolve;
  const result = new Promise((r) => {
    resolve = r;
  });
  const settle = (r) => {
    if (settled) return;
    settled = true;
    for (const t of timers) clearTimeout(t);
    resolve({
      ...r,
      timedOut,
      stopped,
      overflow,
      stdout: captureLimit > 0 ? Buffer.concat(chunks).toString('utf8') : '',
    });
  };
  let child;
  try {
    child = spawn(command, args, { detached: true, env, stdio: [stdin, stdout, stderr] });
  } catch (error) {
    settle({ error });
    return { child: undefined, stop: () => {}, result };
  }
  const group = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      // the group is gone (or never started)
    }
  };
  const kill = () => {
    group('SIGKILL');
    killed = true;
    if (exit) settle(exit);
  };
  const escalate = (now) => {
    if (escalating) return;
    escalating = true;
    if (now) kill();
    else {
      group('SIGTERM');
      timers.push(setTimeout(kill, graceMs));
    }
    timers.push(
      setTimeout(
        () => settle(exit ?? { status: null, signal: 'SIGKILL' }),
        now ? graceMs : 2 * graceMs,
      ),
    );
  };
  const stop = () => {
    stopped = true;
    escalate(true);
  };
  timers.push(
    setTimeout(
      () => {
        timedOut = true;
        escalate(false);
      },
      Math.max(0, limitMs - graceMs),
    ),
  );
  if (child.stdout && (captureLimit > 0 || onStdout)) {
    child.stdout.on('data', (b) => {
      if (captureLimit > 0) {
        captured += b.length;
        if (captured > captureLimit) {
          overflow = true;
          stop();
          return;
        }
        chunks.push(b);
      }
      onStdout?.(b);
    });
  }
  const done = (r) => {
    exit = r;
    if (!escalating) {
      group('SIGKILL'); // what the leader left behind
      settle(r);
    } else if (killed) settle(r);
  };
  child.on('error', (error) => done({ error }));
  child.on('close', (status, signal) => done({ status, signal }));
  return { child, stop, result };
}

/** `startBounded`, awaited. */
export const runBounded = (command, args, opts) => startBounded(command, args, opts).result;

/** What went wrong with a finished child, as a fixed text (null: it exited 0). */
const describe = (what, r) =>
  r.error
    ? `could not run ${what} (${errorCode(r.error)})`
    : r.overflow
      ? `${what} printed more than allowed and was stopped`
      : r.timedOut
        ? `${what} did not finish within its deadline and was killed`
        : r.status !== 0
          ? `${what} exited ${r.status ?? r.signal}`
          : null;

// --- the archive between the producer and the scans ------------------------------------

/**
 * The producer's archive (PR #435 r2 R2-1: the shell admission it replaces
 * failed open on SIGPIPE). POSIX ustar, written by `packDb`, holding exactly
 * these members, in this order, under these exact names, and nothing else:
 * no tar extension (pax, GNU long names), no link, no device, no other path.
 * `unpackDb` compares name/NUL padding, typeflag, empty link name, ustar
 * magic/version and empty prefix; it validates checksum and strict octal
 * size. Owner/mode/time bytes are ignored at extraction. There is
 * nothing to canonicalise: an alias (`./trivy-db/`, `trivy-db//db/`, a
 * directory without its slash, a file with one), a duplicate, a member out
 * of place or of the other type is simply not the next member.
 */
export const ARCHIVE = Object.freeze({
  file: 'trivy-db.tar.zst',
  members: Object.freeze([
    Object.freeze({ name: 'trivy-db/', dir: true }),
    Object.freeze({
      name: `trivy-db/${SOURCE_FILE}`,
      from: SOURCE_FILE,
      maxBytes: SMALL_FILE_BYTES,
    }),
    Object.freeze({ name: 'trivy-db/db/', dir: true }),
    Object.freeze({
      name: 'trivy-db/db/metadata.json',
      from: 'db/metadata.json',
      maxBytes: SMALL_FILE_BYTES,
    }),
    Object.freeze({
      name: 'trivy-db/db/trivy.db',
      from: 'db/trivy.db',
      maxBytes: BOLT_LIMITS.fileBytes,
    }),
  ]),
  /** The compressed artifact (real: 92 MB). */
  maxArchiveBytes: 1024 ** 3,
  /**
   * Zero bytes after the last member: the two end blocks, plus up to one
   * 10240-byte record of padding (GNU tar pads to whole records: at most
   * 1024 + 10240 - 512 bytes in all).
   */
  maxTrailerBytes: 1024 + 10240,
  /** zstd's decompression window limit (the producer's archive: a 2 MiB window, `zstd -lv`). */
  zstdMemory: '--memory=64MB',
});
const BLOCK_BYTES = 512;

/** A ustar header for one member of ARCHIVE (mode, owner and time fixed; never read back). */
function tarHeader(member, size) {
  const h = Buffer.alloc(BLOCK_BYTES);
  const field = (at, text) => h.write(text, at, 'latin1');
  field(0, member.name);
  field(100, member.dir ? '0000755\0' : '0000644\0');
  field(108, '0000000\0');
  field(116, '0000000\0');
  field(124, `${size.toString(8).padStart(11, '0')}\0`);
  field(136, '00000000000\0');
  field(148, '        ');
  h[156] = member.dir ? 0x35 : 0x30;
  field(257, 'ustar\0');
  field(263, '00');
  field(329, '0000000\0');
  field(337, '0000000\0');
  let sum = 0;
  for (const b of h) sum += b;
  field(148, `${sum.toString(8).padStart(6, '0')}\0 `);
  return h;
}

/** The size a ustar header declares: strict octal digits, NUL-terminated; null otherwise. */
function tarSize(h) {
  const text = h.toString('latin1', 124, 136);
  return /^[0-7]{11}\0$/.test(text) ? parseInt(text.slice(0, 11), 8) : null;
}
const zeroes = (buf, from, to) => {
  for (let i = from; i < to; i++) if (buf[i] !== 0) return false;
  return true;
};
/** Whether header `h` is exactly ARCHIVE's member `m` (size checked by the caller). */
function isMember(h, m) {
  let sum = 0;
  for (let i = 0; i < BLOCK_BYTES; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  const stored = h.toString('latin1', 148, 156);
  if (!/^[0-7]{6}\0 $/.test(stored) || parseInt(stored.slice(0, 6), 8) !== sum) return false;
  const name = Buffer.from(m.name, 'latin1');
  return (
    h.compare(name, 0, name.length, 0, name.length) === 0 &&
    zeroes(h, name.length, 100) &&
    h[156] === (m.dir ? 0x35 : 0x30) &&
    zeroes(h, 157, 257) && // no link name
    h.toString('latin1', 257, 265) === 'ustar\u000000' &&
    zeroes(h, 345, 512) // no name prefix
  );
}

/**
 * The one admission of the producer's archive, shared by every scan. The
 * artifact directory must hold exactly ARCHIVE.file, a regular file of at
 * most maxArchiveBytes. It is decompressed once (zstd, reading the open
 * file, bounded window), and the same parse that admits writes: each header
 * must be the next member of ARCHIVE before a byte of it is written, a
 * member's data may not exceed its maximum, padding and the end are zeroes
 * of bounded length, and the stream must end exactly after them. So
 * decompression is bounded too: the first byte past what ARCHIVE allows
 * stops it, and the decompressor is killed on every refusal. Members go
 * into a fresh directory beside `targetDir`, created exclusively; only a
 * complete, admitted archive is moved to `targetDir`, which is removed
 * first and stays absent on refusal.
 * @returns {Promise<{ok: true, bytes: number} | {ok: false, reason: string, error?: true}>}
 *   `error`: the archive could not be inspected (I/O, decompressor missing),
 *   which is a refusal too, never a pass.
 */
export async function unpackDb(
  artifactDir,
  targetDir,
  { budget = BUDGET, zstd = 'zstd', env = process.env } = {},
) {
  let quarantine;
  let fd;
  let parser;
  try {
    rmSync(targetDir, { recursive: true, force: true });
    const entries = readdirSync(artifactDir, { withFileTypes: true });
    if (entries.length !== 1 || entries[0].name !== ARCHIVE.file || !entries[0].isFile()) {
      return { ok: false, reason: `the downloaded artifact is not exactly ${ARCHIVE.file}` };
    }
    // No link followed, and no blocking: a FIFO swapped in after readdir is refused by fstat.
    fd = openSync(
      join(artifactDir, ARCHIVE.file),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > ARCHIVE.maxArchiveBytes) {
      return { ok: false, reason: 'the downloaded archive is larger than allowed' };
    }
    quarantine = mkdtempSync(join(dirname(targetDir), '.trivy-db-unpack-'));
    parser = admitter(quarantine);
    let refusal = null;
    const run = startBounded(zstd, ['-q', '-d', '-c', ARCHIVE.zstdMemory], {
      limitMs: budget.unpackMs,
      graceMs: budget.killGraceMs,
      env,
      stdin: fd,
      stdout: 'pipe',
      stderr: 'ignore',
      onStdout: (chunk) => {
        if (refusal) return;
        try {
          parser.feed(chunk);
        } catch (e) {
          refusal = e;
          run.stop();
        }
      },
    });
    const r = await run.result;
    if (refusal) throw refusal;
    const problem = describe('the decompressor', r);
    if (problem) {
      return r.error || r.timedOut
        ? { ok: false, reason: `the archive could not be unpacked: ${problem}`, error: true }
        : { ok: false, reason: `the archive is damaged or truncated: ${problem}` };
    }
    const bytes = parser.end();
    renameSync(join(quarantine, 'trivy-db'), targetDir);
    return { ok: true, bytes };
  } catch (e) {
    rmSync(targetDir, { recursive: true, force: true });
    if (e instanceof Refusal) return { ok: false, reason: `the archive ${e.message}` };
    return {
      ok: false,
      reason: `the archive could not be unpacked (${errorCode(e)})`,
      error: true,
    };
  } finally {
    parser?.abort();
    if (fd !== undefined) closeSync(fd);
    if (quarantine) rmSync(quarantine, { recursive: true, force: true });
  }
}

/** The streaming parser `unpackDb` feeds; throws a Refusal at the first byte ARCHIVE does not allow. */
function admitter(root) {
  const { members, maxTrailerBytes } = ARCHIVE;
  const header = Buffer.alloc(BLOCK_BYTES);
  let fill = 0;
  let index = 0; // next member
  let remaining = 0; // data bytes of the current member
  let padding = 0;
  let out = null; // its file descriptor
  let trailer = 0;
  let total = 0;
  const admit = () => {
    if (index === members.length) {
      if (!zeroes(header, 0, BLOCK_BYTES)) refuse('holds more members than the producer writes');
      trailer += BLOCK_BYTES;
      if (trailer > maxTrailerBytes) refuse('carries data after its end');
      return;
    }
    const m = members[index];
    if (zeroes(header, 0, BLOCK_BYTES)) refuse('ends before the last member the producer writes');
    if (!isMember(header, m)) {
      refuse('holds a member that is not the next one the producer writes (name, type or format)');
    }
    const size = tarSize(header);
    if (size === null) refuse('holds a member whose size is not plain octal');
    if (m.dir ? size !== 0 : size > m.maxBytes) refuse('holds a member larger than allowed');
    const path = join(root, m.name);
    if (m.dir) mkdirSync(path, { mode: 0o755 });
    else {
      out = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644);
      remaining = size;
      padding = (BLOCK_BYTES - (size % BLOCK_BYTES)) % BLOCK_BYTES;
      if (remaining === 0) {
        closeSync(out);
        out = null;
      }
    }
    index += 1;
  };
  return {
    feed(chunk) {
      total += chunk.length;
      let at = 0;
      while (at < chunk.length) {
        if (remaining > 0) {
          const n = Math.min(remaining, chunk.length - at);
          writeSync(out, chunk, at, n);
          at += n;
          remaining -= n;
          if (remaining === 0) {
            closeSync(out);
            out = null;
          }
        } else if (padding > 0) {
          const n = Math.min(padding, chunk.length - at);
          if (!zeroes(chunk, at, at + n)) refuse('carries data in its padding');
          at += n;
          padding -= n;
        } else {
          const n = Math.min(BLOCK_BYTES - fill, chunk.length - at);
          chunk.copy(header, fill, at, at + n);
          fill += n;
          at += n;
          if (fill === BLOCK_BYTES) {
            fill = 0;
            admit();
          }
        }
      }
    },
    /** Closes the member being written, if any (after a refusal). */
    abort() {
      if (remaining > 0 && out !== null) closeSync(out);
      out = null;
      remaining = 0;
    },
    /** After the decompressor exited 0: the archive must be complete. */
    end() {
      if (index < members.length || remaining > 0 || padding > 0) {
        refuse('ends before the last member the producer writes');
      }
      if (fill !== 0 || trailer < 2 * BLOCK_BYTES) refuse('has no proper end');
      return total;
    },
  };
}

/**
 * Packs the validated cache directory into `archivePath` (created, never
 * overwritten) as ARCHIVE says, refusing a directory that holds anything
 * else: what the scans admit is exactly what this writes.
 * @returns {Promise<{ok: true, bytes: number} | {ok: false, reason: string, error?: true}>}
 */
export async function packDb(
  cacheDir,
  archivePath,
  { budget = BUDGET, zstd = 'zstd', env = process.env } = {},
) {
  const files = new Map(); // member -> {fd, size}
  let out;
  try {
    const layout = { '': [SOURCE_FILE, 'db'], db: ['metadata.json', 'trivy.db'] };
    for (const [dir, names] of Object.entries(layout)) {
      if (readdirSync(join(cacheDir, dir)).sort().join('/') !== [...names].sort().join('/')) {
        return {
          ok: false,
          reason: 'the DB directory holds something other than the DB and its provenance',
        };
      }
    }
    for (const m of ARCHIVE.members) {
      if (m.dir) continue;
      const fd = openSync(join(cacheDir, m.from), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const { size } = fstatSync(fd);
      files.set(m, { fd, size });
      if (!fstatSync(fd).isFile() || size > m.maxBytes) {
        return {
          ok: false,
          reason: 'a file of the DB directory is not a regular file within its limit',
        };
      }
    }
    out = openSync(
      archivePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o644,
    );
    const run = startBounded(zstd, ['-q', '-T0', '-3', '-c'], {
      limitMs: budget.packMs,
      graceMs: budget.killGraceMs,
      env,
      stdin: 'pipe',
      stdout: out,
      stderr: 'ignore',
    });
    const sink = run.child?.stdin;
    let broken = !sink;
    sink?.on('error', () => {
      broken = true;
    });
    const write = async (buf) => {
      if (broken) refuse('could not be written: the compressor stopped');
      if (!sink.write(buf)) {
        await new Promise((r) => {
          const done = () => {
            sink.off('drain', done);
            sink.off('close', done);
            r();
          };
          sink.on('drain', done);
          sink.on('close', done);
        });
      }
    };
    try {
      const chunk = Buffer.allocUnsafe(1 << 20);
      for (const m of ARCHIVE.members) {
        const file = files.get(m);
        await write(tarHeader(m, file ? file.size : 0));
        if (!file) continue;
        for (let left = file.size; left > 0;) {
          const n = readSync(file.fd, chunk, 0, Math.min(chunk.length, left), null);
          if (n === 0) refuse('could not be written: a file shrank while it was packed');
          await write(Buffer.from(chunk.subarray(0, n)));
          left -= n;
        }
        const pad = (BLOCK_BYTES - (file.size % BLOCK_BYTES)) % BLOCK_BYTES;
        if (pad) await write(Buffer.alloc(pad));
      }
      await write(Buffer.alloc(2 * BLOCK_BYTES));
      sink.end();
    } catch (e) {
      run.stop();
      await run.result;
      throw e;
    }
    const problem = describe('the compressor', await run.result);
    if (problem) refuse(`could not be written: ${problem}`);
    return { ok: true, bytes: fstatSync(out).size };
  } catch (e) {
    if (out !== undefined) rmSync(archivePath, { force: true });
    if (e instanceof Refusal) return { ok: false, reason: `the archive ${e.message}` };
    return { ok: false, reason: `the archive could not be written (${errorCode(e)})`, error: true };
  } finally {
    for (const { fd } of files.values()) closeSync(fd);
    if (out !== undefined) closeSync(out);
  }
}

// --- the producer ------------------------------------------------------------------

/** One canary directory per Alpine release: an apk database, node_modules and a Cargo.lock. */
function writeCanaryRoot(dir, release) {
  const at = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const by = Object.fromEntries(ECOSYSTEMS.map((e) => [e.type, e.canary]));
  at('etc/alpine-release', `${release}.0\n`);
  at('lib/apk/db/installed', `P:${by.alpine.pkg}\nV:${by.alpine.version}\n\n`);
  at(
    `app/node_modules/${by['node-pkg'].pkg}/package.json`,
    JSON.stringify({ name: by['node-pkg'].pkg, version: by['node-pkg'].version }),
  );
  at(
    'app/Cargo.lock',
    `version = 3\n\n[[package]]\nname = "${by.cargo.pkg}"\nversion = "${by.cargo.version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`,
  );
}
/** Trivy's JSON report of the canary scan is small (measured 65 KB). */
const CANARY_REPORT_BYTES = 4 * 1024 * 1024;

/**
 * Trivy scans a canary root per scanned Alpine release against `cacheDir`
 * the way it scans an image (`rootfs`: apk database, node_modules,
 * Cargo.lock), and must report every ecosystem's canary at HIGH or CRITICAL
 * on that release: the DB opens in Trivy, its advisories match and its
 * severities pass the gate's filter. Null when all were found.
 */
async function canaryScans(trivy, cacheDir, { deadline, limitMs, graceMs, env }) {
  for (const release of ALPINE_RELEASES) {
    const dir = mkdtempSync(join(tmpdir(), 'ci-trivy-db-canary-'));
    try {
      writeCanaryRoot(dir, release);
      // At least 1 s even past the copy's deadline: sealing and the full check
      // after it refuse an overrun copy anyway.
      const limit = Math.max(1_000, Math.min(limitMs, deadline - performance.now()));
      const r = await runBounded(
        trivy,
        [
          'rootfs',
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
          trivyTimeout(limit, graceMs),
          dir,
        ],
        { limitMs: limit, graceMs, env, stdout: 'pipe', captureLimit: CANARY_REPORT_BYTES },
      );
      const problem = describe('the canary scan', r);
      if (problem) return problem;
      let report;
      try {
        report = JSON.parse(r.stdout);
      } catch {
        return 'the canary scan printed no JSON report';
      }
      if (report?.Metadata?.OS?.Family !== 'alpine' || report.Metadata.OS.Name !== `${release}.0`) {
        return `the canary scan did not detect Alpine ${release}`;
      }
      for (const { type, canary } of ECOSYSTEMS.filter(
        (e) => e.type !== 'alpine' || e.release === release,
      )) {
        const found = (Array.isArray(report.Results) ? report.Results : [])
          .filter((x) => x?.Type === type)
          .flatMap((x) => (Array.isArray(x.Vulnerabilities) ? x.Vulnerabilities : []))
          .find((v) => v?.VulnerabilityID === canary.id && v?.PkgName === canary.pkg);
        if (!found) {
          return `Trivy found no ${canary.id} in ${canary.pkg} ${canary.version} (${type}) with this DB`;
        }
        if (!GATE_SEVERITIES.includes(found.Severity)) {
          return `Trivy does not rate ${canary.id} ${GATE_SEVERITIES.join(' or ')} with this DB`;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return null;
}

const trivyTimeout = (limitMs, graceMs) =>
  `${Math.max(1, Math.floor((limitMs - 2 * graceMs) / 1000))}s`;

/**
 * Downloads the DB, repository by repository, attempt by attempt, until one
 * copy downloads, passes its content check, the canaries and `checkDb` (a
 * mirror serving a stale, hollow or damaged copy, or one whose inspection
 * fails or overruns BUDGET.validationMs, is a failed attempt, so the next
 * attempt or repository gets its turn). Each repository has its own time
 * window.
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
    checker = 'trivy-db-check',
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
      let problem;
      try {
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
        problem = describe('trivy', download);
        // Everything in-process about this copy, canaries included, shares one deadline.
        const deadline = performance.now() + budget.validationMs;
        if (problem === null) {
          problem = await validateCopy(cacheDir, {
            key,
            run,
            repository,
            attempt,
            trivy,
            checker,
            budget,
            deadline,
            now,
            env,
            log,
          });
        }
        if (problem === null) {
          const check = checkDb(cacheDir, { now: now(), key, run, deadline });
          if (check.ok) {
            const names = ECOSYSTEMS.map((e) => e.canary.id).join(', ');
            log(`trivy-db: ${label} ok (UpdatedAt ${check.updatedAt}, canaries ${names} found)`);
            return { ok: true, key, repository, check };
          }
          problem = `downloaded copy rejected: ${check.reason}`;
        }
      } catch (e) {
        // An inspection that failed is a failed attempt, never a crash of the producer.
        problem = `downloaded copy could not be inspected (${errorCode(e)})`;
      }
      failures.push(`${label}: ${problem}`);
      log(`::warning::trivy-db: ${failures.at(-1)}`);
      if (left() < budget.minAttemptMs) break;
    }
  }
  try {
    rmSync(cacheDir, { recursive: true, force: true });
  } catch {
    // the refusal below stands either way
  }
  return { ok: false, reason: `no repository yielded a usable DB:\n  ${failures.join('\n  ')}` };
}

/**
 * One downloaded copy, before it is sealed, within BUDGET.validationMs: the
 * copy itself first (cheap: a stale or hollow copy costs no checker or
 * canary), then the official checker, Trivy's canaries and the provenance
 * that vouches for exactly these
 * bytes. Null when it passed; the full check every consumer runs follows.
 */
async function validateCopy(
  cacheDir,
  { key, run, repository, attempt, trivy, checker, budget, deadline, now, env, log },
) {
  const now0 = now();
  const nowNs = clockNs(now0);
  if (nowNs === null) return 'downloaded copy rejected: the runner clock is not a valid instant';
  let content;
  try {
    content = checkContent(cacheDir, now0, nowNs, deadline);
  } catch (e) {
    if (e instanceof Refusal) content = { ok: false, reason: `the copy ${e.message}` };
    else throw e;
  }
  if (!content.ok) return `downloaded copy rejected: ${content.reason}`;
  // Before canaries and sealing, on every attempt. No checker output is
  // logged: even panic traces or forged diagnostics must not echo DB keys.
  const officialStarted = performance.now();
  const official = await runBounded(checker, [join(cacheDir, 'db/trivy.db')], {
    limitMs: Math.min(budget.officialCheckMs, deadline - performance.now()),
    graceMs: budget.killGraceMs,
    env,
    stdout: 'pipe',
    stderr: 'ignore',
    captureLimit: 4096,
  });
  const officialProblem = describe('the official bbolt check', official);
  if (officialProblem !== null) return `downloaded copy rejected: ${officialProblem}`;
  if (official.stdout !== 'ok\n')
    return 'downloaded copy rejected: the official bbolt check printed no success marker';
  log(`trivy-db: official bbolt check ok (${Math.round(performance.now() - officialStarted)} ms)`);
  const canary = await canaryScans(trivy, cacheDir, {
    deadline,
    limitMs: budget.canaryMs,
    graceMs: budget.killGraceMs,
    env,
  });
  if (canary !== null) return `downloaded copy rejected: ${canary}`;
  let sha256;
  try {
    sha256 = Object.fromEntries(
      DIGESTED.map((file) => [file, sha256File(join(cacheDir, 'db', file), deadline)]),
    );
  } catch (e) {
    if (e instanceof Refusal) return `downloaded copy rejected: the copy ${e.message}`;
    throw e;
  }
  writeFileSync(
    join(cacheDir, SOURCE_FILE),
    `${JSON.stringify({
      key,
      repository,
      runId: String(run.id),
      runAttempt: String(run.attempt),
      attempt,
      fetchedAt: now().toISOString(),
      sha256,
    })}\n`,
  );
  return null;
}
