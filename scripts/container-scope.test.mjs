import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { servicesToBuild } from './container-scope-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'scripts', 'container-scope.mjs');
const ALL = ['api-gateway', 'fleet-service', 'identity-service'];

test('a push to main builds every image', () => {
  assert.deepEqual(servicesToBuild(ALL, 'all'), ALL);
});

test("a change inside one service builds that service's image only", () => {
  assert.deepEqual(servicesToBuild(ALL, ['services/fleet-service/src/main.ts']), ['fleet-service']);
  assert.deepEqual(servicesToBuild(ALL, ['services/api-gateway/Dockerfile']), ['api-gateway']);
});

test('a service name that is a prefix of another does not match it', () => {
  assert.deepEqual(servicesToBuild(['a', 'a-b'], ['services/a-b/x.ts']), ['a-b']);
});

for (const path of [
  'packages/nest-common/src/index.ts',
  'pnpm-lock.yaml',
  'package.json',
  'tsconfig.base.json',
  '.dockerignore',
  'turbo.json',
  'scripts/copy-prisma-client.mjs',
  '.github/workflows/ci.yml',
]) {
  test(`${path} is read by every build, so every image is rebuilt`, () => {
    assert.deepEqual(servicesToBuild(ALL, ['docs/x.md', path]), ALL);
  });
}

for (const path of [
  'docs/26-branch-registry.md',
  'apps/web/src/app/page.tsx',
  'tests/e2e/a.ts',
  'scripts/other.mjs',
]) {
  test(`${path} builds no image`, () => {
    assert.deepEqual(servicesToBuild(ALL, [path]), []);
  });
}

test('the CLI covers every service with a Dockerfile on --all', () => {
  const expected = readdirSync(join(root, 'services'))
    .filter((name) => existsSync(join(root, 'services', name, 'Dockerfile')))
    .sort();
  const result = spawnSync(process.execPath, [CLI, '--all'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.ok(expected.length >= 12);
});

test('the CLI reads changed paths from stdin', () => {
  const result = spawnSync(process.execPath, [CLI], {
    input: 'services/supplier-service/src/a.ts\ndocs/b.md\n',
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(result.stdout), ['supplier-service']);
});
