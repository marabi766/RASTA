import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_CONCURRENCY, unitStepProblems } from './check-unit-step-concurrency.mjs';

const realWorkflow = readFileSync(
  fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)),
  'utf8',
);

const workflow = (run, name = 'Unit tests') =>
  ['jobs:', '  quality:', '    steps:', `      - name: ${name}`, `        run: ${run}`, ''].join(
    '\n',
  );

test('the real workflow bounds the unit step', () => {
  assert.deepEqual(unitStepProblems(realWorkflow), []);
});

test('a bounded step passes at every allowed value', () => {
  for (let n = 1; n <= MAX_CONCURRENCY; n += 1) {
    assert.deepEqual(unitStepProblems(workflow(`pnpm run test:unit --concurrency=${n}`)), []);
  }
});

test('turbo default (no flag), an over-limit value and a zero are refused', () => {
  for (const run of [
    'pnpm run test:unit',
    `pnpm run test:unit --concurrency=${MAX_CONCURRENCY + 1}`,
    'pnpm run test:unit --concurrency=10',
    'pnpm run test:unit --concurrency=0',
    'pnpm run test:unit --concurrency=50%',
  ]) {
    assert.equal(unitStepProblems(workflow(run)).length, 1, run);
  }
});

test('the flag must reach turbo, not jest: a `--` before it is refused', () => {
  assert.equal(unitStepProblems(workflow('pnpm run test:unit -- --concurrency=3')).length, 1);
});

test('a renamed, removed or duplicated step is refused rather than skipped', () => {
  assert.equal(unitStepProblems(workflow('pnpm run test:unit --concurrency=3', 'Tests')).length, 1);
  assert.equal(unitStepProblems('jobs:\n  quality:\n    steps: []\n').length, 1);
  assert.equal(unitStepProblems('jobs: {}\n').length, 1);
  const twice = `${workflow('pnpm run test:unit --concurrency=3')}      - name: Unit tests\n        run: pnpm run test:unit\n`;
  assert.equal(unitStepProblems(twice).length, 1);
});
