import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  ALPINE_RELEASES,
  ARCHIVE,
  BOLT_LIMITS,
  BUDGET,
  checkDb,
  ECOSYSTEMS,
  expectedProducer,
  fetchDb,
  inspectBolt,
  MAX_AGE_NS,
  MAX_FUTURE_SKEW_NS,
  packDb,
  parseInstant,
  REPOSITORIES,
  REQUIRED_BUCKETS,
  runBounded,
  SCANNED_BASES,
  startBounded,
  unpackDb,
} from './ci-trivy-db-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(ROOT, 'scripts/ci-trivy-db.mjs');
const LIB = resolve(ROOT, 'scripts/ci-trivy-db-lib.mjs');
/** Genuine bbolt files written by go.etcd.io/bbolt (see the README beside them). */
const FIXTURES = resolve(ROOT, 'scripts/fixtures/trivy-db');
const NOW = new Date('2026-10-25T06:00:00.000Z');
const HOUR = 3600 * 1000;
const iso = (offsetMs, base = NOW) => new Date(base.getTime() + offsetMs).toISOString();
const RUN = Object.freeze({ id: '77', attempt: '1' });
const KEY = 'trivy-db-77-1';
const CTX = Object.freeze({ now: NOW, key: KEY, run: RUN });
const [GCR, GHCR] = REPOSITORIES;
const E404 =
  'FATAL failed to download artifact from mirror.gcr.io/aquasec/trivy-db:2: oci download error: failed to fetch the layer: GET https://mirror.gcr.io/artifacts-downloads/x: unexpected status code 404 Not Found';
const [ALPINE] = ECOSYSTEMS.map((e) => e.bucket);

const made = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-trivy-db-'));
  made.push(dir);
  return dir;
};
// Some tests write a 20,000-entry tree or a 1.6 GB-class archive's worth of files.
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The review's counterexample (r1 F1): 2 MiB, bbolt magic at offset 16, version 0, page size 0. */
function r1Counterexample() {
  const buf = Buffer.alloc(2 * 1024 * 1024);
  buf.writeUInt32LE(0xed0cdaed, 16);
  return buf;
}

/**
 * Lays a cache directory out the way the producer does: db/trivy.db (a
 * fixture name, a Buffer, or false), db/metadata.json (`meta` merged into a
 * fresh one, or a raw string), and the provenance with the sha256 of both
 * files as written (`source` merged in, or false).
 */
function writeDb(dir, { db = 'real', meta, source = {}, base = NOW } = {}) {
  mkdirSync(join(dir, 'db'), { recursive: true });
  const dbPath = join(dir, 'db/trivy.db');
  const metaPath = join(dir, 'db/metadata.json');
  if (Buffer.isBuffer(db)) writeFileSync(dbPath, db);
  else if (db) copyFileSync(join(FIXTURES, `${db}.db`), dbPath);
  writeFileSync(
    metaPath,
    typeof meta === 'string'
      ? meta
      : JSON.stringify({
          Version: 2,
          NextUpdate: iso(23 * HOUR, base),
          UpdatedAt: iso(-HOUR, base),
          DownloadedAt: iso(-HOUR / 2, base),
          ...meta,
        }),
  );
  if (source) {
    writeFileSync(
      join(dir, 'ci-trivy-db-source.json'),
      JSON.stringify({
        key: KEY,
        repository: GCR,
        runId: '77',
        runAttempt: '1',
        attempt: 1,
        fetchedAt: iso(-HOUR / 2, base),
        sha256: {
          'trivy.db': existsSync(dbPath) ? sha256(dbPath) : undefined,
          'metadata.json': sha256(metaPath),
        },
        ...source,
      }),
    );
  }
  return dir;
}

/** Re-seals the provenance after a test damaged the files on purpose. */
function reseal(dir) {
  const path = join(dir, 'ci-trivy-db-source.json');
  const source = JSON.parse(readFileSync(path, 'utf8'));
  source.sha256 = {
    'trivy.db': sha256(join(dir, 'db/trivy.db')),
    'metadata.json': sha256(join(dir, 'db/metadata.json')),
  };
  writeFileSync(path, JSON.stringify(source));
}

/**
 * A test-side view of a bbolt file in a Buffer, independent of the reader
 * under test: the current meta page and the elements of any page, found by
 * path ([top-level bucket, nested bucket..., key]). Offsets are into `buf`,
 * so a test can damage exactly one field.
 */
function bolt(buf) {
  const ps = buf.readUInt32LE(24);
  const metas = [0, ps].map((at) => ({
    at,
    root: Number(buf.readBigUInt64LE(at + 32)),
    freelist: Number(buf.readBigUInt64LE(at + 48)),
    pgid: Number(buf.readBigUInt64LE(at + 56)),
    txid: buf.readBigUInt64LE(at + 64),
  }));
  const meta = metas[1].txid > metas[0].txid ? metas[1] : metas[0];
  const header = (off) => ({
    off,
    flags: buf.readUInt16LE(off + 8),
    count: buf.readUInt16LE(off + 10),
  });
  const elements = (off) => {
    const { flags, count } = header(off);
    return Array.from({ length: count }, (_, i) => {
      const el = off + 16 + i * 16;
      if (flags === 0x01) {
        const keyAt = el + buf.readUInt32LE(el);
        const ksize = buf.readUInt32LE(el + 4);
        const key = buf.toString('latin1', keyAt, keyAt + ksize);
        return {
          el,
          keyAt,
          ksize,
          key,
          childAt: el + 8,
          child: Number(buf.readBigUInt64LE(el + 8)),
        };
      }
      const keyAt = el + buf.readUInt32LE(el + 4);
      const ksize = buf.readUInt32LE(el + 8);
      const vsize = buf.readUInt32LE(el + 12);
      const key = buf.toString('latin1', keyAt, keyAt + ksize);
      return { el, flags: buf.readUInt32LE(el), keyAt, ksize, key, valueAt: keyAt + ksize, vsize };
    });
  };
  /** The page holding a bucket element's contents: its inline page, or its root page. */
  const bucketPage = (el) => {
    const root = Number(buf.readBigUInt64LE(el.valueAt));
    return root === 0 ? el.valueAt + 16 : root * ps;
  };
  const lookup = (off, key) => {
    const els = elements(off);
    if (header(off).flags !== 0x01) return els.find((e) => e.key === key);
    let pick = els[0];
    for (const e of els) if (e.key <= key) pick = e;
    return lookup(pick.child * ps, key);
  };
  const at = (...path) => {
    let off = meta.root * ps;
    let el;
    for (const key of path) {
      if (el) off = bucketPage(el);
      el = lookup(off, key);
      assert.ok(el, `${path.join(' / ')} is in the fixture`);
    }
    return el;
  };
  const freelist = () => {
    const off = meta.freelist * ps;
    const count = buf.readUInt16LE(off + 10);
    return {
      off,
      count,
      ids: Array.from({ length: count }, (_, i) => Number(buf.readBigUInt64LE(off + 16 + i * 8))),
    };
  };
  return { ps, meta, header, elements, bucketPage, at, freelist, rootPage: meta.root * ps };
}

/** Writes the real fixture (or `db`) with `edit(buffer, view)` applied, provenance re-sealed. */
function damaged(edit, db = 'real') {
  const dir = writeDb(tmp(), { db });
  const path = join(dir, 'db/trivy.db');
  const buf = readFileSync(path);
  edit(buf, bolt(buf));
  writeFileSync(path, buf);
  reseal(dir);
  return dir;
}

/** Renames a key in place (same length), keeping it in order unless the test means otherwise. */
const rename = (path, to) =>
  damaged((buf, b) => {
    const el = b.at(...path);
    assert.equal(el.ksize, to.length);
    buf.write(to, el.keyAt, 'latin1');
  });
const renameTopLevel = (from, to) => rename([from], to);

/** checkDb refuses, with `pattern`, and repeats none of `unechoed` (values the test injected). */
const refused = (dir, pattern, ctx = CTX, unechoed = []) => {
  const r = checkDb(dir, ctx);
  assert.equal(r.ok, false, `expected a refusal matching ${pattern}`);
  assert.match(r.reason, pattern);
  for (const value of unechoed)
    assert.ok(!r.reason.includes(value), `${r.reason} repeats ${value}`);
  return r;
};

// --- F1: the copy must be a real, usable Trivy DB ------------------------------

test('the fixtures are what the README says (go.etcd.io/bbolt output, not the reader under test)', () => {
  const real = inspectBolt(join(FIXTURES, 'real.db'));
  assert.equal(real.ok, true, real.reason);
  assert.deepEqual([...real.buckets.keys()].sort(), [...REQUIRED_BUCKETS].sort());
  for (const [name, b] of real.buckets) {
    assert.ok(b.values > 0, name);
    assert.equal(b.emptyBuckets, 0, name);
  }
  // What the round-2 mutations need: a branch page, inline buckets, an overflow page.
  const view = bolt(readFileSync(join(FIXTURES, 'real.db')));
  assert.equal(view.header(view.bucketPage(view.at('vulnerability'))).flags, 0x01);
  const alpine = view.elements(view.bucketPage(view.at(ALPINE)));
  assert.equal(alpine.length, 4);
  for (const pkg of alpine) assert.equal(view.bucketPage(pkg), pkg.valueAt + 16, pkg.key);
  assert.ok(real.stats.maxPageSpanBytes > view.ps);
  assert.ok(view.freelist().count > 0);
  assert.equal(inspectBolt(join(FIXTURES, 'sparse.db')).buckets.get(ALPINE).emptyBuckets, 1);
  assert.deepEqual([...inspectBolt(join(FIXTURES, 'empty.db')).buckets], []);
  const hollow = inspectBolt(join(FIXTURES, 'hollow.db'));
  assert.equal(hollow.buckets.size, REQUIRED_BUCKETS.length);
  for (const b of hollow.buckets.values()) assert.equal(b.values, 0);
});

test('checkDb: the real fixture, fresh and sealed by this producer, is accepted', () => {
  const r = checkDb(writeDb(tmp()), CTX);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.ageHours, 1);
  assert.equal(r.buckets, 5);
  assert.equal(r.source.key, KEY);
});

test("checkDb: the review's counterexample (magic only, bbolt version 0, page size 0) is REFUSED", () => {
  refused(writeDb(tmp(), { db: r1Counterexample() }), /meta page 0 is not format version 2/);
});

