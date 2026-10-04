import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIGEST_VARIANTS,
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

const compose = (text) => ({ name: 'docker-compose.yml', kind: 'compose', text });
const workflow = (text) => ({ name: '.github/workflows/ci.yml', kind: 'workflow', text });
const shell = (text) => ({ name: 'infrastructure/x/ci-up.sh', kind: 'shell', text });
const infra = (...files) => validateInfraImagePins(files);
const PINNED = `postgis/postgis:16-3.4@${A}`;

test('a pinned compose image, tag and digest, is accepted; a digest-only one too', () => {
  const { errors, images } = infra(
    compose(`services:\n  postgres:\n    image: ${PINNED}\n  x:\n    image: 'clamav/clamav@${B}'`),
  );
  assert.deepEqual(errors, []);
  assert.equal(images.length, 2);
});

test('a tag-only image is refused in compose, in services:, in container: and in a uses: docker:// step', () => {
  const tagOnly = [
    compose('services:\n  redis:\n    image: redis:7.4-alpine'),
    workflow('jobs:\n  a:\n    services:\n      redis:\n        image: redis:7.4-alpine'),
    workflow('jobs:\n  a:\n    container: node:22-alpine'),
    workflow('jobs:\n  a:\n    steps:\n      - uses: docker://alpine:3.20'),
  ];
  for (const file of tagOnly) {
    const { errors } = infra(file);
    assert.equal(errors.length, 1, file.text);
    assert.match(errors[0], /is not pinned by digest/);
  }
});

test('a truncated or malformed digest is not a pin', () => {
  assert.match(infra(compose('    image: redis:7.4-alpine@sha256:abc')).errors[0], /not pinned/);
  assert.match(
    infra(compose(`    image: redis:7.4-alpine@sha512:${'a'.repeat(64)}`)).errors[0],
    /not pinned/,
  );
});

test('docker run, create and pull: the image is found past every option, across continuations', () => {
  const run = [
    'run: |',
    '  docker run -d --name kc --network host \\',
    '    -e A=1 -v "$PWD/x:/y:ro" --user 100:101 --entrypoint sh \\',
    '    quay.io/keycloak/keycloak:26.0 \\',
    '    start-dev',
  ].join('\n');
  const { errors } = infra(workflow(run));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ci\.yml:2: image quay\.io\/keycloak\/keycloak:26\.0 is not pinned/);

  assert.deepEqual(infra(workflow(run.replace('keycloak:26.0', `keycloak:26.0@${A}`))).errors, []);
  assert.match(infra(workflow('  docker pull semgrep/semgrep:1.175.0')).errors[0], /not pinned/);
  assert.match(infra(workflow('  docker create --rm redis:7.4-alpine')).errors[0], /not pinned/);
});

test('a docker option the check does not know fails closed rather than guessing', () => {
  const { errors } = infra(workflow(`  docker run --frobnicate x ${PINNED}`));
  assert.match(errors[0], /cannot tell whether docker option --frobnicate takes a value/);
});

test('a comment that mentions docker run is not a command', () => {
  assert.deepEqual(
    infra(workflow('  # `docker run` rather than a services: container')).errors,
    [],
  );
});

test('an image in a workflow *_IMAGE variable is checked where it is defined and resolved where it runs', () => {
  const pinned = workflow(
    `env:\n  MINIO_IMAGE: '${`cgr.dev/chainguard/minio@${A}`}'\njobs:\n  - run: docker run -d "$MINIO_IMAGE" server /data`,
  );
  assert.deepEqual(infra(pinned).errors, []);
  const unpinned = workflow(
    `env:\n  MINIO_IMAGE: 'minio/minio:latest'\njobs:\n  - run: docker run -d "$MINIO_IMAGE"`,
  );
  assert.match(infra(unpinned).errors[0], /MINIO_IMAGE|minio\/minio:latest is not pinned/);
  const unknown = workflow('  docker run -d "$OTHER_IMAGE"');
  assert.match(infra(unknown).errors[0], /variable this check cannot resolve/);
  const expression = workflow('  docker run -d ${{ matrix.image }}');
  assert.match(infra(expression).errors[0], /not pinned/);
});

test('a shell default is the image a CI script runs: tag-only refused, pinned accepted', () => {
  const script = (image) =>
    shell(
      `IMAGE="\${KAFKA_IMAGE:-${image}}"\ndocker run --rm --user 0 \\\n  --entrypoint bash "\${IMAGE}" /x.sh`,
    );
  assert.match(
    infra(script('apache/kafka:3.9.0')).errors[0],
    /ci-up\.sh:1: image apache\/kafka:3\.9\.0 is not pinned/,
  );
  assert.deepEqual(infra(script(`apache/kafka:3.9.0@${A}`)).errors, []);
});

test('a local tag of a pinned image is that image; a local tag of a moving one is not', () => {
  const retag = (source) =>
    workflow(
      `  docker pull ${source}\n  docker tag ${source} \\\n    rasta/clamav-pinned:ci\n  docker run --rm rasta/clamav-pinned:ci -c true`,
    );
  assert.deepEqual(infra(retag(`clamav/clamav:1.5.4@${A}`)).errors, []);
  const { errors } = infra(retag('clamav/clamav:1.5.4'));
  assert.equal(errors.length, 2); // the pull, and the run of a tag nothing pinned
});

test('compose and CI on two digests of one repository are refused, naming both places', () => {
  const { errors } = infra(
    compose(`    image: ${PINNED}`),
    workflow(`        image: postgis/postgis:16-3.4@${B}`),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /postgis\/postgis is pinned at 2 digests/);
  assert.match(errors[0], /docker-compose\.yml:1/);
  assert.match(errors[0], /ci\.yml:1/);
});

test('DIGEST_VARIANTS: a listed repository may differ, and the entry is refused once it no longer does', () => {
  const [repository, reason] = [...DIGEST_VARIANTS][0];
  assert.ok(reason.length > 20, 'every variant says why');
  const both = infra(
    compose(`    image: ${repository}@${A}`),
    workflow(`  MC_IMAGE: '${repository}@${B}'`),
  );
  assert.deepEqual(both.errors, []);
  const one = infra(
    compose(`    image: ${repository}@${A}`),
    workflow(`  MC_IMAGE: '${repository}@${A}'`),
  );
  assert.match(one.errors[0], /no longer pinned at two digests/);
});
