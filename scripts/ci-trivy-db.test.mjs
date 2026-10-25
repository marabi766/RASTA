import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { checkDb, DEFAULT_REPOSITORIES, MAX_AGE_MS } from './ci-trivy-db-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(ROOT, 'scripts/ci-trivy-db.mjs');
const NOW = new Date('2026-10-25T06:00:00.000Z');
const HOUR = 3600 * 1000;
const iso = (offsetMs) => new Date(NOW.getTime() + offsetMs).toISOString();
const E404 =
  'FATAL failed to download artifact from mirror.gcr.io/aquasec/trivy-db:2: oci download error: failed to fetch the layer: GET https://mirror.gcr.io/artifacts-downloads/x: unexpected status code 404 Not Found';

/** Writes a DB the way Trivy lays it out; `meta` replaces metadata.json, `db` false omits trivy.db, 'junk' writes a file without the bbolt magic. */
function writeDb(dir, { meta, db = true, source = true } = {}) {
  mkdirSync(join(dir, 'db'), { recursive: true });
  writeFileSync(
    join(dir, 'db/metadata.json'),
    typeof meta === 'string'
      ? meta
      : JSON.stringify({ Version: 2, NextUpdate: iso(23 * HOUR), UpdatedAt: iso(-HOUR), ...meta }),
  );
  if (db) {
    const path = join(dir, 'db/trivy.db');
    writeFileSync(path, db === 'junk' ? Buffer.alloc(2 * 1024 * 1024, 7) : Buffer.alloc(32));
    if (db === true) {
      const head = Buffer.alloc(32);
      head.writeUInt32LE(0xed0cdaed, 16);
      writeFileSync(path, head);
    }
    truncateSync(path, 2 * 1024 * 1024);
  }
  if (source) {
    writeFileSync(
      join(dir, 'ci-trivy-db-source.json'),
      JSON.stringify({
        repository: DEFAULT_REPOSITORIES[0],
        attempt: 1,
        fetchedAt: iso(-HOUR),
        runId: '77',
        runAttempt: '1',
      }),
    );
  }
}

const tmp = () => mkdtempSync(join(tmpdir(), 'ci-trivy-db-'));

// --- checkDb: every way a DB can be unusable --------------------------------

test('checkDb: a fresh, intact, provenance-carrying DB passes and reports its age', () => {
  const dir = tmp();
  writeDb(dir);
  const r = checkDb(dir, NOW, {});
  assert.equal(r.ok, true);
  assert.equal(r.ageHours, 1);
});