// Each damages one field of the genuine fixture; the provenance is re-sealed,
// so the sha256 is not what refuses it. The values injected are never repeated.
for (const [name, edit, pattern, unechoed = []] of [
  ['no bbolt magic', (b) => b.writeUInt32LE(0, 16), /meta page 0 has no bbolt magic/],
  ['meta 0 version 1', (b) => b.writeUInt32LE(1, 20), /meta page 0 is not format version 2/],
  ['meta 0 page size 0', (b) => b.writeUInt32LE(0, 24), /meta page 0 has an invalid page size/],
  [
    'meta 0 page size not a power of two',
    (b) => b.writeUInt32LE(4095, 24),
    /meta page 0 has an invalid page size/,
    ['4095'],
  ],
  [
    'meta 0 checksum (txid changed under it)',
    (b) => b.writeBigUInt64LE(b.readBigUInt64LE(64) + 1n, 64),
    /meta page 0 fails its checksum/,
  ],
  [
    'meta 1 checksum',
    (b) => b.writeBigUInt64LE(b.readBigUInt64LE(4096 + 32) + 1n, 4096 + 32),
    /meta page 1 fails its checksum/,
  ],
  [
    'meta 1 is not a meta page',
    (b) => b.writeUInt16LE(0x02, 4096 + 8),
    /meta page 1 is not a meta page/,
  ],
  [
    'root page carries another id',
    (b, v) => b.writeBigUInt64LE(9999n, v.rootPage),
    /a page carries another id/,
    ['9999'],
  ],
  [
    'root page is neither branch nor leaf',
    (b, v) => b.writeUInt16LE(0x10, v.rootPage + 8),
    /a page is neither a branch nor a leaf/,
    ['16'],
  ],
  [
    'root page claims more elements than fit',
    (b, v) => b.writeUInt16LE(60000, v.rootPage + 10),
    /a page has more elements than fit/,
    ['60000'],
  ],
  // --- round 2's three mutations (F1): nested and inline structure ---
  [
    "r2 (a): every Alpine package's inline page flags zeroed",
    (b, v) => {
      for (const pkg of v.elements(v.bucketPage(v.at(ALPINE))))
        b.writeUInt16LE(0, pkg.valueAt + 16 + 8);
    },
    /an inline bucket is not an inline leaf page/,
  ],
  [
    "r2 (b): every Alpine package's inline advisory count zeroed",
    (b, v) => {
      for (const pkg of v.elements(v.bucketPage(v.at(ALPINE))))
        b.writeUInt16LE(0, pkg.valueAt + 16 + 10);
    },
    /an inline bucket is not exactly as long as its elements/,
  ],
  [
    'r2 (c): a vulnerability branch child page id out of range',
    (b, v) => b.writeBigUInt64LE(9999n, v.elements(v.bucketPage(v.at('vulnerability')))[3].childAt),
    /a page id is out of range/,
    ['9999'],
  ],
  [
    "r2 (c): a vulnerability branch child pointing at its sibling's page",
    (b, v) => {
      const [first, second] = v.elements(v.bucketPage(v.at('vulnerability')));
      b.writeBigUInt64LE(BigInt(second.child), first.childAt);
    },
    /a page is referenced twice/,
  ],
  [
    'r2 (c): a vulnerability branch child pointing at a free page',
    (b, v) =>
      b.writeBigUInt64LE(
        BigInt(v.freelist().ids[0]),
        v.elements(v.bucketPage(v.at('vulnerability')))[5].childAt,
      ),
    /a page is (referenced twice|neither a branch nor a leaf)/,
  ],
  [
    'r2 (c): a vulnerability branch child pointing at a meta page',
    (b, v) => b.writeBigUInt64LE(1n, v.elements(v.bucketPage(v.at('vulnerability')))[0].childAt),
    /a page id is out of range/,
  ],
  [
    'a vulnerability branch emptied',
    (b, v) => b.writeUInt16LE(0, v.bucketPage(v.at('vulnerability')) + 10),
    /a non-root page is empty/,
  ],
  [
    'a vulnerability leaf emptied',
    (b, v) =>
      b.writeUInt16LE(0, v.elements(v.bucketPage(v.at('vulnerability')))[2].child * v.ps + 10),
    /a non-root page is empty/,
  ],
  [
    'branch keys out of order',
    (b, v) => b.write('0', v.elements(v.bucketPage(v.at('vulnerability')))[4].keyAt, 'latin1'),
    /page keys are not in order/,
  ],
  [
    'leaf keys out of order (inline data-source)',
    (b, v) => b.write('z', v.at('data-source', ALPINE).keyAt, 'latin1'),
    /bucket keys are not in order/,
  ],
  [
    'a leaf element with unknown flags',
    (b, v) => b.writeUInt32LE(2, v.at('vulnerability', 'CVE-2021-23337').el),
    /a leaf element has unknown flags/,
  ],
  [
    'a leaf element with an empty key',
    (b, v) => b.writeUInt32LE(0, v.at('vulnerability', 'CVE-2021-23337').el + 8),
    /a leaf element overruns its page/,
  ],
  [
    'a leaf element whose value overruns its page',
    (b, v) => b.writeUInt32LE(1 << 20, v.at('vulnerability', 'CVE-2021-23337').el + 12),
    /a leaf element overruns its page/,
  ],
  [
    'a leaf element moved one byte (gap between elements)',
    (b, v) => {
      const el = v.at('vulnerability', 'CVE-2021-23337').el;
      b.writeUInt32LE(b.readUInt32LE(el + 4) + 1, el + 4);
    },
    /a page does not lay its elements out back to back/,
  ],
  [
    'a branch element moved one byte',
    (b, v) => {
      const el = v.elements(v.bucketPage(v.at('vulnerability')))[1].el;
      b.writeUInt32LE(b.readUInt32LE(el) + 1, el);
    },
    /a page does not lay its elements out back to back/,
  ],
  [
    'a branch element with an empty key',
    (b, v) => b.writeUInt32LE(0, v.elements(v.bucketPage(v.at('vulnerability'))).at(-1).el + 4),
    /a branch element overruns its page/,
  ],
  [
    'an inline page with an id',
    (b, v) => b.writeBigUInt64LE(7n, v.at(ALPINE, 'zlib').valueAt + 16),
    /an inline bucket is not an inline leaf page/,
  ],
  [
    'an inline page claiming overflow pages',
    (b, v) => b.writeUInt32LE(1, v.at(ALPINE, 'zlib').valueAt + 16 + 12),
    /an inline bucket claims overflow pages/,
  ],
  [
    'an inline bucket holding a bucket',
    (b, v) => b.writeUInt32LE(1, v.at(ALPINE, 'zlib', 'CVE-2022-37434').el),
    /an inline bucket holds a bucket/,
  ],
  [
    'a bucket header with trailing bytes',
    (b, v) => b.writeUInt32LE(17, v.at('vulnerability').el + 12),
    /a bucket header has trailing bytes/,
  ],
  [
    'a bucket header cut short',
    (b, v) => b.writeUInt32LE(15, v.at('vulnerability').el + 12),
    /a bucket header is truncated/,
  ],
  [
    'a value at the top level, where only buckets live',
    (b, v) => b.writeUInt32LE(0, v.at('vulnerability').el),
    /the root holds a value, not a bucket/,
  ],
  [
    'a page whose overflow runs past the file',
    (b, v) =>
      b.writeUInt32LE(9999, v.elements(v.bucketPage(v.at('vulnerability')))[2].child * v.ps + 12),
    /a page overflows the file/,
    ['9999'],
  ],
  [
    'the freelist page is not a freelist',
    (b, v) => b.writeUInt16LE(0x02, v.freelist().off + 8),
    /the freelist page is not a freelist/,
  ],
  [
    'the freelist lists a page out of range',
    (b, v) => b.writeBigUInt64LE(9999n, v.freelist().off + 16),
    /a page id is out of range/,
    ['9999'],
  ],
  [
    'the freelist lists a reachable page',
    (b, v) => b.writeBigUInt64LE(BigInt(v.meta.root), v.freelist().off + 16),
    /a page is referenced twice/,
  ],
  [
    'a page neither reachable nor free (dropped from the freelist)',
    (b, v) => b.writeUInt16LE(v.freelist().count - 1, v.freelist().off + 10),
    /a page is neither reachable nor free/,
  ],
  [
    'the freelist claims more pages than fit',
    (b, v) => b.writeUInt16LE(5000, v.freelist().off + 10),
    /the freelist lists more pages than fit/,
    ['5000'],
  ],
]) {
  test(`checkDb: structure: ${name} -> refused`, () => {
    refused(damaged(edit), pattern, CTX, unechoed);
  });
}

/** bbolt's meta checksum (FNV-1a 64 over the 56 bytes before it), to forge a consistent meta page. */
function fnv1a64(bytes) {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  return h;
}
const resum = (b, at) => b.writeBigUInt64LE(fnv1a64(b.subarray(at + 16, at + 72)), at + 72);

for (const [name, edit, pattern] of [
  [
    'the meta pages disagree on the page size (both checksums valid)',
    (b, v) => {
      b.writeUInt32LE(8192, v.ps + 24);
      resum(b, v.ps);
    },
    /meta pages disagree on the page size/,
  ],
  [
    'the freelist in its long form, claiming more pages than exist',
    (b, v) => {
      const { off } = v.freelist();
      b.writeUInt16LE(0xffff, off + 10);
      b.writeBigUInt64LE(1n << 40n, off + 16);
    },
    /the freelist lists more pages than exist/,
  ],
  [
    'an inline bucket shorter than a page header',
    (b, v) => b.writeUInt32LE(20, v.at(ALPINE, 'zlib').el + 12),
    /an inline bucket is truncated/,
  ],
]) {
  test(`checkDb: structure: ${name} -> refused`, () => {
    refused(damaged(edit), pattern);
  });
}

test('checkDb: structure: a file shorter than its meta page says -> refused', () => {
  const dir = writeDb(tmp());
  truncateSync(join(dir, 'db/trivy.db'), 3 * 4096);
  reseal(dir);
  refused(dir, /is truncated: shorter than its meta page says/);
});

test('checkDb: structure: one byte short of the pages its meta page counts -> refused', () => {
  const dir = writeDb(tmp());
  const path = join(dir, 'db/trivy.db');
  const { meta, ps } = bolt(readFileSync(path));
  truncateSync(path, meta.pgid * ps - 1);
  reseal(dir);
  refused(dir, /is truncated: shorter than its meta page says/);
});

test('checkDb: structure: an empty or tiny file -> refused', () => {
  refused(writeDb(tmp(), { db: Buffer.alloc(0) }), /meta page 0 is truncated/);
  refused(writeDb(tmp(), { db: Buffer.alloc(100) }), /meta page 0/);
});

test('inspectBolt: every bound refuses just below what the genuine fixture needs (BOLT_LIMITS, tightened)', () => {
  const path = join(FIXTURES, 'real.db');
  const { stats } = inspectBolt(path);
  const size = readFileSync(path).length;
  const find = [[ALPINE, 'zlib', 'CVE-2022-37434']];
  for (const [limits, pattern] of [
    [{ fileBytes: size - 1 }, /is larger than allowed/],
    [{ pageSpanBytes: stats.maxPageSpanBytes - 1 }, /a page is larger than allowed/],
    [{ treeDepth: stats.maxTreeDepth - 1 }, /a bucket tree is too deep/],
    [{ bucketNesting: stats.maxNesting - 1 }, /buckets are nested too deep/],
    [{ elements: stats.elements - 1 }, /has more elements than allowed/],
    [{ foundValueBytes: 10 }, /a canary value is larger than allowed/],
  ]) {
    const r = inspectBolt(path, { limits, find });
    assert.equal(r.ok, false, JSON.stringify(limits));
    assert.match(r.reason, pattern);
  }
  for (const limits of [
    { fileBytes: size },
    { pageSpanBytes: stats.maxPageSpanBytes },
    { treeDepth: stats.maxTreeDepth },
    { bucketNesting: stats.maxNesting },
    { elements: stats.elements },
  ]) {
    assert.equal(inspectBolt(path, { limits, find }).ok, true, JSON.stringify(limits));
  }
  // ... and `limits` can only tighten: a sparse file past the production bound stays refused.
  const big = join(tmp(), 'big.db');
  copyFileSync(path, big);
  truncateSync(big, BOLT_LIMITS.fileBytes + 1);
  const loosened = inspectBolt(big, { limits: { fileBytes: 1e12 } });
  assert.equal(loosened.ok, false);
  assert.match(loosened.reason, /is larger than allowed/);
  assert.equal(BOLT_LIMITS.treeDepth, 12);
});

test('inspectBolt: the production bounds admit the real DB with margin (measured, PR #435 round 3)', () => {
  // The real DB of 2026-10-25 (1.63 GB): 397 943 pages, 7 358 317 elements,
  // tree depth 3, nesting 2, largest page span 479 232 bytes; walked in 3.3 s.
  const real = {
    fileBytes: 1_631_318_016,
    elements: 7_358_317,
    treeDepth: 3,
    bucketNesting: 2,
    pageSpanBytes: 479_232,
  };
  for (const [k, v] of Object.entries(real)) assert.ok(BOLT_LIMITS[k] >= 2 * v, k);
  assert.ok(
    BUDGET.checkMs >= 3 * (3_300 + 6_700),
    'walk + sha256 of the real DB, three times over',
  );
});

test('checkDb: a sha256 that runs past the deadline -> refused (sparse 3 GiB trivy.db: fast walk, slow hash)', () => {
  const dir = writeDb(tmp());
  truncateSync(join(dir, 'db/trivy.db'), 3 * 1024 ** 3); // pages past the high-water mark are not walked
  const started = performance.now();
  refused(dir, /the copy took longer than its time limit/, {
    ...CTX,
    deadline: performance.now() + 300,
  });
  assert.ok(performance.now() - started < 3_000);
});

test('checkDb: an inspection that runs past its deadline -> refused', () => {
  refused(writeDb(tmp()), /took longer than its time limit/, {
    ...CTX,
    deadline: performance.now() - 1,
  });
});

// --- content: what a scan reads must be there (F1, addendum B) ---------------

test('checkDb: content: a valid bbolt file with no buckets -> refused', () => {
  refused(writeDb(tmp(), { db: 'empty' }), /has no bucket "vulnerability"/);
});

test('checkDb: content: every required bucket present but empty (Trivy would scan green) -> refused', () => {
  refused(writeDb(tmp(), { db: 'hollow' }), /has an empty bucket "vulnerability"/);
});

for (const name of REQUIRED_BUCKETS) {
  test(`checkDb: content: no "${name}" bucket -> refused`, () => {
    refused(renameTopLevel(name, `${name.slice(0, -1)}#`), new RegExp(`has no bucket "${name}"`));
  });
}

test('checkDb: content: another Alpine release populated, not the one the images use -> refused', () => {
  assert.deepEqual(ALPINE_RELEASES, ['3.24']);
  refused(renameTopLevel(ALPINE, 'alpine 3.23'), /has no bucket "alpine 3\.24"/);
});

test('checkDb: content: an empty package bucket in a scanned ecosystem (genuine sparse.db) -> refused', () => {
  refused(writeDb(tmp(), { db: 'sparse' }), /has an empty package bucket in "alpine 3\.24"/);
});

for (const { bucket, canary } of ECOSYSTEMS) {
  test(`checkDb: content: ${bucket}: canary advisory ${canary.id} missing -> refused`, () => {
    const to = `${canary.id.slice(0, -1)}${canary.id.endsWith('7') ? '6' : '7'}`;
    refused(
      rename([bucket, canary.pkg, canary.id], to),
      new RegExp(`no canary advisory ${canary.id}`),
    );
  });
  test(`checkDb: content: ${bucket}: canary advisory not a JSON object -> refused`, () => {
    const dir = damaged((buf, v) =>
      buf.write('[', v.at(bucket, canary.pkg, canary.id).valueAt, 'latin1'),
    );
    refused(dir, new RegExp(`no canary advisory ${canary.id}`));
  });
  test(`checkDb: content: ${bucket}: ${canary.id} missing from vulnerability -> refused`, () => {
    const to = `${canary.id.slice(0, -1)}${canary.id.endsWith('7') ? '6' : '7'}`;
    refused(
      rename(['vulnerability', canary.id], to),
      new RegExp(`does not rate ${canary.id} HIGH or CRITICAL`),
    );
  });
  test(`checkDb: content: ${bucket}: ${canary.id} rated below the gate -> refused`, () => {
    const dir = damaged((buf, v) => {
      const el = v.at('vulnerability', canary.id);
      const text = buf.toString('latin1', el.valueAt, el.valueAt + el.vsize);
      const m = /"Severity":"(HIGH|CRITICAL)"/.exec(text);
      assert.ok(m, 'the fixture rates it');
      buf.write(`"Severity":"${'LOW'.padEnd(m[1].length, 'W')}"`, el.valueAt + m.index, 'latin1');
    });
    refused(dir, new RegExp(`does not rate ${canary.id} HIGH or CRITICAL`));
  });
  test(`checkDb: content: ${bucket}: no data-source row -> refused`, () => {
    refused(
      rename(['data-source', bucket], `${bucket.slice(0, -1)}#`),
      /records no data source for/,
    );
  });
}

test('checkDb: a byte changed in a data page (structure intact) -> refused by the sha256', () => {
  const dir = writeDb(tmp());
  const path = join(dir, 'db/trivy.db');
  const buf = readFileSync(path);
  buf[buf.length - 100] ^= 0xff;
  writeFileSync(path, buf);
  assert.equal(inspectBolt(path).ok, true);
  refused(dir, /db\/trivy\.db is not the copy the producer validated/);
});

