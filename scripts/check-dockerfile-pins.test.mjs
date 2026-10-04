import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import {
  DIGEST_VARIANTS,
  TAGLESS,
  tokenizeShell,
  validateDockerfilePins,
  validateInfraImagePins,
} from './check-dockerfile-pins-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const file = (text, name = 'services/x/Dockerfile') => ({ name, text });
const pinned = (digest = A) =>
  [
    `FROM node:22-alpine@${digest} AS deps`,
    'RUN npm install -g pnpm@11.22.0',
    'FROM deps AS build',
    `FROM node:22-alpine@${digest} AS runtime`,
  ].join('\n');

test('the committed Dockerfiles pass', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-dockerfile-pins.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /13 Dockerfiles on one base/);
  assert.match(result.stdout, /infra image pins: \d+ image references in \d+ files, all pinned/);
});

test('a pinned file, including a FROM of an earlier stage, passes', () => {
  assert.deepEqual(validateDockerfilePins([file(pinned())]).errors, []);
});

test('a moving tag is refused', () => {
  const { errors } = validateDockerfilePins([file('FROM node:22-alpine AS deps')]);
  assert.match(errors[0], /not pinned by digest/);
});

test('two services on different digests are refused', () => {
  const { errors } = validateDockerfilePins([
    file(pinned(A), 'services/a/Dockerfile'),
    file(pinned(B), 'services/b/Dockerfile'),
  ]);
  assert.match(errors.join('\n'), /disagree/);
});

test('a bare apk upgrade is refused; a named one-package stop-gap is not', () => {
  assert.equal(
    validateDockerfilePins([file(`${pinned()}\nRUN apk --no-cache upgrade`)]).errors.length,
    1,
  );
  assert.deepEqual(
    validateDockerfilePins([file(`${pinned()}\nRUN apk --no-cache upgrade openssl`)]).errors,
    [],
  );
});

test('a truncated digest is not a digest', () => {
  const { errors } = validateDockerfilePins([file('FROM node:22-alpine@sha256:abc AS deps')]);
  assert.match(errors[0], /not pinned/);
});

// --- compose, workflow and CI-script images (L7-45) ------------------------

const C = `sha256:${'c'.repeat(64)}`;
const NO_EXEMPTIONS = { digestVariants: new Map(), tagless: new Map() };
const compose = (text) => ({ name: 'docker-compose.yml', kind: 'compose', text });
const workflowYaml = (text) => ({ name: '.github/workflows/ci.yml', kind: 'workflow', text });
/** A workflow whose one step runs `script`; extra top-level keys merged in. */
const workflow = (script, extra = {}) =>
  workflowYaml(stringify({ ...extra, jobs: { a: { 'runs-on': 'x', steps: [{ run: script }] } } }));
const shell = (text) => ({ name: 'infrastructure/x/ci-up.sh', kind: 'shell', text });
const infra = (files, policy = NO_EXEMPTIONS) => validateInfraImagePins(files, policy);
const PINNED = `postgis/postgis:16-3.4@${A}`;
const notPinned = /is not pinned by digest/;

test('a compose image pinned as tag@digest is accepted; tag-only and digest-only are refused', () => {
  const ok = infra([compose(`services:\n  postgres:\n    image: ${PINNED}`)]);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.images.length, 1);
  assert.match(
    infra([compose('services:\n  r:\n    image: redis:7.4-alpine')]).errors[0],
    notPinned,
  );
  assert.match(
    infra([compose(`services:\n  r:\n    image: redis@${A}`)]).errors[0],
    /has no tag — pin it as <tag>@sha256/,
  );
});

test('compose: a quoted image key is still the image (Codex finding 1)', () => {
  for (const key of ["'image'", '"image"']) {
    const { errors } = infra([compose(`services:\n  postgres:\n    ${key}: postgres:16`)]);
    assert.equal(errors.length, 1, key);
    assert.match(errors[0], /service postgres\): image postgres:16 is not pinned/);
  }
});

