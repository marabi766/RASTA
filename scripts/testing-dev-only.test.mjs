import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @rasta/testing holds a test-only internal-token signer
 * (packages/testing/src/internal-token.ts). It stays out of every production
 * image only while both of these hold:
 *
 * - no workspace package lists it anywhere but devDependencies, so no
 *   production dependency chain reaches it;
 * - every service image is built with `pnpm deploy --prod` (devDependencies
 *   dropped) and its runtime stage copies nothing but that deploy directory.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const TESTING = '@rasta/testing';
const RUNTIME_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
];

/** Every workspace field other than devDependencies that names @rasta/testing. */
function manifestProblems(manifests) {
  const problems = [];
  for (const { name, manifest } of manifests) {
    for (const field of RUNTIME_FIELDS) {
      const value = manifest[field];
      const listed = Array.isArray(value) ? value.includes(TESTING) : value && TESTING in value;
      if (listed) problems.push(`${name}: ${TESTING} under ${field}; devDependencies only`);
    }
  }
  return problems;
}

/** A service image that could carry devDependencies into its runtime stage. */
function dockerfileProblems(dockerfiles) {
  const problems = [];
  for (const { name, text } of dockerfiles) {
    const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
    const deploys = lines.filter((line) => /^\s*RUN\b.*\bpnpm\b.*\bdeploy\b/.test(line));
    if (deploys.length === 0) problems.push(`${name}: no pnpm deploy step`);
    for (const line of deploys) {
      if (!/\s--prod(?:\s|$)/.test(line)) problems.push(`${name}: pnpm deploy without --prod`);
    }
    const stages = lines.reduce((all, line) => {
      if (/^\s*FROM\s/i.test(line)) all.push([]);
      all.at(-1)?.push(line);
      return all;
    }, []);
    for (const line of stages.at(-1) ?? []) {
      if (!/^\s*(?:COPY|ADD)\s/i.test(line)) continue;
      if (!/^\s*COPY\s+--from=build\s+(?:--chown=\S+\s+)?\/deploy\s+\.\/\s*$/.test(line)) {
        problems.push(`${name}: runtime stage copies more than /deploy: ${line.trim()}`);
      }
    }
  }
  return problems;
}

function workspaceManifests() {
  const manifests = [{ name: 'package.json', manifest: readJson(join(root, 'package.json')) }];
  for (const group of ['apps', 'services', 'packages', 'tests']) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      const file = join(root, group, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(file)) {
        manifests.push({ name: `${group}/${entry.name}/package.json`, manifest: readJson(file) });
      }
    }
  }
  return manifests;
}

function serviceDockerfiles() {
  return readdirSync(join(root, 'services'))
    .map((service) => `services/${service}/Dockerfile`)
    .filter((name) => existsSync(join(root, name)))
    .map((name) => ({ name, text: readFileSync(join(root, name), 'utf8') }));
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('no workspace package lists @rasta/testing outside devDependencies', () => {
  const manifests = workspaceManifests();
  assert.ok(manifests.length > 20, `only ${manifests.length} manifests found`);
  const consumers = manifests.filter(({ manifest }) => manifest.devDependencies?.[TESTING]);
  assert.ok(consumers.length >= 17, `only ${consumers.length} devDependency consumers found`);
  assert.deepEqual(manifestProblems(manifests), []);
});

test('every service image deploys --prod and its runtime stage copies only /deploy', () => {
  const dockerfiles = serviceDockerfiles();
  assert.equal(dockerfiles.length, 17);
  assert.deepEqual(dockerfileProblems(dockerfiles), []);
});

test('a runtime dependency on @rasta/testing is refused, in any runtime field', () => {
  for (const field of RUNTIME_FIELDS) {
    const value = field.startsWith('bundle') ? [TESTING] : { [TESTING]: 'workspace:*' };
    assert.equal(manifestProblems([{ name: 'x', manifest: { [field]: value } }]).length, 1, field);
  }
  assert.deepEqual(
    manifestProblems([{ name: 'x', manifest: { devDependencies: { [TESTING]: 'workspace:*' } } }]),
    [],
  );
});

test('a deploy without --prod, a missing deploy and a wider runtime copy are refused', () => {
  const image = (deploy, runtime = 'COPY --from=build --chown=rasta:rasta /deploy ./') => ({
    name: 'services/x/Dockerfile',
    text: ['FROM node AS build', deploy, 'FROM node AS runtime', runtime].join('\n'),
  });
  const prod = 'RUN CI=true pnpm --filter @rasta/x deploy --prod --legacy /deploy';
  assert.deepEqual(dockerfileProblems([image(prod)]), []);
  assert.deepEqual(
    dockerfileProblems([
      image('RUN --mount=type=cache,target=/c \\\n    pnpm deploy --prod /deploy'),
    ]),
    [],
  );
  assert.match(
    dockerfileProblems([image('RUN pnpm --filter @rasta/x deploy --legacy /deploy')])[0],
    /without --prod/,
  );
  assert.match(
    dockerfileProblems([image('RUN pnpm --filter @rasta/x deploy --production-ish /deploy')])[0],
    /without --prod/,
  );
  assert.match(dockerfileProblems([image('RUN pnpm build')])[0], /no pnpm deploy/);
  assert.match(
    dockerfileProblems([image(prod, 'COPY --from=build /app ./')])[0],
    /copies more than \/deploy/,
  );
  assert.match(
    dockerfileProblems([image(prod, 'COPY packages/testing ./testing')])[0],
    /copies more than \/deploy/,
  );
});