test('checkDb: metadata.json rewritten after sealing -> refused by the sha256', () => {
  const dir = writeDb(tmp());
  const path = join(dir, 'db/metadata.json');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
  refused(dir, /db\/metadata\.json is not the copy/);
});

// --- addendum C: an inspection error is a refusal, never a crash --------------

test('checkDb: unreadable or misshapen files are refusals (error: true when the inspection itself failed)', () => {
  const asDir = writeDb(tmp(), { db: false });
  mkdirSync(join(asDir, 'db/trivy.db'));
  refused(asDir, /db\/trivy\.db is not a regular file/);

  const metaDir = writeDb(tmp());
  const metaPath = join(metaDir, 'db/metadata.json');
  rmSync(metaPath);
  mkdirSync(metaPath);
  refused(metaDir, /db\/metadata\.json is not a regular file/);

  refused(
    writeDb(tmp(), { meta: `{"Version":2,"x":"${'a'.repeat(70_000)}"}` }),
    /metadata\.json is larger than allowed/,
  );

  const locked = writeDb(tmp());
  chmodSync(join(locked, 'db/trivy.db'), 0);
  const r = refused(locked, /db\/trivy\.db cannot be opened \(EACCES\)/);
  assert.equal(r.error, true);

  const lockedSource = writeDb(tmp());
  chmodSync(join(lockedSource, 'ci-trivy-db-source.json'), 0);
  const s = refused(lockedSource, /the copy could not be inspected \(EACCES\)/);
  assert.equal(s.error, true);
});

// --- metadata and instants (F2, addendum D) -------------------------------------

test('checkDb: the age limit is 24 h on UpdatedAt, inclusive, to the nanosecond', () => {
  const ok = checkDb(
    writeDb(tmp(), { meta: { UpdatedAt: '2026-10-24T06:00:00.000000000Z' } }),
    CTX,
  );
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.ageHours, 24);
  refused(
    writeDb(tmp(), { meta: { UpdatedAt: '2026-10-24T05:59:59.999999999Z' } }),
    /stale: UpdatedAt .* 24\.0 h old, limit 24 h/,
  );
  assert.equal(MAX_AGE_NS, 24n * 3600n * 10n ** 9n);
});

test('checkDb: the future-skew limit is 5 min, inclusive, to the nanosecond', () => {
  const at = '2026-10-25T06:05:00.000000000Z';
  const ok = checkDb(writeDb(tmp(), { meta: { UpdatedAt: at, DownloadedAt: at } }), CTX);
  assert.equal(ok.ok, true, ok.reason);
  refused(
    writeDb(tmp(), { meta: { UpdatedAt: '2026-10-25T06:05:00.000000001Z' } }),
    /UpdatedAt .* is in the future/,
  );
  refused(
    writeDb(tmp(), { meta: { DownloadedAt: '2026-10-25T06:05:00.000000001Z' } }),
    /DownloadedAt .* is in the future/,
  );
  assert.equal(MAX_FUTURE_SKEW_NS, 300n * 10n ** 9n);
});

test("checkDb: Trivy's real nanosecond metadata is accepted", () => {
  // Byte for byte what trivy 0.70.0 wrote on 2026-10-25 (mirror.gcr.io).
  const meta =
    '{"Version":2,"NextUpdate":"2026-10-26T01:20:33.190871941Z","UpdatedAt":"2026-10-25T01:20:33.190884269Z","DownloadedAt":"2026-10-25T06:10:33.477700868Z"}';
  const r = checkDb(writeDb(tmp(), { meta }), { ...CTX, now: new Date('2026-10-25T06:20:00Z') });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.updatedAt, '2026-10-25T01:20:33.190884269Z');
});

test('checkDb: an equivalent offset is the same instant (same age)', () => {
  const z = checkDb(writeDb(tmp(), { meta: { UpdatedAt: '2026-10-25T05:00:00.5Z' } }), CTX);
  const plus = checkDb(writeDb(tmp(), { meta: { UpdatedAt: '2026-10-25T10:30:00.5+05:30' } }), CTX);
  const minus = checkDb(
    writeDb(tmp(), { meta: { UpdatedAt: '2026-10-24T23:00:00.5-06:00' } }),
    CTX,
  );
  for (const r of [z, plus, minus]) assert.equal(r.ok, true, r.reason);
  assert.equal(plus.ageHours, z.ageHours);
  assert.equal(minus.ageHours, z.ageHours);
});

test('parseInstant: strict RFC 3339 with a calendar round-trip', () => {
  const ns = (s) => parseInstant(s);
  assert.equal(ns('2026-10-25T01:20:33.190884269Z'), 1792891233190884269n);
  assert.equal(ns('2026-10-25T06:50:33.190884269+05:30'), 1792891233190884269n);
  assert.equal(ns('2026-10-25T01:20:33Z'), 1792891233000000000n);
  assert.equal(ns('2026-10-25T01:20:33.1Z'), 1792891233100000000n);
  assert.notEqual(ns('2028-02-29T00:00:00Z'), null); // leap year
  for (const bad of [
    '2026-02-30T05:00:00Z', // the review's example: JavaScript would say March 2nd
    '2027-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-10-00T00:00:00Z',
    '2026-10-25T24:00:00Z',
    '2026-10-25T05:60:00Z',
    '2026-10-25T05:00:60Z',
    '2026-10-25T05:00:00+24:00',
    '2026-10-25T05:00:00+05:60',
    '2026-10-25T05:00:00.1234567890Z', // more than nanoseconds
    '2026-10-25t05:00:00z',
    '2026-10-25 05:00:00Z',
    '2026-10-25T05:00:00',
    '2026-10-25T05:00:00+0530',
    ' 2026-10-25T05:00:00Z',
    'yesterday',
    '',
    1761372000,
    null,
    undefined,
  ]) {
    assert.equal(ns(bad), null, String(bad));
  }
});