test('compose: an image inherited through an anchor and a << merge key is resolved (Codex finding 1)', () => {
  const merged = [
    'x-base: &base',
    '  image: postgres:16',
    '  restart: always',
    'services:',
    '  db:',
    '    <<: *base',
    '    environment: { A: 1 }',
    '  copy: *base',
  ].join('\n');
  const { errors } = infra([compose(merged)]);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /service db\): image postgres:16 is not pinned/);
  assert.match(errors[1], /service copy\): image postgres:16 is not pinned/);
  assert.deepEqual(infra([compose(merged.replace('postgres:16', `postgres:16@${A}`))]).errors, []);
});

test('compose: every profile is checked, not only the default one', () => {
  const { errors } = infra([
    compose(
      `services:\n  a:\n    image: ${PINNED}\n  ui:\n    profiles: [tools]\n    image: kafka-ui:v1`,
    ),
  ]);
  assert.match(errors[0], /service ui\): image kafka-ui:v1 is not pinned/);
});

test('compose interpolation: a default is checked, a variable without one fails closed', () => {
  const at = (image) => infra([compose(`services:\n  db:\n    image: "${image}"`)]).errors;
  assert.match(at('${PG_IMAGE:-postgres:16}')[0], /image postgres:16 is not pinned/);
  assert.deepEqual(at(`\${PG_IMAGE:-postgres:16@${A}}`), []);
  assert.match(at('${PG_IMAGE}')[0], /has no default this check can resolve/);
  assert.match(at('postgres:${PG_TAG}')[0], /has no default/);
});

test('compose: extends in the same file is followed; another file, build: and include: fail closed', () => {
  const base = `services:\n  base:\n    image: ${PINNED}\n`;
  assert.deepEqual(infra([compose(`${base}  child:\n    extends: base`)]).errors, []);
  assert.deepEqual(infra([compose(`${base}  child:\n    extends: { service: base }`)]).errors, []);
  assert.match(
    infra([compose(`${base}  child:\n    extends: { file: other.yml, service: x }`)]).errors[0],
    /extends a service in another file/,
  );
  assert.match(
    infra([compose('services:\n  app:\n    build: ./app')]).errors[0],
    /builds its image here/,
  );
  assert.match(
    infra([compose(`include: [other.yml]\n${base}`)]).errors[0],
    /include: brings in services this check does not read/,
  );
});

test('workflow: services:, container: and uses: docker:// images are checked', () => {
  const jobs = (job) => workflowYaml(stringify({ jobs: { a: job } }));
  const cases = [
    jobs({ services: { redis: { image: 'redis:7.4-alpine' } } }),
    jobs({ container: 'node:22-alpine' }),
    jobs({ container: { image: 'node:22-alpine' } }),
    jobs({ steps: [{ uses: 'docker://alpine:3.20' }] }),
  ];
  for (const file of cases) {
    const { errors } = infra([file]);
    assert.equal(errors.length, 1, file.text);
    assert.match(errors[0], notPinned);
  }
});

test('every docker command on a line is checked, after ; && || | (Codex finding 2)', () => {
  for (const separator of [' ; ', ' && ', ' || ', ' | ', ' & ']) {
    const { errors } = infra([
      workflow(`docker pull ${PINNED}${separator}docker run ubuntu:24.04`),
    ]);
    assert.equal(errors.length, 1, separator);
    assert.match(errors[0], /image ubuntu:24\.04 is not pinned/, separator);
  }
});

test('docker \\ newline run … is one command (Codex finding 2)', () => {
  const { errors } = infra([workflow('set -e\ndocker \\\n  run --rm \\\n  ubuntu:24.04 true\n')]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ci\.yml:\d+: image ubuntu:24\.04 is not pinned/);
});

test('docker inside $( ), backticks, a subshell or a here-document fed to bash is found', () => {
  for (const script of [
    'id=$(docker run -d ubuntu:24.04)',
    'id=`docker run -d ubuntu:24.04`',
    'echo "$(docker run ubuntu:24.04)"',
    '( cd /tmp && docker run ubuntu:24.04 )',
    'bash <<EOF\ndocker run ubuntu:24.04\nEOF\n',
    'if true; then docker run ubuntu:24.04; fi',
    'timeout 60 docker run ubuntu:24.04',
  ]) {
    const { errors } = infra([workflow(script)]);
    assert.ok(
      errors.some((e) => /ubuntu:24\.04 is not pinned/.test(e)),
      `${script}\n${errors.join('\n')}`,
    );
  }
});

