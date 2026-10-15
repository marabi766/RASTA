import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts/ci-pull-image.sh');
const DIGEST = 'a'.repeat(64);
const IMAGE = `quay.io/keycloak/keycloak:26.0@sha256:${DIGEST}`;

// The 502 that failed #279, with its real shape: the manifest URL carries the
// digest, which is hex and so can contain "404" or "401".
const E502 = (digest = `09a381c7${'4040'.repeat(14)}`) =>
  `docker: Error response from daemon: Get "https://quay.io/v2/keycloak/keycloak/manifests/sha256:${digest}": received unexpected HTTP status: 502 Bad Gateway.`;
const TIMEOUT =
  'Error response from daemon: Get "https://quay.io/v2/": net/http: TLS handshake timeout';
const RESET = 'read tcp 10.0.0.1:443: connection reset by peer';
const E404 =
  'Error response from daemon: manifest for quay.io/keycloak/keycloak@sha256:' +
  DIGEST +
  ' not found: manifest unknown: manifest unknown';
const UNKNOWN = 'Error response from daemon: manifest unknown';
const UNAUTH =
  'Error response from daemon: pull access denied for x, repository does not exist or may require authorization: unauthorized: authentication required';
const MISMATCH =
  'Error response from daemon: digest mismatch: manifest verification failed for digest';
const NOVEL = 'Error response from daemon: the disk fell off the table';

/** Runs the script against a stub `docker` that answers pull N with steps[N-1] (the last step repeats). */
function run(steps, images = [IMAGE]) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-pull-image-'));
  steps.forEach(([rc, err], i) => {
    writeFileSync(join(dir, `${i + 1}.rc`), String(rc));
    writeFileSync(join(dir, `${i + 1}.err`), err);
  });
  writeFileSync(join(dir, 'last'), String(steps.length));
  const stub = join(dir, 'docker');
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
d="${dir}"
echo "$*" >> "$d/calls"
n=$(wc -l < "$d/calls")
last=$(cat "$d/last")
[ "$n" -gt "$last" ] && n=$last
cat "$d/$n.err" >&2
exit "$(cat "$d/$n.rc")"
`,
  );
  chmodSync(stub, 0o755);
  // PATH: the stub directory first, so `docker` is ours.
  const result = spawnSync('bash', [SCRIPT, ...images], {
    env: { PATH: `${dir}:${process.env.PATH}`, CI_PULL_BACKOFF: '0 0 0' },
    encoding: 'utf8',
  });
  const calls = existsSync(join(dir, 'calls'))
    ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').filter(Boolean)
    : [];
  return { ...result, calls };
}

test('succeeds first time with one pull', () => {
  const r = run([[0, '']]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, [`pull ${IMAGE}`]);
});

for (const [name, text] of [
  ['502 Bad Gateway (the #279 failure, digest containing 404)', E502()],
  ['TLS handshake timeout', TIMEOUT],
  ['connection reset by peer', RESET],
]) {
  test(`retries a transient error: ${name}, then succeeds`, () => {
    const r = run([
      [1, text],
      [125, text],
      [0, ''],
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.length, 3);
    assert.match(r.stderr, /retrying in 0s/);
  });
}

test('gives up after four attempts when the error stays transient', () => {
  const r = run([[1, E502()]]);
  assert.equal(r.status, 1);
  assert.equal(r.calls.length, 4);
  assert.match(r.stderr, /still failing after 4 attempts/);
});

for (const [name, text] of [
  ['404 / manifest unknown', E404],
  ['manifest unknown', UNKNOWN],
  ['unauthorized / denied', UNAUTH],
  ['digest mismatch', MISMATCH],
  ['an error it has never seen', NOVEL],
]) {
  test(`fails at once on ${name}`, () => {
    const r = run([
      [1, text],
      [0, ''],
    ]);
    assert.equal(r.status, 1);
    assert.equal(r.calls.length, 1, 'must not retry');
    assert.match(r.stderr, /not retrying/);
    assert.ok(r.stderr.includes(text), "docker's own output is kept");
  });
}

test('a permanent marker beats a transient one in the same output', () => {
  const r = run([
    [1, `${E404}\n${TIMEOUT}`],
    [0, ''],
  ]);
  assert.equal(r.status, 1);
  assert.equal(r.calls.length, 1);
});

test('pulls several images in order and stops at the first that fails permanently', () => {
  const other = `docker.io/library/redis:7@sha256:${'b'.repeat(64)}`;
  const ok = run([[0, '']], [IMAGE, other]);
  assert.equal(ok.status, 0);
  assert.deepEqual(ok.calls, [`pull ${IMAGE}`, `pull ${other}`]);
  const bad = run([[1, E404]], [IMAGE, other]);
  assert.equal(bad.status, 1);
  assert.equal(bad.calls.length, 1);
});

test('refuses a reference that is not pinned by digest, without calling docker', () => {
  for (const ref of ['quay.io/keycloak/keycloak:26.0', 'redis', `redis@sha256:${'c'.repeat(63)}`]) {
    const r = run([[0, '']], [ref]);
    assert.equal(r.status, 2, ref);
    assert.equal(r.calls.length, 0);
    assert.match(r.stderr, /not pinned by sha256 digest/);
  }
});

test('requires at least one image', () => {
  const r = run([[0, '']], []);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

// --- the workflow actually uses it -----------------------------------------

const workflow = parseYaml(readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8'));
const REF = /(?:[\w.-]+\/)+[\w.-]+(?::[\w.-]+)?@sha256:[0-9a-f]{64}/g;
const resolveRefs = (text) => {
  const env = workflow.env ?? {};
  const expanded = text.replace(/\$\{?(MINIO_IMAGE|MC_IMAGE)\}?/g, (_, name) => env[name]);
  return new Set(expanded.match(REF) ?? []);
};

test('every digest-pinned image a step pulls or runs is pre-pulled earlier in the same job', () => {
  const problems = [];
  let prepulls = 0;
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const steps = job.steps ?? [];
    const pulled = new Set();
    steps.forEach((step, index) => {
      const run = String(step.run ?? '');
      if (run.includes('scripts/ci-pull-image.sh')) {
        prepulls += 1;
        resolveRefs(run).forEach((ref) => pulled.add(ref));
        return;
      }
      if (!/docker (run|pull)\b/.test(run)) return;
      for (const ref of resolveRefs(run)) {
        if (!pulled.has(ref))
          problems.push(`${id}: step ${index} "${step.name}" uses ${ref} with no earlier pre-pull`);
      }
    });
  }
  assert.ok(prepulls >= 8, `expected the pre-pull steps to exist, found ${prepulls}`);
  assert.deepEqual(problems, []);
});

test('the pre-pull steps do not weaken pinning: none names a tag-only image', () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      const run = String(step.run ?? '');
      if (!run.includes('scripts/ci-pull-image.sh')) continue;
      const args = run.replace(/\\\n/g, ' ').split('ci-pull-image.sh')[1].trim().split(/\s+/);
      for (const arg of args) {
        assert.match(arg.replace(/"/g, ''), /^(\$\w+|.+@sha256:[0-9a-f]{64})$/, arg);
      }
    }
  }
});