test('checkDb: a calendar-invalid UpdatedAt (2026-02-30) is refused, not normalised', () => {
  refused(
    writeDb(tmp(), { meta: { UpdatedAt: '2026-02-30T05:00:00Z' } }),
    /UpdatedAt is missing or not a valid RFC 3339 instant \(runner clock/,
    CTX,
    ['2026-02-30'],
  );
});

for (const [name, now] of [
  ['an invalid Date (the r1 NaN clock)', new Date('invalid')],
  ['no clock at all', undefined],
  ['a number instead of a Date', NOW.getTime()],
  ['a string instead of a Date', NOW.toISOString()],
]) {
  test(`checkDb: ${name} -> refused, never "NaN h old"`, () => {
    refused(writeDb(tmp()), /the runner clock is not a valid instant/, { ...CTX, now });
  });
}

for (const [name, meta, pattern] of [
  ['empty cache directory', null, /db\/metadata\.json is missing/],
  ['metadata empty file', '', /not valid JSON/],
  ['metadata is not JSON', '{nope', /not valid JSON/],
  ['metadata is an array', '[]', /db\/metadata\.json is not a JSON object/],
  ['metadata is null', 'null', /db\/metadata\.json is not a JSON object/],
  ['wrong schema version', { Version: 1 }, /Version is not 2/],
  ['schema version as a string', { Version: '2' }, /Version is not 2/],
  ['UpdatedAt missing', { UpdatedAt: undefined }, /UpdatedAt is missing/],
  ['UpdatedAt malformed', { UpdatedAt: 'yesterday' }, /UpdatedAt is missing or not a valid/],
  ['UpdatedAt a number', { UpdatedAt: 1761372000 }, /UpdatedAt is missing or not a valid/],
  ['NextUpdate missing', { NextUpdate: undefined }, /NextUpdate is missing/],
  [
    'NextUpdate calendar-invalid',
    { NextUpdate: '2026-10-32T00:00:00Z' },
    /NextUpdate is missing or not a valid/,
  ],
  [
    'NextUpdate not after UpdatedAt',
    { NextUpdate: iso(-HOUR) },
    /NextUpdate .* is not after UpdatedAt/,
  ],
  ['DownloadedAt missing', { DownloadedAt: undefined }, /DownloadedAt is missing/],
  [
    'UpdatedAt two hours ahead',
    { UpdatedAt: iso(2 * HOUR), NextUpdate: iso(26 * HOUR) },
    /UpdatedAt .* is in the future/,
  ],
  ['stale (28 h)', { UpdatedAt: iso(-28 * HOUR) }, /stale: UpdatedAt .* 28\.0 h old/],
]) {
  test(`checkDb: ${name} -> refused`, () => {
    const dir = tmp();
    if (meta !== null) writeDb(dir, { meta });
    refused(dir, pattern);
  });
}

test('checkDb: NextUpdate in the future does not rescue a stale UpdatedAt', () => {
  refused(
    writeDb(tmp(), { meta: { UpdatedAt: iso(-30 * HOUR), NextUpdate: iso(10 * HOUR) } }),
    /stale/,
  );
});

test('checkDb: trivy.db missing -> refused', () => {
  refused(writeDb(tmp(), { db: false }), /missing .*trivy\.db/);
});

// --- provenance: the expected producer, the fixed allowlist (F4, E, F) ---------

for (const [name, source, pattern] of [
  ['no provenance', false, /not produced by the shared download/],
  [
    'a prefix-matched entry (trivy-db-77-10 restored for trivy-db-77-1)',
    { key: 'trivy-db-77-10', runAttempt: '10' },
    /not published by the producer that key names \(expected trivy-db-77-1\)$/,
  ],
  ['the right key but another attempt', { runAttempt: '2' }, /not published by the producer/],
  ['the right key but another run', { runId: '78' }, /not published by the producer/],
  ['attempt as a number', { runAttempt: 1 }, /not published by the producer/],
  ['no key', { key: undefined }, /not published by the producer/],
  [
    'a repository outside the allowlist',
    { repository: 'evil.example/trivy-db:2' },
    /names a repository that is not one of mirror\.gcr\.io/,
  ],
  ['no repository', { repository: undefined }, /names a repository that is not one of/],
  [
    'an allowed repository with another tag',
    { repository: 'ghcr.io/aquasecurity/trivy-db:1' },
    /names a repository that is not one of/,
  ],
  ['no fetchedAt', { fetchedAt: undefined }, /carries no valid fetchedAt instant/],
  ['a fetchedAt that is not an instant', { fetchedAt: 'yesterday' }, /carries no valid fetchedAt/],
  ['no sha256', { sha256: undefined }, /carries no sha256 for trivy\.db/],
  [
    'a malformed sha256',
    { sha256: { 'trivy.db': 'abc', 'metadata.json': 'abc' } },
    /carries no sha256/,
  ],
]) {
  test(`checkDb: provenance: ${name} -> refused`, () => {
    refused(writeDb(tmp(), { source }), pattern);
  });
}

test('checkDb: refusals never repeat what the provenance or the metadata says (scripts/cli-contract.mjs)', () => {
  const sentinel = 'SENTINEL-c0ffee';
  for (const [source, meta] of [
    [{ key: `trivy-db-77-1${sentinel}` }, undefined],
    [{ runId: sentinel }, undefined],
    [{ repository: sentinel }, undefined],
    [{ fetchedAt: sentinel }, undefined],
    [{}, { Version: sentinel }],
    [{}, { UpdatedAt: sentinel }],
    [{}, { NextUpdate: sentinel }],
    [{}, { DownloadedAt: sentinel }],
  ]) {
    refused(writeDb(tmp(), { source, meta }), /./, CTX, [sentinel]);
  }
});

test('checkDb: provenance file not JSON / not an object -> refused', () => {
  const dir = writeDb(tmp());
  writeFileSync(join(dir, 'ci-trivy-db-source.json'), '{');
  refused(dir, /ci-trivy-db-source\.json is not valid JSON/);
  writeFileSync(join(dir, 'ci-trivy-db-source.json'), '[]');
  refused(dir, /ci-trivy-db-source\.json is not a JSON object/);
});

test('checkDb: ghcr.io is as acceptable as the mirror', () => {
  assert.equal(checkDb(writeDb(tmp(), { source: { repository: GHCR } }), CTX).ok, true);
});

test('the expected producer comes from the key: a consumer on attempt 2 accepts producer attempt 1', () => {
  const dir = writeDb(tmp());
  const r = checkDb(dir, { now: NOW, key: KEY, run: { id: '77', attempt: '2' } });
  assert.equal(r.ok, true, r.reason);
  // ... and NOT what its own attempt number would name.
  refused(dir, /expected trivy-db-77-2/, {
    now: NOW,
    key: 'trivy-db-77-2',
    run: { id: '77', attempt: '2' },
  });
});

for (const [name, key, run, pattern] of [
  ['a key from another run', 'trivy-db-78-1', RUN, /belongs to run 78, this is run 77/],
  [
    'a key naming a later attempt',
    'trivy-db-77-3',
    { id: '77', attempt: '2' },
    /attempt 3, later than this job's attempt 2/,
  ],
  ['an empty key', '', RUN, /is not trivy-db-<run>-<attempt>/],
  ['no key', undefined, RUN, /is not trivy-db-<run>-<attempt>/],
  ['a key with a suffix', 'trivy-db-77-1x', RUN, /is not trivy-db/],
  ['a key with a leading zero', 'trivy-db-77-01', RUN, /is not trivy-db/],
  ['a job without its run id', KEY, { attempt: '1' }, /does not know its own run id/],
  ['a job without its attempt', KEY, { id: '77' }, /does not know its own run id/],
  ['no run at all', KEY, undefined, /does not know its own run id/],
]) {
  test(`checkDb: ${name} -> refused`, () => {
    refused(writeDb(tmp()), pattern, { now: NOW, key, run });
  });
}

test('expectedProducer: compares attempts as numbers, not strings', () => {
  assert.equal(expectedProducer('trivy-db-77-9', { id: '77', attempt: '10' }).ok, true);
  assert.equal(expectedProducer('trivy-db-77-10', { id: '77', attempt: '9' }).ok, false);
});

// --- the producer: fetchDb against a stub trivy -------------------------------

/**
 * A stub `trivy` (a real executable) that behaves per repository as `plan`
 * says, the last step repeating, and records every call. Download steps:
 *   ok | stale | r1 | hollow | empty | sparse | dir | unreadable | meta-unreadable
 *   | sparse-huge (the real fixture, sparse-extended to 3 GiB)
 *   | nothing | fail | hang
 * Canary steps (a good DB, then the `rootfs` canary scan goes wrong):
 *   blind | blind-alpine | blind-cargo | lowsev | wrong-os | huge | garbage | canary-hang
 * `hang` ignores SIGTERM and never exits. The canary records what the canary
 * root holds, so a test can compare it with what Trivy really detected.
 */
function stubTrivy(plan) {
  const dir = tmp();
  const stub = join(dir, 'trivy');
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  writeFileSync(
    stub,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const fixtures = ${JSON.stringify(FIXTURES)};
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const record = (o) => fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify({ ...o, args, pid: process.pid }) + '\\n');
const hang = () => {
  process.on('SIGTERM', () => fs.appendFileSync(path.join(dir, 'sigterm'), process.pid + '\\n'));
  setTimeout(() => process.exit(9), 30000); // a bound for when the code under test forgets to kill
};
const cache = arg('--cache-dir');
if (args[0] === 'rootfs') {
  const step = fs.readFileSync(path.join(dir, 'last-step'), 'utf8');
  const root = args.at(-1);
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  record({ canary: true, step, root: {
    release: read('etc/alpine-release'),
    apk: read('lib/apk/db/installed'),
    npm: JSON.parse(read('app/node_modules/lodash/package.json')),
    cargo: read('app/Cargo.lock'),
  } });
  if (!fs.existsSync(path.join(cache, 'db/trivy.db'))) { console.error('no DB'); process.exit(1); }
  if (step === 'canary-hang') return hang();
  if (step === 'huge') return process.stdout.write('x'.repeat(5 * 1024 * 1024), () => process.exit(0));
  if (step === 'garbage') return process.stdout.write('not a report', () => process.exit(0));
  const v = (PkgName, VulnerabilityID, Severity) => ({ PkgName, VulnerabilityID, Severity });
  const results = [
    { Target: 'x (alpine 3.24.0)', Type: 'alpine', Vulnerabilities: step === 'blind-alpine' ? [] : [v('zlib', 'CVE-2022-37434', 'CRITICAL')] },
    { Target: 'Node.js', Type: 'node-pkg', Vulnerabilities: [v('lodash', 'CVE-2021-23337', step === 'lowsev' ? 'LOW' : 'HIGH')] },
    { Target: 'app/Cargo.lock', Type: 'cargo', Vulnerabilities: step === 'blind-cargo' ? [] : [v('tokio', 'CVE-2021-45710', 'HIGH')] },
  ];
  const os = { Family: 'alpine', Name: step === 'wrong-os' ? '3.23.0' : '3.24.0' };
  process.stdout.write(JSON.stringify({ Metadata: { OS: os }, Results: step === 'blind' ? [] : results }));
  process.exit(0);
}
const repo = arg('--db-repository');
const seen = fs.existsSync(path.join(dir, 'calls'))
  ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').split('\\n').filter(Boolean).map(JSON.parse).filter((c) => c.repo === repo).length
  : 0;
const steps = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'))[repo];
const step = steps[Math.min(seen, steps.length - 1)];
record({ repo, step });
fs.writeFileSync(path.join(dir, 'last-step'), step);
if (step === 'fail') { console.error(${JSON.stringify(E404)}); process.exit(1); }
if (step === 'hang') return hang();
if (step === 'nothing') process.exit(0);
fs.mkdirSync(path.join(cache, 'db'), { recursive: true });
const now = Date.now();
const at = (h) => new Date(now + h * 3600000).toISOString();
const updated = step === 'stale' ? -30 : -1;
fs.writeFileSync(path.join(cache, 'db/metadata.json'), JSON.stringify({ Version: 2, NextUpdate: at(updated + 24), UpdatedAt: at(updated), DownloadedAt: at(0) }));
const db = path.join(cache, 'db/trivy.db');
if (step === 'r1') { const b = Buffer.alloc(2 * 1024 * 1024); b.writeUInt32LE(0xed0cdaed, 16); fs.writeFileSync(db, b); }
else if (step === 'dir') fs.mkdirSync(db);
else fs.copyFileSync(path.join(fixtures, (['hollow', 'empty', 'sparse'].includes(step) ? step : 'real') + '.db'), db);
if (step === 'unreadable') fs.chmodSync(db, 0);
if (step === 'meta-unreadable') fs.chmodSync(path.join(cache, 'db/metadata.json'), 0);
if (step === 'sparse-huge') fs.truncateSync(db, 3 * 1024 ** 3);
`,
  );
  chmodSync(stub, 0o755);
  const calls = () =>
    existsSync(join(dir, 'calls'))
      ? readFileSync(join(dir, 'calls'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  return {
    dir,
    stub,
    calls,
    repos: () =>
      calls()
        .filter((c) => !c.canary)
        .map((c) => c.repo),
    sigterms: () =>
      existsSync(join(dir, 'sigterm'))
        ? readFileSync(join(dir, 'sigterm'), 'utf8').trim().split('\n')
        : [],
  };
}

/** Fast test budget: same shape as production, milliseconds instead of minutes. */
const FAST = Object.freeze({
  repositoryWindowMs: 20_000,
  attemptMs: 10_000,
  canaryMs: 10_000,
  killGraceMs: 200,
  minAttemptMs: 100,
  validationMs: 10_000,
  checkMs: 10_000,
  packMs: 10_000,
  unpackMs: 10_000,
});
const fetchWith = (trivy, extra = {}) => {
  const cacheDir = join(tmp(), 'trivy-db');
  const lines = [];
  return fetchDb(cacheDir, {
    run: RUN,
    trivy: trivy.stub,
    backoffMs: [0, 0],
    budget: FAST,
    log: (l) => lines.push(l),
    ...extra,
  }).then((result) => ({ result, cacheDir, lines }));
};
const realClockCtx = () => ({ now: new Date(), key: KEY, run: RUN });

test('fetch: the first repository works -> one download, one canary scan, sealed and accepted', async () => {
  const t = stubTrivy({ [GCR]: ['ok'], [GHCR]: ['ok'] });
  const { result, cacheDir, lines } = await fetchWith(t);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.key, KEY);
  assert.deepEqual(t.repos(), [GCR]);
  const [download, canary, ...more] = t.calls();
  assert.deepEqual(more, []); // one Alpine release, one canary scan
  assert.deepEqual(download.args.slice(0, 3), ['image', '--download-db-only', '--no-progress']);
  assert.equal(download.args[download.args.indexOf('--timeout') + 1], '9s');
  assert.equal(canary.canary, true);
  assert.equal(canary.args[0], 'rootfs');
  for (const flag of [
    '--skip-db-update',
    '--offline-scan',
    '--cache-backend',
    '--skip-java-db-update',
  ]) {
    assert.ok(canary.args.includes(flag), flag);
  }
  // Exactly the root real trivy 0.70.0 reported all three canaries for (PR #435 round 3).
  assert.deepEqual(canary.root, {
    release: '3.24.0\n',
    apk: 'P:zlib\nV:1.2.12-r0\n\n',
    npm: { name: 'lodash', version: '4.17.20' },
    cargo:
      'version = 3\n\n[[package]]\nname = "tokio"\nversion = "1.8.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
  });
  assert.match(lines.join('\n'), /canaries CVE-2022-37434, CVE-2021-23337, CVE-2021-45710 found/);
  const source = JSON.parse(readFileSync(join(cacheDir, 'ci-trivy-db-source.json'), 'utf8'));
  assert.equal(source.key, KEY);
  assert.equal(source.sha256['trivy.db'], sha256(join(FIXTURES, 'real.db')));
  assert.equal(checkDb(cacheDir, realClockCtx()).ok, true);
});

test('fetch: the observed failure (404 on the mirror layer) is retried, then ghcr.io is used', async () => {
  const t = stubTrivy({ [GCR]: ['fail'], [GHCR]: ['ok'] });
  const { result, cacheDir } = await fetchWith(t);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(t.repos(), [GCR, GCR, GCR, GHCR]);
  assert.equal(
    JSON.parse(readFileSync(join(cacheDir, 'ci-trivy-db-source.json'), 'utf8')).repository,
    GHCR,
  );
});

test('fetch: a transient failure on the first attempt is retried on the same repository', async () => {
  const t = stubTrivy({ [GCR]: ['fail', 'ok'], [GHCR]: ['ok'] });
  const { result } = await fetchWith(t);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(t.repos(), [GCR, GCR]);
});

for (const [name, step, pattern] of [
  [
    "the review's counterexample (magic only, version 0)",
    'r1',
    /meta page 0 is not format version 2/,
  ],
  ['a valid bbolt file with no buckets', 'empty', /has no bucket "vulnerability"/],
  ['a hollow DB (buckets present, empty)', 'hollow', /has an empty bucket/],
  ['a DB with an empty package bucket', 'sparse', /has an empty package bucket in "alpine 3\.24"/],
  ['a stale copy', 'stale', /vulnerability DB is stale/],
  [
    'a DB in which Trivy finds no canary',
    'blind',
    /Trivy found no CVE-2022-37434 in zlib 1\.2\.12-r0 \(alpine\)/,
  ],
  ['a DB in which Trivy finds no Alpine advisory', 'blind-alpine', /Trivy found no CVE-2022-37434/],
  [
    'a DB in which Trivy finds no Rust advisory',
    'blind-cargo',
    /Trivy found no CVE-2021-45710 in tokio 1\.8\.0 \(cargo\)/,
  ],
  [
    'a DB that rates the npm canary LOW',
    'lowsev',
    /Trivy does not rate CVE-2021-23337 HIGH or CRITICAL/,
  ],
  ['a canary scan that sees another Alpine release', 'wrong-os', /did not detect Alpine 3\.24/],
  [
    'a canary scan that prints without bound',
    'huge',
    /the canary scan printed more than allowed and was stopped/,
  ],
  ['a canary scan that prints no report', 'garbage', /the canary scan printed no JSON report/],
  ['trivy exits 0 and writes nothing', 'nothing', /db\/metadata\.json is missing/],
  ['trivy.db that is a directory', 'dir', /db\/trivy\.db is not a regular file/],
  ['trivy.db that cannot be read', 'unreadable', /db\/trivy\.db cannot be opened \(EACCES\)/],
  [
    'metadata.json that cannot be read (the inspection throws)',
    'meta-unreadable',
    /could not be inspected \(EACCES\)/,
  ],
]) {
  test(`fetch: ${name} from the mirror is a failed attempt; ghcr.io is tried and used`, async () => {
    const t = stubTrivy({ [GCR]: [step], [GHCR]: ['ok'] });
    const { result, lines } = await fetchWith(t);
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(t.repos(), [GCR, GCR, GCR, GHCR]);
    assert.match(lines.join('\n'), new RegExp(`downloaded copy (rejected: )?.*${pattern.source}`));
  });
}

test('fetch: a hollow copy never reaches the canary (cheap checks first)', async () => {
  const t = stubTrivy({ [GCR]: ['hollow'], [GHCR]: ['ok'] });
  await fetchWith(t);
  assert.deepEqual(
    t
      .calls()
      .filter((c) => c.canary)
      .map((c) => c.step),
    ['ok'],
  );
});

for (const step of ['fail', 'r1', 'hollow', 'blind']) {
  test(`fetch: ${step} on both repositories -> exhausted after 6 bounded attempts, nothing left behind`, async () => {
    const t = stubTrivy({ [GCR]: [step], [GHCR]: [step] });
    const { result, cacheDir } = await fetchWith(t);
    assert.equal(result.ok, false);
    assert.deepEqual(t.repos(), [GCR, GCR, GCR, GHCR, GHCR, GHCR]);
    assert.match(result.reason, /no repository yielded a usable DB/);
    assert.equal(existsSync(cacheDir), false);
  });
}

test("fetch: a failed attempt never inherits the previous attempt's files", async () => {
  const t = stubTrivy({ [GCR]: ['nothing'], [GHCR]: ['nothing'] });
  const cacheDir = writeDb(join(tmp(), 'trivy-db'), { base: new Date() }); // a good leftover
  const result = await fetchDb(cacheDir, {
    run: RUN,
    trivy: t.stub,
    backoffMs: [0, 0],
    budget: FAST,
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(existsSync(cacheDir), false);
});

test('fetch: the trivy binary missing -> bounded attempts, refused, the path not repeated', async () => {
  const { result } = await fetchWith({ stub: join(tmp(), 'no-such-trivy') });
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not run trivy \(ENOENT\)/);
  assert.doesNotMatch(result.reason, /no-such-trivy/);
});

test('fetch: a copy whose sealing sha256 overruns BUDGET.validationMs is a failed attempt', async () => {
  const t = stubTrivy({ [GCR]: ['sparse-huge'], [GHCR]: ['ok'] });
  const { result, lines } = await fetchWith(t, { budget: { ...FAST, validationMs: 1_500 } });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.repository, GHCR);
  assert.match(
    lines.join('\n'),
    /attempt 1\/3: downloaded copy rejected: the copy took longer than its time limit/,
  );
});

test('fetch: a copy whose in-process checks overrun BUDGET.validationMs is a failed attempt', async () => {
  const t = stubTrivy({ [GCR]: ['ok'], [GHCR]: ['ok'] });
  const { result } = await fetchWith(t, { budget: { ...FAST, validationMs: 0 } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /took longer than its time limit/);
  assert.deepEqual(t.repos(), [GCR, GCR, GCR, GHCR, GHCR, GHCR]);
  assert.equal(t.calls().filter((c) => c.canary).length, 0); // stopped before the canary
});

test('fetch: a producer that does not know its run refuses before downloading', async () => {
  const t = stubTrivy({ [GCR]: ['ok'], [GHCR]: ['ok'] });
  for (const run of [
    undefined,
    { id: '77' },
    { id: '', attempt: '1' },
    { id: '77', attempt: '0' },
  ]) {
    const { result } = await fetchWith(t, { run });
    assert.equal(result.ok, false);
    assert.match(result.reason, /does not know its run id and attempt/);
  }
  assert.deepEqual(t.calls(), []);
});

test('fetch: a non-finite clock refuses the copy (and so every attempt)', async () => {
  const t = stubTrivy({ [GCR]: ['ok'], [GHCR]: ['ok'] });
  const { result } = await fetchWith(t, { now: () => new Date('invalid') });
  assert.equal(result.ok, false);
  assert.match(result.reason, /the runner clock is not a valid instant/);
});

// --- F3 / addendum C: deadlines, kill escalation, the ghcr.io window ------------

const alive = (pid) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};

test(
  'runBounded: a child that ignores SIGTERM gets SIGKILL at its deadline, with its process group',
  { timeout: 20_000 },
  async () => {
    const dir = tmp();
    const script = `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(join(dir, 'pids'))}, process.pid + ' ' + g.pid);
    process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(join(dir, 'term'))}, 'ignored'));
    setTimeout(() => process.exit(9), 30000);`;
    const started = performance.now();
    const r = await runBounded(process.execPath, ['-e', script], {
      limitMs: 1500,
      graceMs: 500,
      env: process.env,
    });
    const elapsed = performance.now() - started;
    assert.equal(r.timedOut, true);
    assert.equal(r.signal, 'SIGKILL');
    assert.equal(readFileSync(join(dir, 'term'), 'utf8'), 'ignored'); // SIGTERM came first
    assert.ok(elapsed >= 1400 && elapsed < 2500, `${elapsed} ms`);
    await new Promise((r2) => setTimeout(r2, 100));
    for (const pid of readFileSync(join(dir, 'pids'), 'utf8').split(' '))
      assert.equal(alive(pid), false, pid);
  },
);

test('runBounded: a child that exits in time is not signalled', async () => {
  const r = await runBounded(process.execPath, ['-e', 'process.exit(3)'], {
    limitMs: 5000,
    graceMs: 500,
    env: process.env,
  });
  assert.deepEqual([r.status, r.timedOut], [3, false]);
});

/** A leader (node) that starts a descendant ignoring SIGTERM, with closed stdio; both pids written to `pids`. */
const leaderWithStubbornChild = (dir, leaderOnTerm) => `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(join(dir, 'pids'))}, process.pid + ' ' + g.pid);
    ${leaderOnTerm}
    setTimeout(() => process.exit(9), 30000);`;
const waitFor = async (file) => {
  for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 20));
};

test(
  'runBounded (r2 R2-2): a leader that exits on SIGTERM does not cancel the SIGKILL its descendant needs',
  { timeout: 20_000 },
  async () => {
    const dir = tmp();
    const script = leaderWithStubbornChild(dir, "process.on('SIGTERM', () => process.exit(0));");
    const started = performance.now();
    const r = await runBounded(process.execPath, ['-e', script], {
      limitMs: 1500,
      graceMs: 500,
      env: process.env,
    });
    const elapsed = performance.now() - started;
    assert.equal(r.timedOut, true);
    assert.equal(r.status, 0); // the leader went on SIGTERM ...
    assert.ok(elapsed >= 1400, `${elapsed} ms: settled only after the SIGKILL`);
    await new Promise((r2) => setTimeout(r2, 100));
    const [leader, child] = readFileSync(join(dir, 'pids'), 'utf8').split(' ');
    assert.equal(alive(leader), false);
    assert.equal(alive(child), false, 'the SIGTERM-ignoring descendant was killed with the group');
  },
);

test(
  "runBounded (r2 R2-2, the review's Bash reproduction): leader exits on SIGTERM, its sleep ignores it",
  { timeout: 20_000 },
  async () => {
    const pidFile = join(tmp(), 'pid');
    const script = `(trap '' TERM; exec sleep 30) </dev/null >/dev/null 2>&1 & echo $! > '${pidFile}'; trap 'exit 0' TERM; while :; do sleep 0.1; done`;
    const r = await runBounded('bash', ['-c', script], {
      limitMs: 1500,
      graceMs: 500,
      env: process.env,
    });
    assert.equal(r.timedOut, true);
    await new Promise((r2) => setTimeout(r2, 100));
    assert.equal(alive(readFileSync(pidFile, 'utf8').trim()), false, 'the descendant was killed');
  },
);

test(
  'runBounded: a leader that exits on its own leaves nothing of its group behind',
  { timeout: 20_000 },
  async () => {
    const dir = tmp();
    const script = leaderWithStubbornChild(dir, 'setTimeout(() => process.exit(0), 200);');
    const r = await runBounded(process.execPath, ['-e', script], {
      limitMs: 10_000,
      graceMs: 500,
      env: process.env,
    });
    assert.deepEqual([r.status, r.timedOut], [0, false]);
    await new Promise((r2) => setTimeout(r2, 100));
    const [, child] = readFileSync(join(dir, 'pids'), 'utf8').split(' ');
    assert.equal(alive(child), false);
  },
);

test(
  'runBounded: captured output is bounded; one byte over stops the child (addendum D)',
  { timeout: 20_000 },
  async () => {
    const r = await runBounded(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(4096)); setTimeout(() => {}, 30000)"],
      { limitMs: 10_000, graceMs: 500, env: process.env, stdout: 'pipe', captureLimit: 4095 },
    );
    assert.equal(r.overflow, true);
    assert.equal(r.stopped, true);
    assert.ok(r.stdout.length <= 4095);
    const ok = await runBounded(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(4096))"],
      {
        limitMs: 10_000,
        graceMs: 500,
        env: process.env,
        stdout: 'pipe',
        captureLimit: 4096,
      },
    );
    assert.deepEqual([ok.status, ok.overflow, ok.stdout.length], [0, false, 4096]);
  },
);

test(
  'startBounded: stop() kills the whole group at once (a refusal)',
  { timeout: 20_000 },
  async () => {
    const dir = tmp();
    const run = startBounded(
      process.execPath,
      ['-e', leaderWithStubbornChild(dir, "process.on('SIGTERM', () => {});")],
      {
        limitMs: 10_000,
        graceMs: 2_000,
        env: process.env,
      },
    );
    await waitFor(join(dir, 'pids'));
    const started = performance.now();
    run.stop();
    const r = await run.result;
    assert.ok(performance.now() - started < 1_000);
    assert.deepEqual([r.stopped, r.timedOut, r.signal], [true, false, 'SIGKILL']);
    await new Promise((r2) => setTimeout(r2, 100));
    for (const pid of readFileSync(join(dir, 'pids'), 'utf8').split(' '))
      assert.equal(alive(pid), false, pid);
  },
);

test(
  'fetch: a mirror that never answers (ignores SIGTERM) cannot keep ghcr.io from its window',
  { timeout: 20_000 },
  async () => {
    const t = stubTrivy({ [GCR]: ['hang'], [GHCR]: ['ok'] });
    const budget = {
      ...FAST,
      repositoryWindowMs: 2_000,
      attemptMs: 1_200,
      killGraceMs: 300,
      minAttemptMs: 500,
    };
    const started = performance.now();
    const { result, lines } = await fetchWith(t, { budget });
    const elapsed = performance.now() - started;
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.repository, GHCR);
    // The mirror's window (2 s) held: one 1.2 s attempt, a second capped at what was left.
    assert.deepEqual(t.repos(), [GCR, GCR, GHCR]);
    assert.ok(elapsed < 2 * budget.repositoryWindowMs + 1_000, `${elapsed} ms`);
    assert.equal(t.sigterms().length, 2); // asked politely, then killed
    for (const c of t.calls().filter((x) => x.step === 'hang')) assert.equal(alive(c.pid), false);
    assert.match(lines.join('\n'), /did not finish within its deadline and was killed/);
    // Trivy's own --timeout is set below the hard deadline.
    const first = t.calls()[0].args;
    assert.equal(first[first.indexOf('--timeout') + 1], '1s');
  },
);

test(
  'fetch: both repositories hanging -> refused within the total budget',
  { timeout: 20_000 },
  async () => {
    const t = stubTrivy({ [GCR]: ['hang'], [GHCR]: ['hang'] });
    const budget = {
      ...FAST,
      repositoryWindowMs: 1_500,
      attemptMs: 1_000,
      killGraceMs: 200,
      minAttemptMs: 400,
    };
    const started = performance.now();
    const { result } = await fetchWith(t, { budget });
    const elapsed = performance.now() - started;
    assert.equal(result.ok, false);
    assert.ok(elapsed < 2 * budget.repositoryWindowMs + 1_000, `${elapsed} ms`);
    assert.ok(t.repos().includes(GHCR));
  },
);

test(
  'fetch: a canary that hangs is killed and counts as a failed attempt',
  { timeout: 20_000 },
  async () => {
    const t = stubTrivy({ [GCR]: ['canary-hang'], [GHCR]: ['ok'] });
    const budget = {
      ...FAST,
      repositoryWindowMs: 2_500,
      canaryMs: 800,
      killGraceMs: 200,
      minAttemptMs: 300,
    };
    const { result, lines } = await fetchWith(t, { budget });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.repository, GHCR);
    assert.match(lines.join('\n'), /the canary scan did not finish within its deadline/);
  },
);

test('fetch: a retry is not started when its backoff would leave too little of the window', async () => {
  const t = stubTrivy({ [GCR]: ['fail'], [GHCR]: ['ok'] });
  const budget = { ...FAST, repositoryWindowMs: 1_000, minAttemptMs: 500 };
  const { result, lines } = await fetchWith(t, { budget, backoffMs: [800, 800] });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(t.repos(), [GCR, GHCR]);
  assert.match(lines.join('\n'), /attempt 2\/3: not started/);
});

// --- the CLI: production policy only (F2) --------------------------------------

function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1', ...env },
  });
}
/** The r1 test knobs; the CLI must ignore every one of them. */
const DEAD_KNOBS = {
  CI_TRIVY_DB_NOW: 'invalid',
  CI_TRIVY_DB_REPOSITORIES: 'evil.example/trivy-db:2',
  CI_TRIVY_BIN: '/bin/false',
  CI_TRIVY_DB_BACKOFF: '0 0',
};

test('CLI check: a fresh sealed copy passes and prints the evidence line', () => {
  const dir = writeDb(tmp(), { base: new Date() });
  const r = cli(['check', dir, KEY]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /^trivy-db: shared copy ok - trivy-db-77-1 from repository mirror\.gcr\.io\/aquasec\/trivy-db:2, fetched by run 77 attempt 1 .*\(1\.0 h old, limit 24 h\), 5 buckets, sha256 verified\n$/,
  );
});

test('CLI check: the r1 clock override is dead (NaN clock no longer accepts, no stale copy is rescued)', () => {
  const fresh = writeDb(tmp(), { base: new Date() });
  const a = cli(['check', fresh, KEY], DEAD_KNOBS);
  assert.equal(a.status, 0, a.stderr);
  assert.doesNotMatch(a.stdout, /NaN/);
  const old = new Date(Date.now() - 30 * HOUR);
  const stale = writeDb(tmp(), { base: old });
  const b = cli(['check', stale, KEY], { CI_TRIVY_DB_NOW: old.toISOString() });
  assert.equal(b.status, 1);
  assert.match(b.stderr, /::error::trivy-db: vulnerability DB is stale/);
});

test('CLI check: a consumer on a later attempt accepts the earlier producer named by the key', () => {
  const dir = writeDb(tmp(), { base: new Date() });
  assert.equal(cli(['check', dir, KEY], { GITHUB_RUN_ATTEMPT: '2' }).status, 0);
});

for (const [name, env, pattern] of [
  ['no GITHUB_RUN_ID', { GITHUB_RUN_ID: '' }, /does not know its own run id/],
  ['another run', { GITHUB_RUN_ID: '78' }, /belongs to run 77, this is run 78/],
]) {
  test(`CLI check: ${name} -> exit 1`, () => {
    const r = cli(['check', writeDb(tmp(), { base: new Date() }), KEY], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, pattern);
  });
}

test('CLI refusals never repeat a path, an unmatched key or an archive member (scripts/cli-contract.mjs)', () => {
  const sentinel = 'SENTINEL-c0ffee';
  const dir = join(tmp(), sentinel);
  const named = hostileTar([ustar(`trivy-db/${sentinel}`, '0', 'x')]);
  const existing = join(tmp(), sentinel);
  mkdirSync(existing);
  for (const r of [
    cli(['check', dir, KEY]), // nothing there
    cli(['check', writeDb(dir, { db: r1Counterexample(), base: new Date() }), KEY]),
    cli(['check', dir, `trivy-db-77-1${sentinel}`]),
    cli(['check', dir, sentinel]),
    cli(['pack', join(tmp(), sentinel), join(tmp(), sentinel, 'a.tar.zst')]),
    cli(['pack', writeDb(join(tmp(), sentinel), { base: new Date() }), existing]), // EEXIST
    cli(['unpack', join(tmp(), sentinel), join(tmp(), sentinel)]),
    cli(['unpack', named, join(tmp(), sentinel)]),
  ]) {
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /^::error::trivy-db: /);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(sentinel));
  }
});

test('CLI check: restore miss (empty directory) -> exit 1', () => {
  const r = cli(['check', tmp(), KEY]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /db\/metadata\.json is missing/);
});

test('CLI fetch: fixed repositories and binary (`trivy` on PATH), knobs ignored, key published', () => {
  const t = stubTrivy({ [GCR]: ['ok'], [GHCR]: ['ok'], 'evil.example/trivy-db:2': ['ok'] });
  const out = join(tmp(), 'github-output');
  writeFileSync(out, '');
  const cacheDir = join(tmp(), 'trivy-db');
  const r = cli(['fetch', cacheDir], {
    ...DEAD_KNOBS,
    PATH: `${t.dir}:${process.env.PATH}`,
    GITHUB_OUTPUT: out,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.repos(), [GCR]);
  assert.equal(readFileSync(out, 'utf8'), 'key=trivy-db-77-1\n');
  const d = t.calls()[0].args;
  assert.equal(
    d[d.indexOf('--timeout') + 1],
    `${(BUDGET.attemptMs - 2 * BUDGET.killGraceMs) / 1000}s`,
  );
  assert.equal(cli(['check', cacheDir, 'trivy-db-77-1']).status, 0);
});

test('CLI fetch: without GITHUB_OUTPUT nothing is downloaded and it exits 1', () => {
  const t = stubTrivy({ [GCR]: ['ok'], [GHCR]: ['ok'] });
  const r = cli(['fetch', join(tmp(), 'x')], { PATH: `${t.dir}:${process.env.PATH}` });
  assert.equal(r.status, 1);
  assert.deepEqual(t.calls(), []);
});

test('CLI: usage errors exit 2', () => {
  for (const args of [
    ['bogus', '/x'],
    ['check', '/x'],
    ['check'],
    ['fetch'],
    ['fetch', '/x', KEY],
    ['check', '/x', KEY, 'more'],
    ['pack', '/x'],
    ['pack', '/x', '/y', '/z'],
    ['unpack', '/x'],
    ['unpack', '/x', ''],
    ['toString', '/x'],
  ]) {
    assert.equal(spawnSync(process.execPath, [CLI, ...args]).status, 2, args.join(' '));
  }
});

test('no test knob anywhere: the CLI reads only the run identity, the library reads no environment', () => {
  const cliSource = readFileSync(CLI, 'utf8');
  const reads = [...cliSource.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(reads)].sort(), [
    'GITHUB_OUTPUT',
    'GITHUB_RUN_ATTEMPT',
    'GITHUB_RUN_ID',
  ]);
  assert.doesNotMatch(cliSource, /process\.env\[|CI_TRIVY/);
  const lib = readFileSync(LIB, 'utf8');
  // The only mentions pass the job's environment through to children (trivy, zstd), as defaults.
  const mentions = [...lib.matchAll(/process\.env/g)].length;
  assert.equal(mentions, 3);
  assert.equal([...lib.matchAll(/\benv = process\.env\b(?![.[])/g)].length, mentions);
  assert.doesNotMatch(lib, /CI_TRIVY/);
});

test('the production policy is frozen', () => {
  assert.deepEqual(
    [...REPOSITORIES],
    ['mirror.gcr.io/aquasec/trivy-db:2', 'ghcr.io/aquasecurity/trivy-db:2'],
  );
  for (const frozen of [
    REPOSITORIES,
    BUDGET,
    BOLT_LIMITS,
    ECOSYSTEMS,
    ARCHIVE,
    ARCHIVE.members,
    SCANNED_BASES,
  ]) {
    assert.ok(Object.isFrozen(frozen));
  }
  for (const e of ECOSYSTEMS) assert.ok(Object.isFrozen(e) && Object.isFrozen(e.canary));
});

// --- the workflow and the composite ------------------------------------------------

const workflowText = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const workflow = parseYaml(workflowText);
const composite = parseYaml(
  readFileSync(join(ROOT, '.github/actions/restore-trivy-db/action.yml'), 'utf8'),
);
const SCANS = [
  ['containers', 'rasta/${{ matrix.service }}:${{ github.sha }}', '.trivyignore.services'],
  ['clamav-signatures', 'rasta/clamav-pinned:ci', '.trivyignore.clamav'],
];
const stepIndex = (job, pred) => workflow.jobs[job].steps.findIndex(pred);
const compositeStep = (name) => composite.runs.steps.find((s) => s.name === name);
const PRE_SCAN_CHECK = 'node scripts/ci-trivy-db.mjs check "$TRIVY_DB_DIR" "$TRIVY_DB_KEY"';
const UNPACK_RUN = 'node scripts/ci-trivy-db.mjs unpack "$ARCHIVE_DIR" "$TRIVY_DB_DIR"';
const PACK_RUN = 'node scripts/ci-trivy-db.mjs pack "$TRIVY_DB_DIR" "$TRIVY_DB_ARCHIVE"';

for (const [job, image, ignores] of SCANS) {
  const steps = workflow.jobs[job].steps;
  const scanAt = stepIndex(job, (s) => s.uses?.startsWith('aquasecurity/trivy-action@'));

  test(`${job}: the gate is exactly as strict as before`, () => {
    const scan = steps[scanAt];
    assert.equal(scan.with['image-ref'], image);
    assert.equal(scan.with.severity, 'CRITICAL,HIGH');
    assert.equal(scan.with['exit-code'], '1');
    assert.equal(scan.with['ignore-unfixed'], true);
    assert.equal(scan.with.trivyignores, ignores);
    assert.equal(scan['continue-on-error'], undefined);
    assert.equal(scan.if, undefined);
    assert.equal(scan.with['skip-dirs'], undefined);
    assert.equal(scan.with['skip-files'], undefined);
    assert.equal(scan.with.scanners, undefined);
    assert.equal(scan.with['vuln-type'], undefined);
  });

  test(`${job}: the scan uses only the restored DB and cannot restore or download its own`, () => {
    const scan = steps[scanAt];
    assert.equal(scan.env.TRIVY_SKIP_DB_UPDATE, 'true');
    assert.equal(scan.with.cache, 'false');
    assert.equal(scan.with['skip-setup-trivy'], 'true');
    assert.equal(scan.with['cache-dir'], '${{ steps.trivy-db.outputs.dir }}');
    // The Java DB stays on demand: analyzer coverage is what it was.
    assert.equal(scan.env.TRIVY_SKIP_JAVA_DB_UPDATE, undefined);
  });

  test(`${job}: restored and checked from a full checkout before Trivy exists; re-checked with the key right before the scan`, () => {
    const checkoutAt = stepIndex(job, (s) => s.uses?.startsWith('actions/checkout@'));
    const restoreAt = stepIndex(job, (s) => s.uses === './.github/actions/restore-trivy-db');
    const installAt = stepIndex(job, (s) => s.uses?.startsWith('aquasecurity/setup-trivy@'));
    assert.ok(
      checkoutAt >= 0 && checkoutAt < restoreAt && restoreAt < installAt && installAt < scanAt,
    );
    assert.equal(steps[checkoutAt].with?.['sparse-checkout'], undefined);
    assert.equal(steps[restoreAt].id, 'trivy-db');
    assert.equal(steps[restoreAt].with.key, '${{ needs.trivy-db.outputs.key }}');
    assert.equal(steps[installAt].with.version, '${{ env.TRIVY_VERSION }}');
    const check = steps[scanAt - 1];
    assert.equal(check.run, PRE_SCAN_CHECK);
    assert.deepEqual(check.env, {
      TRIVY_DB_DIR: '${{ steps.trivy-db.outputs.dir }}',
      TRIVY_DB_KEY: '${{ needs.trivy-db.outputs.key }}',
    });
    assert.ok(workflow.jobs[job].needs.includes('trivy-db'));
  });

  test(`${job}: a failed or skipped download fails the scan job, it does not skip it`, () => {
    const cond = String(workflow.jobs[job].if);
    assert.match(cond, /!cancelled\(\)/);
    assert.doesNotMatch(cond, /success\(\)|always\(\)/);
    // the download's result is NOT among the conditions: that is what keeps the job running.
    assert.doesNotMatch(cond, /needs\.trivy-db/);
  });
}

test('containers: every job it already waited for is still required to have succeeded', () => {
  const cond = String(workflow.jobs.containers.if);
  const others = workflow.jobs.containers.needs.filter(
    (n) => n !== 'trivy-db' && n !== 'container-scope',
  );
  assert.deepEqual(others, [
    'quality',
    'security',
    'integration',
    'migration-reversibility',
    'e2e',
  ]);
  for (const n of [...others, 'container-scope']) {
    assert.ok(cond.includes(`needs.${n}.result == 'success'`), n);
  }
  assert.ok(cond.includes("needs.container-scope.outputs.services != '[]'"));
});

test('the Alpine releases the DB must cover are those of every scanned image (addendum B)', () => {
  // Every service image's runtime stage (its last FROM), and the ClamAV pin.
  const bases = new Set();
  const services = readdirSync(join(ROOT, 'services'), { withFileTypes: true }).filter((d) =>
    existsSync(join(ROOT, 'services', d.name, 'Dockerfile')),
  );
  assert.equal(services.length, 17);
  for (const d of services) {
    const froms = [
      ...readFileSync(join(ROOT, 'services', d.name, 'Dockerfile'), 'utf8').matchAll(
        /^FROM\s+(\S+)/gm,
      ),
    ];
    bases.add(froms.at(-1)[1]);
  }
  const clamav = /clamav\/clamav:[\w.]+@sha256:[0-9a-f]{64}/.exec(
    workflow.jobs['clamav-signatures'].steps.map((s) => s.run ?? '').join('\n'),
  );
  assert.ok(clamav, 'the ClamAV pin');
  bases.add(clamav[0]);
  assert.deepEqual([...bases].sort(), Object.keys(SCANNED_BASES).sort());
  assert.deepEqual(ALPINE_RELEASES, [...new Set(Object.values(SCANNED_BASES))].sort());
  assert.deepEqual(
    ECOSYSTEMS.filter((e) => e.type === 'alpine').map((e) => e.bucket),
    ALPINE_RELEASES.map((r) => `alpine ${r}`),
  );
  assert.deepEqual(
    ECOSYSTEMS.map((e) => e.type),
    [...ALPINE_RELEASES.map(() => 'alpine'), 'node-pkg', 'cargo'],
  );
});

const producerStep = (pred) => workflow.jobs['trivy-db'].steps.find(pred);
const PACK = () => producerStep((s) => s.name === 'Pack the DB');
const UPLOAD = () => producerStep((s) => s.uses?.startsWith('actions/upload-artifact@'));

test('trivy-db job: no needs, pinned Trivy, the key comes from the validated fetch and names the artifact', () => {
  const job = workflow.jobs['trivy-db'];
  assert.equal(job.needs, undefined);
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job.outputs.key, '${{ steps.fetch.outputs.key }}');
  const fetch = producerStep((s) => s.id === 'fetch');
  assert.equal(fetch.run, 'node scripts/ci-trivy-db.mjs fetch "$TRIVY_DB_DIR"');
  // No step but the validated fetch may write the key.
  assert.equal(job.steps.filter((s) => /GITHUB_OUTPUT/.test(s.run ?? '')).length, 0);
  const names = job.steps.map((s) => s.name ?? s.uses);
  assert.ok(names.indexOf(PACK().name) > names.indexOf(fetch.name));
  assert.equal(PACK().run, PACK_RUN);
  const upload = UPLOAD();
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/);
  assert.match(workflowText, new RegExp(`uses: ${upload.uses} # v4\\n`));
  assert.equal(upload.with.name, '${{ steps.fetch.outputs.key }}');
  assert.equal(upload.with.path, PACK().env.TRIVY_DB_ARCHIVE);
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with.overwrite, undefined);
  for (const s of [PACK(), upload]) assert.equal(s.if, undefined); // only after a successful fetch
  // actions/cache is gone from the transport: run 40191748744 lost its entry to eviction.
  assert.equal(job.steps.filter((s) => s.uses?.startsWith('actions/cache')).length, 0);
  assert.equal(
    producerStep((s) => s.uses?.startsWith('aquasecurity/setup-trivy@')).with.version,
    '${{ env.TRIVY_VERSION }}',
  );
  assert.equal(workflow.env.TRIVY_VERSION, 'v0.70.0');
});

