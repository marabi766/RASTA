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
  assert.equal(progress.mvp.earned, 191);
  assert.equal(progress.mvp.percent, 34.4);
  assert.equal(progress.fullProduct.committed, 770);
  assert.equal(progress.fullProduct.earned, 191);
  assert.equal(progress.fullProduct.percent, 24.8);
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
  // Measured as a delta rather than against a pinned total, so the rule stays
  // under test no matter which stories the baseline has already accepted. The
  // earlier form asserted a fixed 178 -> 181 and silently stopped exercising
  // anything the moment DOC-001 was genuinely accepted: the mutation became a
  // no-op and the assertion held for the wrong reason.
  const backlog = copy();
  const story = backlog.stories.find((candidate) => candidate.id === 'DOC-001');
  const parent = backlog.items.find((candidate) => candidate.id === story.parentItemId);

  // A decomposed parent cannot be ACCEPTED while a child is not, so the parent
  // is withdrawn alongside the child to keep the intermediate state legal.
  story.status = 'IN_PROGRESS';
  parent.status = 'IN_PROGRESS';
  assert.deepEqual(validateBacklog(backlog), []);
  const before = calculateProgress(backlog);

  story.status = 'ACCEPTED';
  story.evidence = [
    { kind: 'TEST', ref: 'DOC-001 acceptance', note: 'All story scenarios are verified.' },
  ];
  assert.deepEqual(validateBacklog(backlog), []);
  const after = calculateProgress(backlog);

  // The story earns exactly its own points, and the still-unaccepted parent
  // contributes none of its own on top of them.
  assert.equal(after.mvp.earned - before.mvp.earned, story.points);
  assert.equal(after.mvp.committed, before.mvp.committed);
  assert.equal(after.mvp.committed, 555);
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
  // The unfinished child is created here rather than assumed. Once every DOC
  // story was accepted this test passed a feature with nothing outstanding and
  // proved nothing; the violating state has to be constructed to be detected.
  backlog.stories.find((story) => story.id === 'DOC-001').status = 'IN_PROGRESS';
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
