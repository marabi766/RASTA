import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
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
  for (const ref of [
    'quay.io/keycloak/keycloak:26.0',
    'redis',
    `redis@sha256:${'c'.repeat(63)}`,
    `redis@sha256:${'g'.repeat(64)}`,
  ]) {
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
const HELPER = 'ci-pull-image.sh';
const DOCKER_PULLS = /\bdocker\s+(?:(?:container|image)\s+)?(run|pull|create)\b/;

/**
 * Walks the commands of a `run:` block or a shell script in order. A call to
 * the helper adds its images to `pulled`; every `docker run|pull|create` is
 * then checked against what was pulled BEFORE it, image by image. Line
 * continuations are joined, so `docker \⏎ run` and a split image argument are
 * one command. `vars` maps a shell variable to its value, and plain
 * assignments in a script extend it as they are met.
 *
 * `strict` (scripts): a docker command whose image does not resolve to a
 * digest-pinned reference is a problem, not something to skip. A workflow
 * step may run the local `rasta/clamav-pinned:ci` tag, which never pulls.
 */
function checkCommands(text, { label, vars, pulled, strict, learn = false }) {
  const problems = [];
  const lines = text.split('\n');
  const resolveVars = (cmd) =>
    cmd.replace(/\$\{(\w+)(?:[^}]*)\}|\$(\w+)/g, (m, a, b) => vars[a ?? b] ?? m);
  let helperCalls = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const first = i + 1;
    let logical = lines[i];
    while (/\\\s*$/.test(logical) && i + 1 < lines.length) {
      i += 1;
      logical = logical.replace(/\\\s*$/, ' ') + lines[i];
    }
    if (/^\s*#/.test(logical)) continue;
    if (learn) {
      const assign = /^\s*(?:export\s+|readonly\s+|local\s+)?(\w+)=(.*)$/.exec(logical);
      if (assign) vars[assign[1]] = assign[2].match(REF)?.[0] ?? assign[2];
    }
    for (const piece of logical.split(/\s*(?:&&|\|\||;)\s*/)) {
      const cmd = resolveVars(piece);
      if (cmd.includes(HELPER)) {
        helperCalls += 1;
        (cmd.split(HELPER)[1].match(REF) ?? []).forEach((ref) => pulled.add(ref));
      } else if (DOCKER_PULLS.test(cmd)) {
        const refs = cmd.match(REF) ?? [];
        if (refs.length === 0 && strict)
          problems.push(
            `${label}:${first} runs docker on an image that is not a resolvable digest-pinned reference: ${piece.trim()}`,
          );
        for (const ref of refs)
          if (!pulled.has(ref))
            problems.push(`${label}:${first} uses ${ref} with no earlier pre-pull`);
      }
    }
  }
  return { problems, helperCalls };
}

test('every digest-pinned image a step pulls or runs is pre-pulled earlier in the same job', () => {
  const problems = [];
  let prepulls = 0;
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const pulled = new Set();
    (job.steps ?? []).forEach((step, index) => {
      const result = checkCommands(String(step.run ?? ''), {
        label: `${id}: step ${index} "${step.name}"`,
        vars: { ...(workflow.env ?? {}) },
        pulled,
        strict: false,
      });
      if (result.helperCalls > 0) prepulls += 1;
      problems.push(...result.problems);
    });
  }
  assert.ok(prepulls >= 8, `expected the pre-pull steps to exist, found ${prepulls}`);
  assert.deepEqual(problems, []);
});