test('trivy-db job: the time budget fits the step and job limits (F3 arithmetic, addendum A)', () => {
  const job = workflow.jobs['trivy-db'];
  const limits = job.steps.map((s) => s['timeout-minutes']);
  assert.ok(
    limits.every((m) => Number.isInteger(m) && m > 0),
    'every step has its own limit',
  );
  assert.ok(limits.reduce((a, b) => a + b, 0) <= job['timeout-minutes']);
  const fetch = producerStep((s) => s.id === 'fetch');
  const fetchWorstMs = REPOSITORIES.length * (BUDGET.repositoryWindowMs + BUDGET.validationMs);
  assert.ok(fetchWorstMs <= fetch['timeout-minutes'] * 60_000, `${fetchWorstMs} ms`);
  assert.ok(BUDGET.packMs + 2 * BUDGET.killGraceMs <= PACK()['timeout-minutes'] * 60_000);
  assert.ok(
    BUDGET.attemptMs + BUDGET.minAttemptMs <= BUDGET.repositoryWindowMs,
    'a retry fits a window',
  );
  assert.ok(
    BUDGET.attemptMs - 2 * BUDGET.killGraceMs >= 60_000,
    "Trivy's own timeout stays generous",
  );
  assert.ok(BUDGET.canaryMs * ALPINE_RELEASES.length <= BUDGET.validationMs);
});