test('text that only mentions docker is not a command', () => {
  for (const script of [
    '# docker run ubuntu:24.04 in a comment',
    'echo "docker run ubuntu:24.04"',
    "echo 'docker run ubuntu:24.04'",
    'cat <<EOF\ndocker run ubuntu:24.04\nEOF\n',
    'grep -q x <<< "docker run ubuntu:24.04"',
  ]) {
    assert.deepEqual(infra([workflow(script)]).errors, [], script);
  }
});

test('a docker verb, option or global option the check cannot classify fails closed', () => {
  assert.match(
    infra([workflow('docker build -t x .')]).errors[0],
    /docker build is not a command this check can classify/,
  );
  assert.match(
    infra([workflow('docker buildx bake')]).errors[0],
    /docker buildx is not a command this check can classify/,
  );
  assert.match(
    infra([workflow(`docker run --frobnicate x ${PINNED}`)]).errors[0],
    /cannot tell whether docker option --frobnicate takes a value/,
  );
  assert.match(
    infra([workflow(`docker --weird run ${PINNED}`)]).errors[0],
    /global option --weird/,
  );
  assert.deepEqual(infra([workflow(`docker -H tcp://x:2375 run ${PINNED}`)]).errors, []);
  assert.deepEqual(
    infra([workflow('docker logs --tail 5 x; docker exec x true; docker rm -f x')]).errors,
    [],
  );
});

test('docker compose may name only the compose file this check validates', () => {
  assert.deepEqual(infra([workflow('docker compose -f docker-compose.yml up -d')]).errors, []);
  assert.deepEqual(infra([workflow('docker compose --profile tools up -d')]).errors, []);
  assert.match(
    infra([workflow('docker compose -f other.yml up -d')]).errors[0],
    /a compose file this check does not validate/,
  );
});

