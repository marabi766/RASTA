import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { calculateProgress, renderProgressReport, validateBacklog } from './progress-lib.mjs';

const baseline = JSON.parse(
  await readFile(new URL('../planning/backlog.json', import.meta.url), 'utf8'),
);

function copy() {
  return structuredClone(baseline);
}

test('the repository baseline is valid and produces separate horizons', () => {
  assert.deepEqual(validateBacklog(baseline), []);
  const progress = calculateProgress(baseline);
  assert.ok(progress.mvp.committed > 0);
  assert.ok(progress.fullProduct.committed > progress.mvp.committed);
  assert.equal(progress.mvp.earned, progress.fullProduct.earned);
});

test('accepted work without evidence cannot earn points', () => {
  const backlog = copy();
  backlog.items.find((item) => item.id === 'PLAT-005').status = 'ACCEPTED';
  const errors = validateBacklog(backlog);
  assert.ok(
    errors.some((error) => error.includes("item 'PLAT-005' is ACCEPTED but has no evidence")),
  );
});

test('cancelled work is removed from the denominator', () => {
  const backlog = copy();
  const before = calculateProgress(backlog).mvp.committed;
  const item = backlog.items.find((candidate) => candidate.id === 'PLAT-005');
  item.status = 'CANCELLED';
  assert.equal(calculateProgress(backlog).mvp.committed, before - item.points);
});

test('dependency cycles are rejected', () => {
  const backlog = copy();
  backlog.items.find((item) => item.id === 'PLAT-001').dependencies = ['PLAT-002'];
  const errors = validateBacklog(backlog);
  assert.ok(errors.some((error) => error.includes('dependency cycle')));
});

test('forecast remains unavailable without two real closed iterations', () => {
  const report = renderProgressReport(baseline);
  assert.match(report, /Forecast[\s\S]+Unavailable/);
  assert.match(report, /PROVISIONAL/);
});