test('trivy-db job: the sparse checkout holds every file the fetch imports (addendum B)', () => {
  const sparse = workflow.jobs['trivy-db'].steps[0].with['sparse-checkout']
    .trim()
    .split('\n')
    .sort();
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const source = readFileSync(join(ROOT, rel), 'utf8');
    for (const [, spec] of source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm)) {
      if (spec.startsWith('node:')) continue;
      assert.ok(
        spec.startsWith('./'),
        `${rel} imports ${spec}: only node built-ins and local files`,
      );
      visit(join(dirname(rel), spec));
    }
  };
  visit('scripts/ci-trivy-db.mjs');
  assert.deepEqual([...seen].sort(), sparse);
});

test('the DB lives outside the checkout, at one path for producer and consumers (no build context carries it)', () => {
  const job = workflow.jobs['trivy-db'];
  assert.equal(
    producerStep((s) => s.id === 'fetch').env.TRIVY_DB_DIR,
    '${{ runner.temp }}/trivy-db',
  );
  assert.deepEqual(PACK().env, {
    TRIVY_DB_DIR: '${{ runner.temp }}/trivy-db',
    TRIVY_DB_ARCHIVE: '${{ runner.temp }}/trivy-db.tar.zst',
  });
  const where = compositeStep('Require the key of the shared Trivy DB');
  assert.match(where.run, /echo "dir=\$RUNNER_TEMP\/trivy-db" >> "\$GITHUB_OUTPUT"/);
  assert.match(where.run, /echo "archive=\$RUNNER_TEMP\/trivy-db-artifact" >> "\$GITHUB_OUTPUT"/);
  assert.equal(composite.outputs.dir.value, '${{ steps.where.outputs.dir }}');
  const text = readFileSync(join(ROOT, '.github/actions/restore-trivy-db/action.yml'), 'utf8');
  assert.doesNotMatch(text, /github\.workspace/);
  assert.doesNotMatch(JSON.stringify(job), /github\.workspace/);
});

