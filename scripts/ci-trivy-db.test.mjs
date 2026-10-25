import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  BUDGET,
  checkDb,
  expectedProducer,
  fetchDb,
  inspectBolt,
  MAX_AGE_NS,
  MAX_FUTURE_SKEW_NS,
  parseInstant,
  REPOSITORIES,
  REQUIRED_BUCKETS,
  runBounded,
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

const tmp = () => mkdtempSync(join(tmpdir(), 'ci-trivy-db-'));
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

/** Offset of the root bucket's page in a bbolt file (current meta = higher txid). */
function rootPageOffset(buf) {
  const ps = buf.readUInt32LE(24);
  const metas = [0, ps].map((at) => ({
    root: buf.readBigUInt64LE(at + 32),
    txid: buf.readBigUInt64LE(at + 64),
  }));
  const meta = metas[1].txid > metas[0].txid ? metas[1] : metas[0];
  return { ps, at: Number(meta.root) * ps };
}

/** Writes the real fixture with `edit(buffer)` applied, provenance re-sealed. */
function damaged(edit) {
  const dir = writeDb(tmp());
  const path = join(dir, 'db/trivy.db');
  const buf = readFileSync(path);
  edit(buf);
  writeFileSync(path, buf);
  reseal(dir);
  return dir;
}

/** Renames a top-level bucket in place (same length), keeping the file structurally valid. */
function renameTopLevel(from, to) {
  assert.equal(from.length, to.length);
  return damaged((buf) => {
    const { at } = rootPageOffset(buf);
    assert.equal(buf.readUInt16LE(at + 8), 0x02, 'the fixture root is one leaf page');
    for (let i = 0; i < buf.readUInt16LE(at + 10); i++) {
      const el = at + 16 + i * 16;
      const keyAt = el + buf.readUInt32LE(el + 4);
      if (buf.toString('utf8', keyAt, keyAt + buf.readUInt32LE(el + 8)) === from) {
        buf.write(to, keyAt);
        return;
      }
    }
    assert.fail(`${from} is not a top-level key`);
  });
}

const refused = (dir, pattern, ctx = CTX) => {
  const r = checkDb(dir, ctx);
  assert.equal(r.ok, false, `expected a refusal matching ${pattern}`);
  assert.match(r.reason, pattern);
};

// --- F1: the copy must be a real, usable Trivy DB ------------------------------

test('the fixtures are what the README says (go.etcd.io/bbolt output, not the reader under test)', () => {
  const real = inspectBolt(join(FIXTURES, 'real.db'));
  assert.equal(real.ok, true, real.reason);
  assert.deepEqual([...real.buckets.keys()].sort(), [
    'alpine 3.24',
    'data-source',
    'npm::GitHub Security Advisory npm',
    'vulnerability',
  ]);
  for (const [name, count] of real.buckets) assert.ok(count > 0, name);
  assert.deepEqual([...inspectBolt(join(FIXTURES, 'empty.db')).buckets], []);
  const hollow = inspectBolt(join(FIXTURES, 'hollow.db'));
  assert.equal(hollow.buckets.size, 4);
  for (const count of hollow.buckets.values()) assert.equal(count, 0);
});

test('checkDb: the real fixture, fresh and sealed by this producer, is accepted', () => {
  const r = checkDb(writeDb(tmp()), CTX);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.ageHours, 1);
  assert.equal(r.buckets, 4);
  assert.equal(r.source.key, KEY);
});

test("checkDb: the review's counterexample (magic only, bbolt version 0, page size 0) is REFUSED", () => {
  refused(writeDb(tmp(), { db: r1Counterexample() }), /meta page 0 has version 0, expected 2/);
});

