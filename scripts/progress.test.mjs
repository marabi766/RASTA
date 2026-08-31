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

test('the repository baseline is valid and preserves the approved horizons', () => {
  assert.deepEqual(validateBacklog(baseline), []);
  const progress = calculateProgress(baseline);
  assert.equal(progress.mvp.committed, 555);
  assert.equal(progress.mvp.earned, 178);
  assert.equal(progress.mvp.percent, 32.1);
  assert.equal(progress.fullProduct.committed, 770);
  assert.equal(progress.fullProduct.earned, 178);
  assert.equal(progress.fullProduct.percent, 23.1);
});

test('decomposed features contribute child stories exactly once', () => {
  const progress = calculateProgress(baseline);
  const documentFeature = baseline.items.find((feature) => feature.id === 'COM-004');
  const documentStories = baseline.stories.filter((story) => story.parentItemId === 'COM-004');
  assert.equal(
    documentStories.reduce((sum, story) => sum + story.points, 0),
    documentFeature.points,
  );
  assert.equal(progress.fullProduct.units, baseline.items.length - 1 + baseline.stories.length);
  assert.equal(progress.fullProduct.committed, 770);
});

test('an accepted story earns its own points before feature-level acceptance', () => {
  const backlog = copy();
  const story = backlog.stories.find((candidate) => candidate.id === 'DOC-001');
  story.status = 'ACCEPTED';
  story.evidence = [
    { kind: 'TEST', ref: 'DOC-001 acceptance', note: 'All story scenarios are verified.' },
  ];
  assert.deepEqual(validateBacklog(backlog), []);
  const progress = calculateProgress(backlog);
  assert.equal(progress.mvp.earned, 181);
  assert.equal(progress.mvp.committed, 555);
  assert.equal(progress.mvp.percent, 32.6);
});

test('accepted feature or story work without evidence cannot earn points', () => {
  const featureBacklog = copy();
  const feature = featureBacklog.items.find(
    (candidate) =>
      candidate.status !== 'ACCEPTED' &&
      !featureBacklog.stories.some((story) => story.parentItemId === candidate.id),
  );
  feature.status = 'ACCEPTED';
  feature.evidence = [];
  assert.ok(
    validateBacklog(featureBacklog).some((error) =>
      error.includes(`feature '${feature.id}' is ACCEPTED but has no evidence`),
    ),
  );

  const storyBacklog = copy();
  const story = storyBacklog.stories[0];
  story.status = 'ACCEPTED';
  story.evidence = [];
  assert.ok(
    validateBacklog(storyBacklog).some((error) =>
      error.includes(`story '${story.id}' is ACCEPTED but has no evidence`),
    ),
  );
});

test('cancelled legacy features and stories leave the active denominator', () => {
  const legacyBacklog = copy();
  const beforeLegacy = calculateProgress(legacyBacklog).mvp.committed;
  const feature = legacyBacklog.items.find((candidate) => candidate.id === 'PLAT-005');
  feature.status = 'CANCELLED';
  assert.equal(calculateProgress(legacyBacklog).mvp.committed, beforeLegacy - feature.points);

  const storyBacklog = copy();
  const beforeStory = calculateProgress(storyBacklog).mvp.committed;
  const story = storyBacklog.stories[0];
  story.status = 'CANCELLED';
  assert.equal(calculateProgress(storyBacklog).mvp.committed, beforeStory - story.points);
});

test('story decomposition must preserve the approved parent estimate', () => {
  const backlog = copy();
  backlog.stories[0].points = 2;
  assert.ok(
    validateBacklog(backlog).some((error) =>
      error.includes("feature 'COM-004' has 13 points but its stories total 12"),
    ),
  );
});

test('decomposition is recorded with approval and traceable record ids', () => {
  const backlog = copy();
  const entry = backlog.changeLog.find((candidate) => candidate.type === 'ITEM_DECOMPOSED');
  entry.approvalRef = null;
  entry.recordIds = ['COM-004', 'MISSING-001'];
  const errors = validateBacklog(backlog);
  assert.ok(errors.some((error) => error.includes('requires an approvalRef')));
  assert.ok(errors.some((error) => error.includes('existing parent and story recordIds')));
});

test('an accepted feature cannot contain an unfinished active story', () => {
  const backlog = copy();
  const feature = backlog.items.find((candidate) => candidate.id === 'COM-004');
  feature.status = 'ACCEPTED';
  feature.evidence = [{ kind: 'DOCUMENT', ref: 'acceptance', note: 'Feature-level acceptance.' }];
  assert.ok(
    validateBacklog(backlog).some((error) =>
      error.includes("feature 'COM-004' is ACCEPTED before all active stories are ACCEPTED"),
    ),
  );
});

test('feature and story dependency cycles are rejected', () => {
  const backlog = copy();
  backlog.stories.find((story) => story.id === 'DOC-001').dependencies = ['DOC-002'];
  const errors = validateBacklog(backlog);
  assert.ok(errors.some((error) => error.includes('dependency cycle')));
});

test('stories require a parent, a user narrative and Given/When/Then criteria', () => {
  const backlog = copy();
  const story = backlog.stories[0];
  story.parentItemId = 'MISSING-001';
  story.userStory.soThat = '';
  story.acceptanceCriteria[0].then = '';
  const errors = validateBacklog(backlog);
  assert.ok(errors.some((error) => error.includes("missing parent feature 'MISSING-001'")));
  assert.ok(errors.some((error) => error.includes('non-empty asA, iWant and soThat')));
  assert.ok(errors.some((error) => error.includes('Given/When/Then')));
});

test('forecast remains unavailable without two real closed iterations', () => {
  const report = renderProgressReport(baseline);
  assert.match(report, /Forecast[\s\S]+Unavailable/);
  assert.match(report, /Decomposition rule/);
  assert.match(report, /User Story state/);
  assert.match(report, new RegExp(`Baseline: \\*\\*${baseline.governance.baselineState}\\*\\*`));
});
