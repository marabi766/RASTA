import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CONTAINERS_JOB,
  compareCoverage,
  discoverDockerfileServices,
  extractMatrixServices,
  formatFindings,
  hasFindings,
} from './ci-image-matrix-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = await readFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

const dockerfileServices = discoverDockerfileServices(root);
const matrixServices = extractMatrixServices(workflow, CONTAINERS_JOB);

/**
 * Removes one service's line from the matrix in the workflow *text*, so the
 * negative controls below exercise the real parser rather than a hand-built
 * fixture. Anchored on a whole line, which the prose comment above the matrix
 * cannot match even though it names services.
 */
function withoutMatrixEntry(yaml, service) {
  const line = new RegExp(`^\\s*${service},?\\s*\\n`, 'm');
  assert.match(yaml, line, `expected to find a matrix line for '${service}' to remove`);
  return yaml.replace(line, '');
}

function withExtraMatrixEntry(yaml, service, after) {
  const line = new RegExp(`^(\\s*)(${after},?)\\s*$`, 'm');
  assert.match(yaml, line, `expected to find a matrix line for '${after}' to append after`);
  return yaml.replace(line, `$1$2\n$1${service},`);
}

test('every tracked Dockerfile is built and scanned by the containers matrix', () => {
  const findings = compareCoverage(dockerfileServices, matrixServices);
  assert.deepEqual(
    findings,
    { missingFromMatrix: [], staleInMatrix: [], duplicateMatrixEntries: [] },
    formatFindings(findings),
  );
});

test('the guard reads a non-empty set from both sides', () => {
  // Neither side is allowed to be empty. An empty set on either side makes the
  // comparison above pass without checking anything, which is the failure mode
  // this whole file exists to prevent.
  assert.ok(dockerfileServices.length > 0, 'no tracked services/*/Dockerfile discovered');
  assert.ok(matrixServices.length > 0, 'no services parsed out of the containers matrix');
});

test('a Dockerfile left out of the matrix fails the guard, and is named', () => {
  const omitted = matrixServices[matrixServices.length - 1];
  const broken = withoutMatrixEntry(workflow, omitted);
  assert.notEqual(broken, workflow, 'the negative control did not actually change the workflow');

  const reduced = extractMatrixServices(broken, CONTAINERS_JOB);
  assert.equal(reduced.length, matrixServices.length - 1);

  const findings = compareCoverage(dockerfileServices, reduced);
  assert.ok(hasFindings(findings), 'the guard passed while a shipped image went unscanned');
  assert.deepEqual(findings.missingFromMatrix, [omitted]);
  assert.deepEqual(findings.staleInMatrix, []);
  assert.match(formatFindings(findings), new RegExp(`services/${omitted}/Dockerfile`));
});

test('every service in turn is protected, not just the last one', () => {
  // Removing each entry one at a time proves the guard is a set comparison
  // rather than something that happens to notice one well-known name.
  for (const service of matrixServices) {
    const reduced = extractMatrixServices(withoutMatrixEntry(workflow, service), CONTAINERS_JOB);
    const findings = compareCoverage(dockerfileServices, reduced);
    assert.deepEqual(findings.missingFromMatrix, [service]);
  }
});

test('a matrix entry with no Dockerfile fails the guard too', () => {
  const phantom = 'no-such-service';
  const broken = withExtraMatrixEntry(workflow, phantom, matrixServices[0]);
  const inflated = extractMatrixServices(broken, CONTAINERS_JOB);
  assert.ok(inflated.includes(phantom));

  const findings = compareCoverage(dockerfileServices, inflated);
  assert.ok(hasFindings(findings));
  assert.deepEqual(findings.staleInMatrix, [phantom]);
  assert.deepEqual(findings.missingFromMatrix, []);
});

test('a duplicated matrix entry is reported rather than silently scanned twice', () => {
  const repeated = matrixServices[0];
  const broken = withExtraMatrixEntry(workflow, repeated, repeated);
  const findings = compareCoverage(
    dockerfileServices,
    extractMatrixServices(broken, CONTAINERS_JOB),
  );
  assert.deepEqual(findings.duplicateMatrixEntries, [repeated]);
});

test('the parser refuses to report an empty list as coverage', () => {
  assert.throws(
    () => extractMatrixServices('jobs:\n  build:\n    name: x\n'),
    /no 'containers:' job/,
  );
  assert.throws(
    () => extractMatrixServices('jobs:\n  containers:\n    name: x\n'),
    /no matrix 'service:' key/,
  );
  assert.throws(
    () =>
      extractMatrixServices(
        'jobs:\n  containers:\n    strategy:\n      matrix:\n        service: []\n',
      ),
    /parsed as empty/,
  );
  assert.throws(
    () =>
      extractMatrixServices(
        'jobs:\n  containers:\n    strategy:\n      matrix:\n        service: [a, b\n',
      ),
    /never closes/,
  );
});

test('the parser survives a block-sequence reformat of the same list', () => {
  const block = [
    'jobs:',
    '  containers:',
    '    strategy:',
    '      matrix:',
    '        # a comment naming identity-service should not become an entry',
    '        service:',
    '          - identity-service',
    '          - document-service # trailing comment',
    '    steps:',
    '      - run: echo ${{ matrix.service }}',
  ].join('\n');
  assert.deepEqual(extractMatrixServices(block), ['identity-service', 'document-service']);
});
