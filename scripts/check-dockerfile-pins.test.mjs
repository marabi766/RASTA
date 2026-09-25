import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDockerfilePins } from './check-dockerfile-pins-lib.mjs';

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
  assert.match(result.stdout, /12 Dockerfiles on one base/);
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