for (const [name, edit, pattern] of [
  ['no bbolt magic', (b) => b.writeUInt32LE(0, 16), /meta page 0 has no bbolt magic/],
  ['meta 0 version 1', (b) => b.writeUInt32LE(1, 20), /meta page 0 has version 1/],
  ['meta 0 page size 0', (b) => b.writeUInt32LE(0, 24), /meta page 0 has page size 0/],
  ['meta 0 page size not a power of two', (b) => b.writeUInt32LE(4095, 24), /page size 4095/],
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
    (b) => {
      const { at } = rootPageOffset(b);
      b.writeBigUInt64LE(9999n, at);
    },
    /carries id 9999/,
  ],
  [
    'root page is neither branch nor leaf',
    (b) => {
      const { at } = rootPageOffset(b);
      b.writeUInt16LE(0x10, at + 8);
    },
    /has flags 16, not a branch or leaf/,
  ],
  [
    'root page claims more elements than fit',
    (b) => {
      const { at } = rootPageOffset(b);
      b.writeUInt16LE(60000, at + 10);
    },
    /more elements than fit/,
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
  refused(dir, /is truncated/);
});

test('checkDb: structure: one byte short of the pages its meta page counts -> refused', () => {
  const dir = writeDb(tmp());
  const path = join(dir, 'db/trivy.db');
  const buf = readFileSync(path);
  const ps = buf.readUInt32LE(24);
  const pgid = [0, ps]
    .map((at) => ({ pgid: buf.readBigUInt64LE(at + 56), txid: buf.readBigUInt64LE(at + 64) }))
    .sort((a, b) => (a.txid > b.txid ? -1 : 1))[0].pgid;
  truncateSync(path, Number(pgid) * ps - 1);
  reseal(dir);
  refused(dir, /is truncated: \d+ bytes, its meta page needs \d+ pages of 4096/);
});

test('checkDb: structure: an empty or tiny file -> refused', () => {
  refused(writeDb(tmp(), { db: Buffer.alloc(0) }), /meta page 0 is truncated/);
  refused(writeDb(tmp(), { db: Buffer.alloc(100) }), /meta page 0/);
});

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