test('checkDb: the age limit is 24 h on UpdatedAt, inclusive', () => {
  const dir = tmp();
  writeDb(dir, { meta: { UpdatedAt: iso(-MAX_AGE_MS) } });
  assert.equal(checkDb(dir, NOW, {}).ok, true);
  writeDb(dir, { meta: { UpdatedAt: iso(-MAX_AGE_MS - 1000) } });
  const r = checkDb(dir, NOW, {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /stale: UpdatedAt .* 24\.0 h old, limit 24 h/);
});

test('checkDb: NextUpdate in the future does not rescue a stale UpdatedAt', () => {
  const dir = tmp();
  writeDb(dir, { meta: { UpdatedAt: iso(-30 * HOUR), NextUpdate: iso(10 * HOUR) } });
  assert.match(checkDb(dir, NOW, {}).reason, /stale/);
});

for (const [name, setup, pattern] of [
  ['empty cache directory', () => {}, /missing .*metadata\.json/],
  ['metadata empty file', (d) => writeDb(d, { meta: '' }), /not valid JSON/],
  ['metadata is not JSON', (d) => writeDb(d, { meta: '{nope' }), /not valid JSON/],
  ['metadata is an array', (d) => writeDb(d, { meta: '[]' }), /not a JSON object/],
  [
    'UpdatedAt missing',
    (d) => writeDb(d, { meta: JSON.stringify({ Version: 2 }) }),
    /UpdatedAt is missing/,
  ],
  [
    'UpdatedAt malformed',
    (d) => writeDb(d, { meta: { UpdatedAt: 'yesterday' } }),
    /UpdatedAt is missing or not an RFC 3339/,
  ],
  [
    'UpdatedAt a number',
    (d) => writeDb(d, { meta: { UpdatedAt: 1761372000 } }),
    /UpdatedAt is missing or not an RFC 3339/,
  ],
  [
    'UpdatedAt impossible date',
    (d) => writeDb(d, { meta: { UpdatedAt: '2026-13-45T99:99:99Z' } }),
    /does not parse/,
  ],
  [
    'UpdatedAt in the future',
    (d) => writeDb(d, { meta: { UpdatedAt: iso(2 * HOUR) } }),
    /in the future/,
  ],
  ['wrong schema version', (d) => writeDb(d, { meta: { Version: 1 } }), /Version is 1, expected 2/],
  ['trivy.db missing', (d) => writeDb(d, { db: false }), /missing .*trivy\.db/],
  [
    'trivy.db truncated',
    (d) => {
      writeDb(d);
      truncateSync(join(d, 'db/trivy.db'), 100);
    },
    /smaller than/,
  ],
  ['trivy.db corrupt (no bbolt magic)', (d) => writeDb(d, { db: 'junk' }), /bad magic/],
  [
    'no provenance (not from the shared download)',
    (d) => writeDb(d, { source: false }),
    /not produced by the shared download/,
  ],
]) {
  test(`checkDb: ${name} fails`, () => {
    const dir = tmp();
    setup(dir);
    const r = checkDb(dir, NOW, {});
    assert.equal(r.ok, false);
    assert.match(r.reason, pattern);
  });
}

test('checkDb: a DB fetched by another run is refused', () => {
  const dir = tmp();
  writeDb(dir);
  assert.equal(checkDb(dir, NOW, { GITHUB_RUN_ID: '77' }).ok, true);
  assert.match(
    checkDb(dir, NOW, { GITHUB_RUN_ID: '78' }).reason,
    /fetched by run 77, this is run 78/,
  );
});

// --- fetch: the real CLI against a stub trivy -------------------------------

/**
 * plan: { [repository]: ['fail' | 'ok' | 'stale' | 'junk' | 'empty', ...] }, the last step repeats.
 * The stub is invoked exactly like trivy and records every call.
 */
function runCli(mode, dir, plan, extraEnv = {}) {
  const stubDir = tmp();
  const stub = join(stubDir, 'trivy');
  writeFileSync(join(stubDir, 'plan.json'), JSON.stringify(plan));
  writeFileSync(
    stub,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(stubDir)};
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const repo = arg('--db-repository');
const cache = arg('--cache-dir');
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify(args) + '\\n');
const seen = fs.readFileSync(path.join(dir, 'calls'), 'utf8').split('\\n').filter(Boolean)
  .filter((l) => JSON.parse(l)[JSON.parse(l).indexOf('--db-repository') + 1] === repo).length;
const steps = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'))[repo];
const step = steps[Math.min(seen, steps.length) - 1];
const now = Date.parse(${JSON.stringify(NOW.toISOString())});
if (step === 'fail') { console.error(${JSON.stringify(E404)}); process.exit(1); }
if (step === 'empty') process.exit(0);
fs.mkdirSync(path.join(cache, 'db'), { recursive: true });
const updated = new Date(now - (step === 'stale' ? 30 : 1) * 3600000).toISOString();
fs.writeFileSync(path.join(cache, 'db/metadata.json'), JSON.stringify({ Version: 2, UpdatedAt: updated, NextUpdate: updated }));
const buf = Buffer.alloc(2 * 1024 * 1024, step === 'junk' ? 7 : 0);
if (step !== 'junk') buf.writeUInt32LE(0xed0cdaed, 16);
fs.writeFileSync(path.join(cache, 'db/trivy.db'), buf);
`,
  );
  chmodSync(stub, 0o755);
  const result = spawnSync(process.execPath, [CLI, mode, dir], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      CI_TRIVY_BIN: stub,
      CI_TRIVY_DB_BACKOFF: '0 0',
      CI_TRIVY_DB_NOW: NOW.toISOString(),
      GITHUB_RUN_ID: '77',
      GITHUB_RUN_ATTEMPT: '1',
      ...extraEnv,
    },
  });
  const calls = existsSync(join(stubDir, 'calls'))
    ? readFileSync(join(stubDir, 'calls'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  return { ...result, calls, repos: calls.map((c) => c[c.indexOf('--db-repository') + 1]) };
}

const [GCR, GHCR] = DEFAULT_REPOSITORIES;

test('fetch: the first repository works -> one call, then check passes and names the source', () => {
  const dir = tmp();
  const r = runCli('fetch', dir, { [GCR]: ['ok'], [GHCR]: ['ok'] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.repos, [GCR]);
  assert.deepEqual(r.calls[0].slice(0, 3), ['image', '--download-db-only', '--no-progress']);
  const c = runCli('check', dir, {});
  assert.equal(c.status, 0, c.stderr);
  assert.match(
    c.stdout,
    /shared copy ok - repository mirror\.gcr\.io\/aquasec\/trivy-db:2, fetched by run 77 attempt 1/,
  );
});

test('fetch: the observed failure (404 on the mirror layer) is retried, then ghcr.io is tried', () => {
  const dir = tmp();
  const r = runCli('fetch', dir, { [GCR]: ['fail'], [GHCR]: ['ok'] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.repos, [GCR, GCR, GCR, GHCR]);
  assert.equal(
    JSON.parse(readFileSync(join(dir, 'ci-trivy-db-source.json'), 'utf8')).repository,
    GHCR,
  );
});

test('fetch: a transient failure on the first attempt is retried on the same repository', () => {
  const dir = tmp();
  const r = runCli('fetch', dir, { [GCR]: ['fail', 'ok'], [GHCR]: ['ok'] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.repos, [GCR, GCR]);
});

test('fetch: a mirror serving a stale copy is a failed attempt, the next repository is used', () => {
  const dir = tmp();
  const r = runCli('fetch', dir, { [GCR]: ['stale'], [GHCR]: ['ok'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.repos.at(-1), GHCR);
  assert.match(r.stderr, /downloaded copy rejected: vulnerability DB is stale/);
});

for (const [name, step] of [
  ['corrupt copy', 'junk'],
  ['trivy exits 0 and writes nothing', 'empty'],
]) {
  test(`fetch: ${name} on both repositories -> producer exhausted, exit 1, no DB left behind`, () => {
    const dir = tmp();
    const r = runCli('fetch', dir, { [GCR]: [step], [GHCR]: [step] });
    assert.equal(r.status, 1);
    assert.equal(r.repos.length, 6);
    assert.match(r.stderr, /::error::trivy-db: no repository yielded a usable DB/);
    assert.equal(existsSync(join(dir, 'db')), false);
    assert.equal(runCli('check', dir, {}).status, 1);
  });
}

test('fetch: both registries failing is bounded (3 attempts each) and exits 1', () => {
  const dir = tmp();
  const r = runCli('fetch', dir, { [GCR]: ['fail'], [GHCR]: ['fail'] });
  assert.equal(r.status, 1);
  assert.deepEqual(r.repos, [GCR, GCR, GCR, GHCR, GHCR, GHCR]);
  assert.match(r.stderr, /mirror\.gcr\.io.*attempt 3\/3: trivy exited 1/s);
});

test("fetch: a failed attempt never leaves the previous attempt's files for the next to inherit", () => {
  const dir = tmp();
  writeDb(dir); // leftover from an earlier, successful fetch
  const r = runCli('fetch', dir, { [GCR]: ['empty'], [GHCR]: ['empty'] });
  assert.equal(r.status, 1);
  assert.equal(existsSync(join(dir, 'db')), false);
});

test('check: stale metadata (28 h) -> exit 1 with the reason on stderr', () => {
  const dir = tmp();
  writeDb(dir, { meta: { UpdatedAt: iso(-28 * HOUR) } });
  const r = runCli('check', dir, {});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /::error::trivy-db: vulnerability DB is stale/);
});

test('check: restore miss (empty directory) -> exit 1', () => {
  const r = runCli('check', tmp(), {});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing .*metadata\.json/);
});

test('usage errors exit 2', () => {
  assert.equal(spawnSync(process.execPath, [CLI, 'bogus', '/x']).status, 2);
  assert.equal(spawnSync(process.execPath, [CLI, 'check']).status, 2);
});

// --- the workflow: wiring that makes a missing DB a red scan ----------------

const workflow = parseYaml(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
const composite = parseYaml(
  readFileSync(join(ROOT, '.github/actions/restore-trivy-db/action.yml'), 'utf8'),
);
const SCANS = [
  ['containers', 'rasta/${{ matrix.service }}:${{ github.sha }}', '.trivyignore.services'],
  ['clamav-signatures', 'rasta/clamav-pinned:ci', '.trivyignore.clamav'],
];
const stepIndex = (job, pred) => workflow.jobs[job].steps.findIndex(pred);

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

  test(`${job}: restore comes first-ish, Trivy is the pinned version, freshness is re-checked right before the scan`, () => {
    const restoreAt = stepIndex(job, (s) => s.uses === './.github/actions/restore-trivy-db');
    assert.ok(restoreAt >= 0 && restoreAt < scanAt);
    assert.equal(steps[restoreAt].id, 'trivy-db');
    assert.equal(steps[restoreAt].with.key, '${{ needs.trivy-db.outputs.key }}');
    const install = steps.find((s) => s.uses?.startsWith('aquasecurity/setup-trivy@'));
    assert.equal(install.with.version, '${{ env.TRIVY_VERSION }}');
    assert.equal(
      steps[scanAt - 1].run,
      'node scripts/ci-trivy-db.mjs check "${{ steps.trivy-db.outputs.dir }}"',
    );
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

test('trivy-db job: no needs, pinned Trivy, fetch then save under a per-attempt key', () => {
  const job = workflow.jobs['trivy-db'];
  assert.equal(job.needs, undefined);
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job.outputs.key, '${{ steps.publish.outputs.key }}');
  const run = job.steps.map((s) => s.run ?? '').join('\n');
  assert.match(run, /node scripts\/ci-trivy-db\.mjs fetch/);
  assert.match(run, /key=trivy-db-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
  const save = job.steps.find((s) => s.uses?.startsWith('actions/cache/save@'));
  assert.equal(save.with.key, '${{ steps.publish.outputs.key }}');
  assert.equal(save.with.path, composite.outputs.dir.value);
  assert.equal(
    job.steps.find((s) => s.uses?.startsWith('aquasecurity/setup-trivy@')).with.version,
    '${{ env.TRIVY_VERSION }}',
  );
  assert.equal(workflow.env.TRIVY_VERSION, 'v0.70.0');
});

test('restore action: exact key only, a miss fails, and an empty key fails before any restore', () => {
  const [require, restore, check] = composite.runs.steps;
  assert.match(restore.uses, /^actions\/cache\/restore@[0-9a-f]{40}$/);
  assert.equal(restore.with['fail-on-cache-miss'], true);
  assert.equal(restore.with['restore-keys'], undefined);
  assert.equal(restore.with.path, composite.outputs.dir.value);
  assert.equal(restore['continue-on-error'], undefined);
  assert.match(check.run, /ci-trivy-db\.mjs check/);
  // Execute the real step script: the producer failed, so the key is empty.
  const empty = spawnSync('bash', ['-c', require.run], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, KEY: '' },
  });
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /::error::The trivy-db job published no database/);
  const set = spawnSync('bash', ['-c', require.run], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, KEY: 'trivy-db-1-1' },
  });
  assert.equal(set.status, 0);
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