test('a script the check cannot split fails closed', () => {
  assert.match(
    infra([shell("docker run 'ubuntu:24.04")]).errors[0],
    /cannot split this script into commands \(unclosed single quote/,
  );
});

test('image-pin-exempt with a reason exempts that command; without one it is an error', () => {
  const exempt = workflow(
    'docker run ubuntu:24.04 true # image-pin-exempt: a throwaway probe of the runner itself',
  );
  assert.deepEqual(infra([exempt]).errors, []);
  const above = workflow(
    '# image-pin-exempt: same probe, marked on the line above\ndocker run ubuntu:24.04',
  );
  assert.deepEqual(infra([above]).errors, []);
  const bare = infra([workflow('docker run ubuntu:24.04 # image-pin-exempt:')]).errors;
  assert.ok(bare.some((e) => /image-pin-exempt needs a reason/.test(e)));
  assert.ok(bare.some((e) => /ubuntu:24\.04 is not pinned/.test(e)));
});

test('variables: workflow env, ${{ env.X }}, shell defaults; anything unresolved fails closed', () => {
  const minio = `cgr.dev/x/minio:1@${A}`;
  const env = { env: { MINIO_IMAGE: minio } };
  assert.deepEqual(infra([workflow('docker run -d "$MINIO_IMAGE" server /data', env)]).errors, []);
  assert.deepEqual(
    infra([workflow('docker run -d ${{ env.MINIO_IMAGE }} server', env)]).errors,
    [],
  );
  assert.match(
    infra([
      workflow('docker run -d "$MINIO_IMAGE"', { env: { MINIO_IMAGE: 'minio/minio:latest' } }),
    ]).errors[0],
    notPinned,
  );
  assert.match(
    infra([workflow('docker run -d "$OTHER"')]).errors[0],
    /variable this check cannot resolve/,
  );
  assert.match(
    infra([workflow('docker run -d ${{ matrix.image }}')]).errors[0],
    /expression \$\{\{ matrix\.image \}\}, which this check cannot resolve/,
  );
  assert.match(
    infra([workflow('IMG=$(cat image.txt)\ndocker run "$IMG"')]).errors[0],
    /set from a command substitution/,
  );
  const script = (image) =>
    shell(
      `IMAGE="\${KAFKA_IMAGE:-${image}}"\ndocker run --rm --user 0 \\\n  --entrypoint bash "\${IMAGE}" /x.sh`,
    );
  assert.match(
    infra([script('apache/kafka:3.9.0')]).errors[0],
    /ci-up\.sh:2: image apache\/kafka:3\.9\.0 is not pinned/,
  );
  assert.deepEqual(infra([script(`apache/kafka:3.9.0@${A}`)]).errors, []);
});

test('a local tag of a pinned image is that image, across steps; a local tag of a moving one is not', () => {
  const steps = (source) =>
    workflowYaml(
      stringify({
        jobs: {
          a: {
            steps: [
              { run: `docker pull ${source}\ndocker tag ${source} \\\n  rasta/clamav-pinned:ci\n` },
              { run: 'docker run --rm rasta/clamav-pinned:ci -c true' },
            ],
          },
        },
      }),
    );
  assert.deepEqual(infra([steps(`clamav/clamav:1.5.4@${A}`)]).errors, []);
  const { errors } = infra([steps('clamav/clamav:1.5.4')]);
  assert.ok(errors.length >= 2, errors.join('\n')); // the pull, the tag's source, the run
  assert.ok(errors.some((e) => /rasta\/clamav-pinned:ci is not pinned/.test(e)));
});

test('one repository at two digests is refused, naming both places', () => {
  const { errors } = infra([
    compose(`services:\n  db:\n    image: ${PINNED}`),
    workflowYaml(
      stringify({ jobs: { a: { services: { pg: { image: `postgis/postgis:16-3.4@${B}` } } } } }),
    ),
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /postgis\/postgis is pinned at 2 digests/);
  assert.match(errors[0], /docker-compose\.yml:3/);
  assert.match(errors[0], /ci\.yml:\d+/);
});

test('DIGEST_VARIANTS names the exact digests: those pass, a third is refused, an unused one is stale (Codex finding 3)', () => {
  const policy = {
    digestVariants: new Map([['x/mc', { digests: [A, B], reason: 'two variants, on purpose' }]]),
    tagless: new Map(),
  };
  const at = (...digests) =>
    infra(
      [
        compose(
          `services:\n${digests.map((d, i) => `  s${i}:\n    image: x/mc:1@${d}`).join('\n')}`,
        ),
      ],
      policy,
    ).errors;
  assert.deepEqual(at(A, B), []);
  const third = at(A, B, C);
  assert.equal(third.length, 1);
  assert.match(
    third[0],
    new RegExp(`x/mc is pinned at ${C}, which is not one of the 2 digests DIGEST_VARIANTS allows`),
  );
  assert.match(
    at(A)[0],
    new RegExp(`DIGEST_VARIANTS allows x/mc@${B}, which nothing uses any more`),
  );
});

test('TAGLESS names exact references: listed ones pass, any other digest-only image is refused, an unused entry is stale (Codex finding 4)', () => {
  const policy = {
    digestVariants: new Map(),
    tagless: new Map([[`x/minio@${A}`, 'no tag published']]),
  };
  assert.deepEqual(infra([compose(`services:\n  m:\n    image: x/minio@${A}`)], policy).errors, []);
  assert.match(
    infra([compose(`services:\n  m:\n    image: x/minio@${B}`)], policy).errors.join('\n'),
    /x\/minio@sha256:b+ has no tag/,
  );
  assert.match(
    infra([compose(`services:\n  m:\n    image: x/minio:1@${A}`)], policy).errors[0],
    /TAGLESS lists x\/minio@sha256:a+, which nothing uses without a tag any more/,
  );
});

test('the committed exemptions say why and are exact', () => {
  for (const [repository, { digests, reason }] of DIGEST_VARIANTS) {
    assert.equal(digests.length, 2, repository);
    assert.ok(reason.length > 40, repository);
  }
  for (const [reference, reason] of TAGLESS) {
    assert.match(reference, /^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/);
    assert.match(reason, /could not be verified/);
  }
});

test('tokenizeShell joins continuations and splits at every separator', () => {
  const { commands } = tokenizeShell('a 1 \\\n  2; b && c || d | e\n# x\nf "g h" \'i\'');
  assert.deepEqual(
    commands.map((c) => c.words.map((w) => w.value).join(' ')),
    ['a 1 2', 'b', 'c', 'd', 'e', 'f g h i'],
  );
  assert.equal(commands[0].startLine, 0);
  assert.equal(commands.at(-1).startLine, 3);
});