test('checkDb: content: no Alpine release bucket -> refused', () => {
  refused(
    renameTopLevel('alpine 3.24', 'alpine x.24'),
    /no non-empty "alpine <major>\.<minor>" bucket/,
  );
});

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
    /UpdatedAt is missing or not a valid RFC 3339 instant: "2026-02-30T05:00:00Z"/,
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
  ['empty cache directory', null, /missing .*metadata\.json/],
  ['metadata empty file', '', /not valid JSON/],
  ['metadata is not JSON', '{nope', /not valid JSON/],
  ['metadata is an array', '[]', /metadata is not a JSON object/],
  ['metadata is null', 'null', /metadata is not a JSON object/],
  ['wrong schema version', { Version: 1 }, /Version is 1, expected 2/],
  ['schema version as a string', { Version: '2' }, /Version is "2", expected 2/],
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
    /published as "trivy-db-77-10" by run 77 attempt 10, expected trivy-db-77-1/,
  ],
  ['the right key but another attempt', { runAttempt: '2' }, /attempt 2, expected trivy-db-77-1/],
  ['the right key but another run', { runId: '78' }, /by run 78 .* expected trivy-db-77-1/],
  ['attempt as a number', { runAttempt: 1 }, /expected trivy-db-77-1/],
  ['no key', { key: undefined }, /published as undefined/],
  [
    'a repository outside the allowlist',
    { repository: 'evil.example/trivy-db:2' },
    /names repository "evil\.example\/trivy-db:2", not one of mirror\.gcr\.io/,
  ],
  ['no repository', { repository: undefined }, /names repository undefined/],
  [
    'an allowed repository with another tag',
    { repository: 'ghcr.io/aquasecurity/trivy-db:1' },
    /names repository/,
  ],
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
 *   ok | stale | r1 | hollow | empty | blind | lowsev | nothing | fail | hang | canary-hang
 * `blind` / `lowsev` / `canary-hang` download a good DB but break the canary.
 * `hang` ignores SIGTERM and never exits.
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
if (args[0] === 'fs') {
  const step = fs.readFileSync(path.join(dir, 'last-step'), 'utf8');
  record({ canary: true, step });
  if (!fs.existsSync(path.join(cache, 'db/trivy.db'))) { console.error('no DB'); process.exit(1); }
  if (step === 'canary-hang') return hang();
  const vulns = step === 'blind' ? [] : [{ VulnerabilityID: 'CVE-2021-23337', PkgName: 'lodash', Severity: step === 'lowsev' ? 'LOW' : 'HIGH' }];
  process.stdout.write(JSON.stringify({ Results: [{ Target: 'package-lock.json', Vulnerabilities: vulns }] }));
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
else fs.copyFileSync(path.join(fixtures, (step === 'hollow' || step === 'empty' ? step : 'real') + '.db'), db);
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
  validationSlopMs: 0,
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

test('fetch: the first repository works -> one download, one canary, sealed and accepted', async () => {
  const t = stubTrivy({ [GCR]: ['ok'], [GHCR]: ['ok'] });
  const { result, cacheDir } = await fetchWith(t);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.key, KEY);
  assert.deepEqual(t.repos(), [GCR]);
  const [download, canary] = t.calls();
  assert.deepEqual(download.args.slice(0, 3), ['image', '--download-db-only', '--no-progress']);
  assert.equal(download.args[download.args.indexOf('--timeout') + 1], '9s');
  assert.equal(canary.canary, true);
  for (const flag of ['--skip-db-update', '--offline-scan', '--cache-backend']) {
    assert.ok(canary.args.includes(flag), flag);
  }
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
  ["the review's counterexample (magic only, version 0)", 'r1', /meta page 0 has version 0/],
  ['a valid bbolt file with no buckets', 'empty', /has no bucket "vulnerability"/],
  ['a hollow DB (buckets present, empty)', 'hollow', /has an empty bucket/],
  ['a stale copy', 'stale', /vulnerability DB is stale/],
  [
    'a DB in which Trivy finds no canary',
    'blind',
    /Trivy found no CVE-2021-23337 in lodash 4\.17\.20/,
  ],
  ['a DB that rates the canary LOW', 'lowsev', /rates CVE-2021-23337 "LOW"/],
  ['trivy exits 0 and writes nothing', 'nothing', /missing .*metadata\.json/],
]) {
  test(`fetch: ${name} from the mirror is a failed attempt; ghcr.io is tried and used`, async () => {
    const t = stubTrivy({ [GCR]: [step], [GHCR]: ['ok'] });
    const { result, lines } = await fetchWith(t);
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(t.repos(), [GCR, GCR, GCR, GHCR]);
    assert.match(lines.join('\n'), new RegExp(`downloaded copy rejected: .*${pattern.source}`));
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

test('fetch: the trivy binary missing -> bounded attempts, refused', async () => {
  const { result } = await fetchWith({ stub: join(tmp(), 'no-such-trivy') });
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not run .*no-such-trivy/);
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
    /^trivy-db: shared copy ok - trivy-db-77-1 from repository mirror\.gcr\.io\/aquasec\/trivy-db:2, fetched by run 77 attempt 1 .*\(1\.0 h old, limit 24 h\), 4 buckets, sha256 verified\n$/,
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

test('CLI check: restore miss (empty directory) -> exit 1', () => {
  const r = cli(['check', tmp(), KEY]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing .*metadata\.json/);
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
  // The only mention passes the job's environment through to the Trivy child.
  assert.deepEqual(
    [...lib.matchAll(/process\.env\S*/g)].map((m) => m[0]),
    ['process.env,'],
  );
  assert.doesNotMatch(lib, /CI_TRIVY/);
});

test('the production policy is frozen', () => {
  assert.deepEqual(
    [...REPOSITORIES],
    ['mirror.gcr.io/aquasec/trivy-db:2', 'ghcr.io/aquasecurity/trivy-db:2'],
  );
  assert.ok(Object.isFrozen(REPOSITORIES) && Object.isFrozen(BUDGET));
});

// --- the workflow and the composite ------------------------------------------------

const workflow = parseYaml(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
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

test('trivy-db job: no needs, pinned Trivy, the key comes from the validated fetch', () => {
  const job = workflow.jobs['trivy-db'];
  assert.equal(job.needs, undefined);
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job.outputs.key, '${{ steps.fetch.outputs.key }}');
  const fetch = job.steps.find((s) => s.id === 'fetch');
  assert.equal(fetch.run, 'node scripts/ci-trivy-db.mjs fetch "$TRIVY_DB_DIR"');
  // No step but the validated fetch may write the key.
  assert.equal(job.steps.filter((s) => /GITHUB_OUTPUT/.test(s.run ?? '')).length, 0);
  const save = job.steps.find((s) => s.uses?.startsWith('actions/cache/save@'));
  assert.equal(save.with.key, '${{ steps.fetch.outputs.key }}');
  assert.equal(save.if, undefined); // only after a successful fetch
  assert.equal(
    job.steps.find((s) => s.uses?.startsWith('aquasecurity/setup-trivy@')).with.version,
    '${{ env.TRIVY_VERSION }}',
  );
  assert.equal(workflow.env.TRIVY_VERSION, 'v0.70.0');
});

test('trivy-db job: the time budget fits the step and job limits (F3 arithmetic)', () => {
  const job = workflow.jobs['trivy-db'];
  const limits = job.steps.map((s) => s['timeout-minutes']);
  assert.ok(
    limits.every((m) => Number.isInteger(m) && m > 0),
    'every step has its own limit',
  );
  assert.ok(limits.reduce((a, b) => a + b, 0) <= job['timeout-minutes']);
  const fetch = job.steps.find((s) => s.id === 'fetch');
  const fetchWorstMs = REPOSITORIES.length * (BUDGET.repositoryWindowMs + BUDGET.validationSlopMs);
  assert.ok(fetchWorstMs <= fetch['timeout-minutes'] * 60_000, `${fetchWorstMs} ms`);
  assert.ok(
    BUDGET.attemptMs + BUDGET.minAttemptMs <= BUDGET.repositoryWindowMs,
    'a retry fits a window',
  );
  assert.ok(
    BUDGET.attemptMs - 2 * BUDGET.killGraceMs >= 60_000,
    "Trivy's own timeout stays generous",
  );
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
  const fetch = job.steps.find((s) => s.id === 'fetch');
  const save = job.steps.find((s) => s.uses?.startsWith('actions/cache/save@'));
  assert.equal(fetch.env.TRIVY_DB_DIR, '${{ runner.temp }}/trivy-db');
  assert.equal(save.with.path, '${{ runner.temp }}/trivy-db');
  const where = compositeStep('Require the key of the shared Trivy DB');
  assert.match(where.run, /echo "dir=\$RUNNER_TEMP\/trivy-db" >> "\$GITHUB_OUTPUT"/);
  assert.equal(composite.outputs.dir.value, '${{ steps.where.outputs.dir }}');
  const text = readFileSync(join(ROOT, '.github/actions/restore-trivy-db/action.yml'), 'utf8');
  assert.doesNotMatch(text, /github\.workspace/);
  assert.doesNotMatch(JSON.stringify(job), /github\.workspace/);
});

/** Runs one composite step's real script with the given env; returns status and output. */
function runStep(step, env) {
  const out = join(tmp(), 'github-output');
  writeFileSync(out, '');
  const r = spawnSync('bash', ['-e', '-c', step.run], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, RUNNER_TEMP: '/runner/_temp', ...env },
  });
  return { ...r, output: readFileSync(out, 'utf8') };
}

test('restore action: exact key only, a miss fails, and an empty key fails before any restore', () => {
  const [where, restore, exact, check] = composite.runs.steps;
  assert.equal(where.name, 'Require the key of the shared Trivy DB');
  assert.match(restore.uses, /^actions\/cache\/restore@[0-9a-f]{40}$/);
  assert.equal(restore.id, 'restore');
  assert.equal(restore.with['fail-on-cache-miss'], true);
  assert.equal(restore.with['restore-keys'], undefined);
  assert.equal(restore.with.path, '${{ steps.where.outputs.dir }}');
  assert.equal(restore['continue-on-error'], undefined);
  assert.equal(exact.name, "Require an exact hit on the producer's key");
  assert.equal(check.run, PRE_SCAN_CHECK);
  assert.deepEqual(check.env, {
    TRIVY_DB_DIR: '${{ steps.where.outputs.dir }}',
    TRIVY_DB_KEY: '${{ inputs.key }}',
  });
  for (const s of composite.runs.steps) assert.equal(s.if, undefined, s.name);

  const empty = runStep(where, { KEY: '' });
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /::error::The trivy-db job published no database/);
  assert.equal(empty.output, '');
  const set = runStep(where, { KEY: KEY });
  assert.equal(set.status, 0);
  assert.equal(set.output, 'dir=/runner/_temp/trivy-db\n');
});

test('restore action: only an exact hit on the key is accepted (F4: partial hit refused)', () => {
  const exact = compositeStep("Require an exact hit on the producer's key");
  assert.deepEqual(exact.env, {
    KEY: '${{ inputs.key }}',
    CACHE_HIT: '${{ steps.restore.outputs.cache-hit }}',
    MATCHED_KEY: '${{ steps.restore.outputs.cache-matched-key }}',
  });
  for (const [name, env, status] of [
    ['exact hit', { KEY, CACHE_HIT: 'true', MATCHED_KEY: KEY }, 0],
    [
      'prefix match (cache-hit false)',
      { KEY, CACHE_HIT: 'false', MATCHED_KEY: 'trivy-db-77-10' },
      1,
    ],
    ['cache-hit unset', { KEY, CACHE_HIT: '', MATCHED_KEY: KEY }, 1],
    [
      'cache-hit true but another key',
      { KEY, CACHE_HIT: 'true', MATCHED_KEY: 'trivy-db-77-10' },
      1,
    ],
    // actions/cache's isExactKeyMatch ignores case; this step does not.
    [
      'a case-insensitive "exact" match',
      { KEY, CACHE_HIT: 'true', MATCHED_KEY: 'TRIVY-DB-77-1' },
      1,
    ],
    ['nothing matched', { KEY, CACHE_HIT: '', MATCHED_KEY: '' }, 1],
  ]) {
    const r = runStep(exact, env);
    assert.equal(r.status, status, `${name}: ${r.stdout}${r.stderr}`);
    if (status) assert.match(r.stdout, /::error::Restored .* not an exact hit on 'trivy-db-77-1'/);
  }
});

test('restore action, scripted end to end: a partial hit is refused at the exact-hit step, and again by the check', () => {
  // What actions/cache would leave behind after a prefix match on trivy-db-77-1.
  const dir = writeDb(tmp(), {
    base: new Date(),
    source: { key: 'trivy-db-77-10', runAttempt: '10' },
  });
  const exact = runStep(compositeStep("Require an exact hit on the producer's key"), {
    KEY,
    CACHE_HIT: 'false',
    MATCHED_KEY: 'trivy-db-77-10',
  });
  assert.equal(exact.status, 1);
  // Without that step the provenance still names the wrong producer.
  const check = runStep(compositeStep('Check the restored Trivy DB'), {
    TRIVY_DB_DIR: dir,
    TRIVY_DB_KEY: KEY,
    GITHUB_RUN_ID: '77',
    GITHUB_RUN_ATTEMPT: '10',
  });
  assert.equal(check.status, 1);
  assert.match(check.stderr, /published as "trivy-db-77-10" .* expected trivy-db-77-1/);
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

test('every use of the CLI in the workflow and composite passes the producer key to check', () => {
  const runs = [
    ...Object.values(workflow.jobs).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? '')),
    ...composite.runs.steps.map((s) => s.run ?? ''),
  ].filter((r) => r.includes('ci-trivy-db.mjs'));
  assert.equal(runs.length, 4); // fetch, the composite's check, two pre-scan checks
  for (const r of runs) {
    assert.ok(
      r === PRE_SCAN_CHECK || r === 'node scripts/ci-trivy-db.mjs fetch "$TRIVY_DB_DIR"',
      r,
    );
  }
});