/** Runs one workflow or composite step's real script with the given env; returns status and output. */
function runStep(step, env) {
  const out = join(tmp(), 'github-output');
  writeFileSync(out, '');
  const r = spawnSync('bash', ['-e', '-c', step.run], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, RUNNER_TEMP: '/runner/_temp', ...env },
  });
  return { ...r, output: readFileSync(out, 'utf8') };
}
const UNPACK = () => compositeStep("Unpack exactly the producer's archive");
const sh = (script, cwd) => {
  const r = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

/** Packs `dir` (a cache directory) with the producer's real pack step; returns the artifact directory. */
function packed(dir) {
  const artifact = tmp();
  const r = runStep(PACK(), { TRIVY_DB_DIR: dir, TRIVY_DB_ARCHIVE: join(artifact, ARCHIVE.file) });
  assert.equal(r.status, 0, r.stderr);
  return artifact;
}
const unpack = (artifact, target = join(tmp(), 'trivy-db')) => ({
  target,
  ...runStep(UNPACK(), { ARCHIVE_DIR: artifact, TRIVY_DB_DIR: target }),
});

/** One hand-made ustar header + data (512-byte padded); `edit(header)` may damage the header. */
function ustar(name, type, data = '', { edit, size } = {}) {
  const body = Buffer.from(data);
  const h = Buffer.alloc(512);
  h.write(name, 0, 'latin1');
  h.write(type === '5' ? '0000755\0' : '0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${(size ?? body.length).toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h[156] = type.charCodeAt(0);
  h.write('ustar\u000000', 257, 'latin1');
  edit?.(h);
  h.write('        ', 148);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
const END = Buffer.alloc(1024);
/** zstd-compresses `parts` (Buffers) into a fresh artifact directory. */
function hostileTar(parts, name = ARCHIVE.file) {
  const artifact = tmp();
  const r = spawnSync('zstd', ['-q', '-c'], { input: Buffer.concat(parts), maxBuffer: 1 << 26 });
  assert.equal(r.status, 0);
  writeFileSync(join(artifact, name), r.stdout);
  return artifact;
}
/** The producer's five members of a sealed fixture copy, as ustar parts (as packDb writes them). */
function goodMembers() {
  const dir = writeDb(tmp(), { base: new Date() });
  return [
    ustar('trivy-db/', '5'),
    ustar(
      'trivy-db/ci-trivy-db-source.json',
      '0',
      readFileSync(join(dir, 'ci-trivy-db-source.json')),
    ),
    ustar('trivy-db/db/', '5'),
    ustar('trivy-db/db/metadata.json', '0', readFileSync(join(dir, 'db/metadata.json'))),
    ustar('trivy-db/db/trivy.db', '0', readFileSync(join(dir, 'db/trivy.db'))),
  ];
}
/** GNU tar run in a fresh directory after `build`, compressed into an artifact. */
function gnuTar(build, tarArgs) {
  const work = tmp();
  sh(build, work);
  const artifact = tmp();
  sh(`tar -cf - ${tarArgs} | zstd -q -o "${artifact}/${ARCHIVE.file}"`, work);
  return { artifact, work };
}

test('restore action: key first, then the exact artifact of this run, unpacked by the one admission, then the check', () => {
  const [where, download, unpackStep, check] = composite.runs.steps;
  assert.equal(where.name, 'Require the key of the shared Trivy DB');
  assert.match(download.uses, /^actions\/download-artifact@[0-9a-f]{40}$/);
  assert.match(
    readFileSync(join(ROOT, '.github/actions/restore-trivy-db/action.yml'), 'utf8'),
    new RegExp(`uses: ${download.uses} # v4\\.3\\.0\\n`),
  );
  // Exact name, this run, one directory: no pattern, no other run, no merging.
  assert.deepEqual(download.with, {
    name: '${{ inputs.key }}',
    path: '${{ steps.where.outputs.archive }}',
  });
  assert.equal(download['continue-on-error'], undefined);
  assert.equal(unpackStep, UNPACK());
  assert.equal(unpackStep.run, UNPACK_RUN);
  assert.deepEqual(unpackStep.env, {
    ARCHIVE_DIR: '${{ steps.where.outputs.archive }}',
    TRIVY_DB_DIR: '${{ steps.where.outputs.dir }}',
  });
  assert.equal(check.run, PRE_SCAN_CHECK);
  assert.deepEqual(check.env, {
    TRIVY_DB_DIR: '${{ steps.where.outputs.dir }}',
    TRIVY_DB_KEY: '${{ inputs.key }}',
  });
  for (const s of composite.runs.steps) assert.equal(s.if, undefined, s.name);
  assert.equal(composite.runs.steps.filter((s) => s.uses?.startsWith('actions/cache')).length, 0);
  // No shell pipeline decides admission any more (r2 R2-1: `grep -q` + pipefail failed open).
  for (const s of composite.runs.steps) assert.doesNotMatch(s.run ?? '', /\||tar |zstd /, s.name);

  const empty = runStep(where, { KEY: '' });
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /::error::The trivy-db job published no database/);
  assert.equal(empty.output, '');
  const set = runStep(where, { KEY: KEY });
  assert.equal(set.status, 0);
  assert.equal(set.output, 'dir=/runner/_temp/trivy-db\narchive=/runner/_temp/trivy-db-artifact\n');
});

test('pack -> unpack -> check, the real step scripts end to end: the sealed copy arrives intact', () => {
  const target = join(tmp(), 'trivy-db');
  mkdirSync(target);
  writeFileSync(join(target, 'stale-leftover'), 'x');
  const r = unpack(packed(writeDb(tmp(), { base: new Date() })), target);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^trivy-db: archive admitted, \d+ bytes unpacked\n$/);
  assert.equal(existsSync(join(target, 'stale-leftover')), false); // replaced, not merged
  assert.deepEqual(readdirSync(dirname(target)), ['trivy-db']); // no quarantine left behind
  const check = runStep(compositeStep('Check the restored Trivy DB'), {
    TRIVY_DB_DIR: target,
    TRIVY_DB_KEY: KEY,
    GITHUB_RUN_ID: '77',
    GITHUB_RUN_ATTEMPT: '2', // a re-run consumer accepts producer attempt 1
  });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /shared copy ok - trivy-db-77-1 .* sha256 verified/);
});

test('packDb writes genuine ustar: GNU tar lists exactly the five members, in order, and nothing else', () => {
  const artifact = packed(writeDb(tmp(), { base: new Date() }));
  const listing = sh(`zstd -dc "${join(artifact, ARCHIVE.file)}" | tar -tvf -`)
    .trim()
    .split('\n');
  assert.deepEqual(
    listing.map((l) => l.split(/\s+/).at(-1)),
    ARCHIVE.members.map((m) => m.name),
  );
  for (const [i, l] of listing.entries()) assert.equal(l[0], ARCHIVE.members[i].dir ? 'd' : '-', l);
  // Our own parse of GNU tar's identical layout (`--format=ustar`, same order) is admitted too.
  const dir = writeDb(tmp(), { base: new Date() });
  const parent = tmp();
  sh(`cp -r "${dir}" "${parent}/trivy-db"`);
  const art = tmp();
  sh(
    `tar --format=ustar --owner=0 --group=0 -C "${parent}" -cf - --no-recursion trivy-db/ trivy-db/ci-trivy-db-source.json trivy-db/db/ trivy-db/db/metadata.json trivy-db/db/trivy.db | zstd -q -o "${art}/${ARCHIVE.file}"`,
  );
  assert.equal(unpack(art).status, 0);
});

for (const [name, setup, pattern] of [
  [
    'a directory that holds something else',
    (d) => writeFileSync(join(d, 'extra'), 'x'),
    /holds something other than the DB/,
  ],
  [
    'a trivy.db that is a symlink',
    (d) => {
      rmSync(join(d, 'db/trivy.db'));
      symlinkSync(join(FIXTURES, 'real.db'), join(d, 'db/trivy.db'));
    },
    /could not be written \(ELOOP\)/,
  ],
  [
    'a metadata.json that is a directory',
    (d) => {
      rmSync(join(d, 'db/metadata.json'));
      mkdirSync(join(d, 'db/metadata.json'));
    },
    /not a regular file within its limit/,
  ],
]) {
  test(`packDb: ${name} -> refused, no archive`, async () => {
    const dir = writeDb(tmp(), { base: new Date() });
    setup(dir);
    const out = join(tmp(), ARCHIVE.file);
    const r = await packDb(dir, out);
    assert.equal(r.ok, false);
    assert.match(r.reason, pattern);
    assert.equal(existsSync(out), false);
  });
}

test('packDb: a file over its member limit -> refused, no archive', async () => {
  const dir = writeDb(tmp(), {
    base: new Date(),
    meta: `{"Version":2,"x":"${'a'.repeat(70_000)}"}`,
  });
  const out = join(tmp(), ARCHIVE.file);
  const r = await packDb(dir, out);
  assert.match(r.reason, /not a regular file within its limit/);
  assert.equal(existsSync(out), false);
});