// A workflow step can hand the pull to a shell script (the Kafka bootstrap
// does): that script's `docker run`/`pull`/`create` is as exposed to a registry
// error as a step's, and the check above never looked inside it.
const REPO_DIR_VARS = /^(ROOT|REPO_ROOT|REPO_DIR|GITHUB_WORKSPACE)$/;
const SCRIPT_REF =
  /(?:^|[\s"'(=])((?:\$\{\w+\}|\$\w+|\$\(dirname [^)]*\))\/)?((?:[\w.-]+\/)*[\w.-]+\.(?:sh|bash))\b/gm;

/** Scripts called from `text` (located in `fromDir`), as { abs } or { unresolved }. */
const scriptCalls = (text, fromDir) => {
  const calls = [];
  const code = text
    .split('\n')
    .filter((line) => !/^\s*(#|echo\b|printf\b)/.test(line)) // comments and messages name files without calling them
    .join('\n');
  for (const [, prefix, rel] of code.matchAll(SCRIPT_REF)) {
    if (rel.endsWith(HELPER)) continue;
    let bases;
    if (!prefix) bases = fromDir === ROOT ? [ROOT] : [fromDir, ROOT];
    else if (prefix.startsWith('$(dirname')) bases = [fromDir];
    else {
      const name = /\w+/.exec(prefix)[0];
      bases = REPO_DIR_VARS.test(name) ? [ROOT] : [fromDir];
    }
    const abs = bases.map((base) => resolve(base, rel)).find((candidate) => existsSync(candidate));
    calls.push(abs ? { abs } : { unresolved: `${prefix ?? ''}${rel}` });
  }
  return calls;
};

const shellScriptsCalledFrom = (runs) => {
  const found = new Map(); // repo-relative path -> source text
  const unresolved = [];
  const queue = runs.flatMap((run) =>
    scriptCalls(run, ROOT).map((call) => ({ ...call, by: 'ci.yml' })),
  );
  while (queue.length > 0) {
    const call = queue.pop();
    if (call.unresolved) {
      unresolved.push(`${call.by} calls ${call.unresolved}, which was not found`);
      continue;
    }
    const path = relative(ROOT, call.abs);
    if (found.has(path)) continue;
    const text = readFileSync(call.abs, 'utf8');
    found.set(path, text);
    queue.push(...scriptCalls(text, dirname(call.abs)).map((next) => ({ ...next, by: path })));
  }
  return { found, unresolved };
};

test('a shell script a workflow calls pre-pulls every digest-pinned image it runs', () => {
  const runs = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).map((step) => String(step.run ?? '')),
  );
  const { found, unresolved } = shellScriptsCalledFrom(runs);
  assert.ok(
    found.has('infrastructure/docker/kafka/ci-up.sh'),
    'the Kafka bootstrap should be found as a script called from a workflow',
  );
  // A call the test cannot follow is a hole in it, not something to skip.
  const problems = [...unresolved];
  for (const [path, text] of found) {
    problems.push(
      ...checkCommands(text, {
        label: path,
        vars: {},
        pulled: new Set(),
        strict: true,
        learn: true,
      }).problems,
    );
  }
  assert.deepEqual(problems, []);
});

test('the Kafka bootstrap pre-pulls its image by the digest it runs', () => {
  const text = readFileSync(resolve(ROOT, 'infrastructure/docker/kafka/ci-up.sh'), 'utf8');
  assert.match(text, /^IMAGE="\$\{KAFKA_IMAGE:-[^"}]*@sha256:[0-9a-f]{64}\}"$/m);
  assert.match(text, /^"\$\{ROOT\}\/scripts\/ci-pull-image\.sh" "\$\{IMAGE\}"$/m);
});

test('the pre-pull steps do not weaken pinning: none names a tag-only image', () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      const run = String(step.run ?? '');
      if (!run.includes('scripts/ci-pull-image.sh')) continue;
      // The helper's own command only: the step may go on to `docker tag`.
      const args = run
        .replace(/\\\n/g, ' ')
        .split('ci-pull-image.sh')[1]
        .split('\n')[0]
        .trim()
        .split(/\s+/);
      for (const arg of args) {
        assert.match(arg.replace(/"/g, ''), /^(\$\w+|.+@sha256:[0-9a-f]{64})$/, arg);
      }
    }
  }
});