/** A stand-in `zstd`: `script` is its node body. */
function stubZstd(script) {
  const dir = tmp();
  const stub = join(dir, 'zstd');
  writeFileSync(
    stub,
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst dir = ${JSON.stringify(dir)};\n${script}\n`,
  );
  chmodSync(stub, 0o755);
  return { dir, stub };
}

for (const [name, script, pattern] of [
  [
    'a compressor that exits early',
    'process.exit(0);',
    /the compressor stopped|could not be written/,
  ],
  [
    'a compressor that fails',
    "process.stdin.resume(); process.stdin.on('end', () => process.exit(1));",
    /could not be written: the compressor exited 1/,
  ],
  [
    'a compressor that hangs (ignores SIGTERM)',
    "fs.writeFileSync(dir + '/pid', String(process.pid)); process.on('SIGTERM', () => {}); process.stdin.resume(); setTimeout(() => {}, 30000);",
    /could not be written: the compressor did not finish within its deadline/,
  ],
]) {
  test(`packDb: ${name} -> refused, no archive`, { timeout: 20_000 }, async () => {
    const z = stubZstd(script);
    const out = join(tmp(), ARCHIVE.file);
    const r = await packDb(writeDb(tmp(), { base: new Date() }), out, {
      zstd: z.stub,
      budget: { ...FAST, packMs: 800, killGraceMs: 200 },
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, pattern);
    assert.equal(existsSync(out), false);
    if (existsSync(join(z.dir, 'pid')))
      assert.equal(alive(readFileSync(join(z.dir, 'pid'), 'utf8')), false);
  });
}

test('packDb: never overwrites an existing archive', async () => {
  const out = join(tmp(), ARCHIVE.file);
  writeFileSync(out, 'earlier');
  const r = await packDb(writeDb(tmp(), { base: new Date() }), out);
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not be written \(EEXIST\)/);
  assert.equal(readFileSync(out, 'utf8'), 'earlier');
});

for (const [name, artifact] of [
  ['an empty artifact', () => tmp()],
  [
    'a second file beside the archive',
    () => {
      const a = packed(writeDb(tmp(), { base: new Date() }));
      writeFileSync(join(a, 'zz-extra'), 'x'); // sorts after the archive
      return a;
    },
  ],
  [
    'a hidden second file',
    () => {
      const a = packed(writeDb(tmp(), { base: new Date() }));
      writeFileSync(join(a, '.extra'), 'x');
      return a;
    },
  ],
  ['the archive under another name', () => hostileTar(goodMembers().concat(END), 'db.tar.zst')],
  [
    'the archive as a symlink',
    () => {
      const a = packed(writeDb(tmp(), { base: new Date() }));
      const b = tmp();
      symlinkSync(join(a, ARCHIVE.file), join(b, ARCHIVE.file));
      return b;
    },
  ],
  [
    'the archive as a directory',
    () => {
      const a = tmp();
      mkdirSync(join(a, ARCHIVE.file));
      return a;
    },
  ],
]) {
  test(`restore action: ${name} -> refused before unpacking`, () => {
    const r = unpack(artifact());
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /::error::trivy-db: the downloaded artifact is not exactly trivy-db\.tar\.zst/,
    );
    assert.equal(existsSync(r.target), false);
  });
}

/** Unpacks `artifact` with the real step; asserts a refusal matching `pattern` and that nothing escaped. */
function refusedArchive(artifact, pattern, unechoed = []) {
  const parent = tmp();
  const target = join(parent, 'trivy-db');
  mkdirSync(target);
  writeFileSync(join(target, 'earlier-copy'), 'x');
  const started = performance.now();
  const r = unpack(artifact, target);
  const elapsed = performance.now() - started;
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, pattern);
  for (const value of unechoed) assert.doesNotMatch(r.stderr + r.stdout, new RegExp(value));
  assert.deepEqual(
    readdirSync(parent),
    [],
    'nothing unpacked, nothing beside it, no quarantine, no earlier copy',
  );
  return { r, elapsed };
}

// R2-1 (round 2): a forbidden entry first, then 20,000 regular entries, with
// real GNU tar listings. The round-2 shell admission accepted all five
// (`grep -q` exited early, printf got SIGPIPE, pipefail returned 141).
const MANY = 'mkdir -p trivy-db && for i in $(seq -w 1 20000); do : > trivy-db/f$i; done';
for (const [name, build, first] of [
  ['a symlink', `${MANY} && ln -s /etc trivy-db/aaa`, 'trivy-db/aaa'],
  ['a FIFO', `${MANY} && mkfifo trivy-db/aaa`, 'trivy-db/aaa'],
  [
    'a path climbing out (..)',
    `${MANY} && echo x > evil`,
    "--transform='s|^evil$|trivy-db/../evil|' evil",
  ],
  ['an absolute path', `${MANY} && echo x > evil`, '--absolute-names "$PWD/evil"'],
  ['another top-level path', `${MANY} && mkdir other && echo x > other/f`, 'other/f'],
]) {
  test(
    `unpack (r2 R2-1): ${name} first, then 20,000 regular entries -> refused, nothing unpacked`,
    { timeout: 60_000 },
    () => {
      const { artifact } = gnuTar(build, `--no-recursion ${first} trivy-db trivy-db/f*`);
      const listing = sh(`zstd -dc "${join(artifact, ARCHIVE.file)}" | tar -tf - | wc -l`);
      assert.ok(Number(listing) > 20_000);
      refusedArchive(artifact, /holds a member that is not the next one the producer writes/);
    },
  );
}

for (const [name, parts, pattern] of [
  [
    'the right members, then a duplicate of trivy.db',
    () => [...goodMembers(), goodMembers()[4], END],
    /holds more members than the producer writes/,
  ],
  ['trivy-db/ twice', () => [goodMembers()[0], ...goodMembers(), END], /not the next one/],
  [
    'an alias: ./trivy-db/',
    () => [ustar('./trivy-db/', '5'), ...goodMembers().slice(1), END],
    /not the next one/,
  ],
  [
    'an alias: trivy-db//db/',
    () => [
      ...goodMembers().slice(0, 2),
      ustar('trivy-db//db/', '5'),
      ...goodMembers().slice(3),
      END,
    ],
    /not the next one/,
  ],
  [
    'a directory without its slash',
    () => [ustar('trivy-db', '5'), ...goodMembers().slice(1), END],
    /not the next one/,
  ],
  [
    'a file with a trailing slash',
    () => [...goodMembers().slice(0, 4), ustar('trivy-db/db/trivy.db/', '0', 'x'), END],
    /not the next one/,
  ],
  [
    'trivy.db as a directory (file/directory collision)',
    () => [...goodMembers().slice(0, 4), ustar('trivy-db/db/trivy.db', '5'), END],
    /not the next one/,
  ],
  [
    'a hard link where a file belongs',
    () => [
      ...goodMembers().slice(0, 4),
      ustar('trivy-db/db/trivy.db', '1', '', { edit: (h) => h.write('/etc/passwd', 157) }),
      END,
    ],
    /not the next one/,
  ],
  [
    'a regular file carrying a link name',
    () => [
      ...goodMembers().slice(0, 4),
      ustar('trivy-db/db/trivy.db', '0', '', { edit: (h) => h.write('/etc', 157) }),
      END,
    ],
    /not the next one/,
  ],
  [
    'a symlink where a file belongs',
    () => [
      ...goodMembers().slice(0, 4),
      ustar('trivy-db/db/trivy.db', '2', '', { edit: (h) => h.write('/etc', 157) }),
      END,
    ],
    /not the next one/,
  ],
  [
    'a pax header renaming the next member',
    () => [ustar('PaxHeader', 'x', '19 path=../../evil\n'), ...goodMembers(), END],
    /not the next one/,
  ],
  [
    'a global pax header',
    () => [ustar('pax_global_header', 'g', '19 path=../../evil\n'), ...goodMembers(), END],
    /not the next one/,
  ],
  [
    'a GNU long name',
    () => [ustar('././@LongLink', 'L', `trivy-db/${'a'.repeat(200)}\0`), ...goodMembers(), END],
    /not the next one/,
  ],
  [
    'the right name with a prefix field',
    () => [
      ustar('trivy-db/', '5', '', { edit: (h) => h.write('evil', 345) }),
      ...goodMembers().slice(1),
      END,
    ],
    /not the next one/,
  ],
  [
    'GNU magic instead of ustar',
    () => [
      ustar('trivy-db/', '5', '', { edit: (h) => h.write('ustar  \0', 257, 'latin1') }),
      ...goodMembers().slice(1),
      END,
    ],
    /not the next one/,
  ],
  [
    'a damaged header checksum',
    () => {
      const first = goodMembers()[0];
      first[140] = 0x31; // the mtime, which only the checksum covers
      return [first, ...goodMembers().slice(1), END];
    },
    /not the next one/,
  ],
  [
    'a base-256 size',
    () => [
      ...goodMembers().slice(0, 3),
      ustar('trivy-db/db/metadata.json', '0', '{}', {
        edit: (h) => {
          h.fill(0, 124, 136);
          h[124] = 0x80;
          h[135] = 2;
        },
      }),
      ...goodMembers().slice(4),
      END,
    ],
    /holds a member whose size is not plain octal/,
  ],
  [
    'a directory with a size',
    () => [ustar('trivy-db/', '5', 'x'), ...goodMembers().slice(1), END],
    /holds a member larger than allowed/,
  ],
  [
    'metadata.json over its limit',
    () => [
      ...goodMembers().slice(0, 3),
      ustar('trivy-db/db/metadata.json', '0', 'x'.repeat(70_000)),
      ...goodMembers().slice(4),
      END,
    ],
    /holds a member larger than allowed/,
  ],
  [
    'data in the padding',
    () => {
      const m = goodMembers();
      const meta = m[3];
      meta[meta.length - 1] = 0x41;
      return [...m.slice(0, 3), meta, m[4], END];
    },
    /carries data in its padding/,
  ],
  ['no end blocks', () => goodMembers(), /has no proper end/],
  [
    'the end too early',
    () => [...goodMembers().slice(0, 3), END],
    /ends before the last member the producer writes/,
  ],
  [
    'a member cut short',
    () => {
      const m = goodMembers();
      return [...m.slice(0, 4), m[4].subarray(0, 512 + 4096)];
    },
    /ends before the last member/,
  ],
  [
    '20,000 more members after the right five',
    () => [
      ...goodMembers(),
      ...Array.from({ length: 20_000 }, (_, i) => ustar(`trivy-db/f${i}`, '0')),
      END,
    ],
    /holds more members than the producer writes/,
  ],
  [
    'data after the end',
    () => [...goodMembers(), END, Buffer.alloc(512, 1)],
    /holds more members than the producer writes/,
  ],
]) {
  test(`unpack: an archive with ${name} -> refused, nothing unpacked`, { timeout: 60_000 }, () => {
    refusedArchive(hostileTar(parts()), pattern);
  });
}

test('unpack: a size bomb (trivy.db declared at 8 GiB) is refused at its header, before any data', () => {
  const bomb = [
    ...goodMembers().slice(0, 4),
    ustar('trivy-db/db/trivy.db', '0', '', { size: 8 * 1024 ** 3 - 1 }),
  ];
  const { elapsed } = refusedArchive(hostileTar(bomb), /holds a member larger than allowed/);
  assert.ok(elapsed < 5_000, `${elapsed} ms`);
});

test(
  'unpack: a decompression bomb (1 GiB of zeroes after the end) is cut off, not decompressed',
  { timeout: 60_000 },
  () => {
    const artifact = tmp();
    const head = spawnSync('zstd', ['-q', '-c'], {
      input: Buffer.concat([...goodMembers(), END]),
    }).stdout;
    const zeros = sh('head -c 1073741824 /dev/zero | zstd -q -c --no-progress | base64 -w0');
    writeFileSync(
      join(artifact, ARCHIVE.file),
      Buffer.concat([head, Buffer.from(zeros, 'base64')]),
    );
    const started = performance.now();
    refusedArchive(artifact, /carries data after its end/);
    assert.ok(performance.now() - started < 4_000, 'stopped long before 1 GiB was inflated');
  },
);

test('unpack: an artifact larger than ARCHIVE.maxArchiveBytes -> refused before decompressing', () => {
  const artifact = tmp();
  writeFileSync(join(artifact, ARCHIVE.file), '');
  truncateSync(join(artifact, ARCHIVE.file), ARCHIVE.maxArchiveBytes + 1); // sparse
  refusedArchive(artifact, /the downloaded archive is larger than allowed/);
});

test('unpack: a truncated or damaged archive -> refused (the decompressor fails)', () => {
  const good = packed(writeDb(tmp(), { base: new Date() }));
  const path = join(good, ARCHIVE.file);
  truncateSync(path, Math.floor(readFileSync(path).length / 2));
  refusedArchive(good, /the archive is damaged or truncated: the decompressor exited 1/);
  const garbage = tmp();
  writeFileSync(join(garbage, ARCHIVE.file), 'not zstd at all');
  refusedArchive(garbage, /damaged or truncated/);
});

test('unpackDb: an inspection error is a refusal marked error, distinct from a clean refusal', async () => {
  const good = packed(writeDb(tmp(), { base: new Date() }));
  const missing = await unpackDb(good, join(tmp(), 'trivy-db'), { zstd: join(tmp(), 'no-zstd') });
  assert.deepEqual([missing.ok, missing.error], [false, true]);
  assert.match(missing.reason, /could not be unpacked: could not run the decompressor \(ENOENT\)/);
  const locked = tmp();
  chmodSync(locked, 0);
  const denied = await unpackDb(locked, join(tmp(), 'trivy-db'));
  chmodSync(locked, 0o700);
  assert.deepEqual([denied.ok, denied.error], [false, true]);
  assert.match(denied.reason, /could not be unpacked \(EACCES\)/);
  const clean = await unpackDb(tmp(), join(tmp(), 'trivy-db'));
  assert.deepEqual([clean.ok, clean.error], [false, undefined]);
});

test(
  'unpackDb: a refusal kills the decompressor at once, long before its deadline',
  { timeout: 20_000 },
  async () => {
    // Emits a header that is not the producer's, then writes forever and ignores SIGTERM.
    const z = stubZstd(
      "fs.writeFileSync(dir + '/pid', String(process.pid)); process.on('SIGTERM', () => {}); process.stdout.write(Buffer.alloc(512, 0x41)); setInterval(() => process.stdout.write(Buffer.alloc(65536)), 1);",
    );
    const good = packed(writeDb(tmp(), { base: new Date() }));
    const started = performance.now();
    const r = await unpackDb(good, join(tmp(), 'trivy-db'), {
      zstd: z.stub,
      budget: { ...FAST, unpackMs: 10_000, killGraceMs: 2_000 },
    });
    assert.ok(performance.now() - started < 1_500, `${performance.now() - started} ms`);
    assert.match(r.reason, /holds a member that is not the next one/);
    assert.equal(alive(readFileSync(join(z.dir, 'pid'), 'utf8')), false);
  },
);

test(
  'unpackDb: a decompressor that hangs is killed at the deadline (with its group) and refused',
  { timeout: 20_000 },
  async () => {
    const dir = tmp();
    const stub = join(dir, 'zstd');
    writeFileSync(
      stub,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => {}, 30000);\n`,
    );
    chmodSync(stub, 0o755);
    const good = packed(writeDb(tmp(), { base: new Date() }));
    const target = join(tmp(), 'trivy-db');
    const started = performance.now();
    const r = await unpackDb(good, target, {
      zstd: stub,
      budget: { ...FAST, unpackMs: 800, killGraceMs: 200 },
    });
    assert.ok(performance.now() - started < 3_000);
    assert.deepEqual([r.ok, r.error], [false, true]);
    assert.match(r.reason, /the decompressor did not finish within its deadline and was killed/);
    assert.equal(alive(readFileSync(join(dir, 'pid'), 'utf8')), false);
    assert.equal(existsSync(target), false);
  },
);

test('restore action, scripted end to end: a copy sealed for another producer is refused by the check', () => {
  // The artifact name is exact, so this needs a wrong upload; the provenance still catches it.
  const target = join(tmp(), 'trivy-db');
  const sealed = writeDb(tmp(), {
    base: new Date(),
    source: { key: 'trivy-db-77-10', runAttempt: '10' },
  });
  assert.equal(unpack(packed(sealed), target).status, 0);
  const check = runStep(compositeStep('Check the restored Trivy DB'), {
    TRIVY_DB_DIR: target,
    TRIVY_DB_KEY: KEY,
    GITHUB_RUN_ID: '77',
    GITHUB_RUN_ATTEMPT: '10',
  });
  assert.equal(check.status, 1);
  assert.match(
    check.stderr,
    /not published by the producer that key names \(expected trivy-db-77-1\)/,
  );
});

test('no Trivy scan anywhere in the workflow lets trivy-action download or cache its own DB', () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.uses?.startsWith('aquasecurity/trivy-action@')) continue;
      assert.equal(step.env?.TRIVY_SKIP_DB_UPDATE, 'true', `${name} scan step`);
      assert.equal(step.with.cache, 'false', `${name} scan step`);
    }
  }
});

test('every use of the CLI in the workflow and composite is one of its fixed forms', () => {
  const runs = [
    ...Object.values(workflow.jobs).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? '')),
    ...composite.runs.steps.map((s) => s.run ?? ''),
  ].filter((r) => r.includes('ci-trivy-db.mjs'));
  // fetch, pack, the composite's unpack and check, two pre-scan checks
  assert.equal(runs.length, 6);
  for (const r of runs) {
    assert.ok(
      [
        PRE_SCAN_CHECK,
        UNPACK_RUN,
        PACK_RUN,
        'node scripts/ci-trivy-db.mjs fetch "$TRIVY_DB_DIR"',
      ].includes(r),
      r,
    );
  }
});
