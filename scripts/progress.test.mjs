import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { calculateProgress, renderProgressReport, validateBacklog } from './progress-lib.mjs';
import { validateBacklogSchema } from './progress-schema.mjs';

const backlogUrl = new URL('../planning/backlog.json', import.meta.url);
const schemaUrl = new URL('../planning/backlog.schema.json', import.meta.url);
const baseline = JSON.parse(await readFile(backlogUrl, 'utf8'));
const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));

function copy() {
  return structuredClone(baseline);
}

test('the repository baseline is valid and preserves the approved horizons', () => {
  assert.deepEqual(validateBacklog(baseline), []);
  const progress = calculateProgress(baseline);
  // The committed totals are the approved baseline and only an approved scope
  // or estimate change may move them. The earned figures move whenever an item
  // is accepted, so they are updated in the same commit as the acceptance —
  // that coupling is the point: a status change nobody meant to make fails here.
  assert.equal(progress.mvp.committed, 563);
  assert.equal(progress.mvp.earned, 385);
  assert.equal(progress.mvp.percent, 68.4);
  assert.equal(progress.fullProduct.committed, 786);
  assert.equal(progress.fullProduct.earned, 385);
  assert.equal(progress.fullProduct.percent, 49);
});

test('a logged acceptance names who decided and only records that are ACCEPTED', () => {
  const logged = baseline.changeLog.filter((entry) => entry.type === 'ITEM_ACCEPTED');
  assert.ok(logged.length > 0);
  assert.deepEqual(validateBacklog(baseline), []);

  const unapproved = copy();
  unapproved.changeLog.find((entry) => entry.type === 'ITEM_ACCEPTED').approvalRef = null;
  assert.ok(
    validateBacklog(unapproved).some(
      (error) => error.includes("'ITEM_ACCEPTED'") && error.includes('requires an approvalRef'),
    ),
  );
  assert.ok(
    validateBacklogSchema(unapproved, schema).some((error) => error.includes('approvalRef')),
  );

  // The log may not claim an acceptance the status contradicts, in either order
  // of mistake: a record withdrawn from ACCEPTED without a correction, or one
  // never accepted at all. (The withdrawn record's own STATUS_CORRECTED entry
  // in the baseline precedes its acceptance, so it explains nothing.)
  const withdrawn = copy();
  const id = logged[0].recordIds[0];
  withdrawn.items.find((item) => item.id === id).status = 'IN_PROGRESS';
  const notAccepted = copy();
  notAccepted.changeLog.find((entry) => entry.type === 'ITEM_ACCEPTED').recordIds = [
    notAccepted.items.find((item) => item.status === 'IN_PROGRESS').id,
  ];
  for (const backlog of [withdrawn, notAccepted]) {
    assert.ok(
      validateBacklog(backlog).some((error) =>
        error.includes('requires recordIds that exist and are ACCEPTED'),
      ),
    );
  }

  const missingIds = copy();
  delete missingIds.changeLog.find((entry) => entry.type === 'ITEM_ACCEPTED').recordIds;
  assert.ok(
    validateBacklogSchema(missingIds, schema).some((error) =>
      error.includes("must have required property 'recordIds'"),
    ),
  );
});

test('a mistaken acceptance is corrected by appending an approved STATUS_CORRECTED entry', () => {
  // docs/25 § 25.4: the acceptance stays in the log as history; a later
  // approved correction of the same record explains its current status.
  const acceptance = baseline.changeLog.find((entry) => entry.type === 'ITEM_ACCEPTED');
  const id = acceptance.recordIds[0];
  function withdrawnWith(...entries) {
    const backlog = copy();
    backlog.items.find((item) => item.id === id).status = 'IN_PROGRESS';
    backlog.changeLog.push(...entries);
    return backlog;
  }
  const correction = {
    date: acceptance.date,
    type: 'STATUS_CORRECTED',
    reason: `${id} was accepted by mistake and is back in progress.`,
    recordedBy: 'Project manager',
    approvalRef: 'Product owner correction, test fixture',
    recordIds: [id],
  };

  const corrected = withdrawnWith(correction);
  assert.deepEqual(validateBacklog(corrected), []);
  assert.deepEqual(validateBacklogSchema(corrected, schema), []);
  assert.deepEqual(
    corrected.changeLog.find((entry) => entry.type === 'ITEM_ACCEPTED'),
    acceptance,
  );

  // Anything short of that is still an unexplained contradiction.
  const otherId = baseline.items.find((item) => item.status === 'IN_PROGRESS').id;
  const reaccepted = withdrawnWith(correction, { ...acceptance, recordIds: [id] });
  const unexplained = {
    unapproved: withdrawnWith({ ...correction, approvalRef: null }),
    'blank approval': withdrawnWith({ ...correction, approvalRef: ' ' }),
    'another record': withdrawnWith({ ...correction, recordIds: [otherId] }),
    'dated before the acceptance': withdrawnWith({ ...correction, date: '2026-10-14' }),
    'a different change type': withdrawnWith({ ...correction, type: 'POINTS_CHANGED' }),
    're-accepted after the correction': reaccepted,
  };
  for (const [name, backlog] of Object.entries(unexplained)) {
    assert.ok(
      validateBacklog(backlog).some((error) =>
        error.includes('requires recordIds that exist and are ACCEPTED'),
      ),
      name,
    );
  }

  // A correction never vouches for a record that does not exist.
  const missing = withdrawnWith({ ...correction, recordIds: [id, 'NOPE-001'] });
  missing.changeLog.find((entry) => entry.type === 'ITEM_ACCEPTED').recordIds.push('NOPE-001');
  assert.ok(
    validateBacklog(missing).some((error) =>
      error.includes('requires recordIds that exist and are ACCEPTED'),
    ),
  );
});

test('the repository baseline satisfies its declared JSON Schema', () => {
  assert.deepEqual(validateBacklogSchema(baseline, schema), []);
});

test('the instance $schema keyword is declared, not tolerated by accident', () => {
  // The exact drift a Draft 2020-12 validator reported on PR #299: the schema
  // forbade additional properties and never declared the instance's `$schema`.
  const undeclared = structuredClone(schema);
  delete undeclared.properties.$schema;
  assert.deepEqual(validateBacklogSchema(baseline, undeclared), [
    "schema: / has unexpected property '$schema'",
  ]);
});

test('an undeclared property is refused at every level the schema closes', () => {
  const backlog = copy();
  backlog.owner = 'nobody';
  backlog.governance.velocity = 10;
  backlog.items[0].completion = 0.5;
  backlog.items[0].evidence.push({ kind: 'PR', ref: '#1', note: 'n', url: 'x' });
  backlog.stories[0].userStory.because = 'reasons';
  backlog.changeLog[0].approvedBy = 'someone';
  // The semantic validator does not look for unknown keys; the schema must.
  assert.deepEqual(validateBacklog(backlog), []);
  const errors = validateBacklogSchema(backlog, schema);
  for (const expected of [
    "/ has unexpected property 'owner'",
    "/governance has unexpected property 'velocity'",
    "/items/0 has unexpected property 'completion'",
    `/items/0/evidence/${backlog.items[0].evidence.length - 1} has unexpected property 'url'`,
    "/stories/0/userStory has unexpected property 'because'",
    "/changeLog/0 has unexpected property 'approvedBy'",
  ]) {
    assert.ok(errors.includes(`schema: ${expected}`), `missing: ${expected}\n${errors.join('\n')}`);
  }
  assert.equal(errors.length, 6);
});

test('schema formats are enforced where the semantic shape check is looser', () => {
  const backlog = copy();
  backlog.asOf = '2026-13-45';
  assert.deepEqual(validateBacklog(backlog), []);
  assert.deepEqual(validateBacklogSchema(backlog, schema), [
    'schema: /asOf must match format "date"',
  ]);
});

test('the progress command fails on a schema violation', async (t) => {
  const script = fileURLToPath(new URL('./progress.mjs', import.meta.url));
  const root = await mkdtemp(path.join(tmpdir(), 'progress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'planning'));
  await copyFile(schemaUrl, path.join(root, 'planning', 'backlog.schema.json'));
  const run = () =>
    spawnSync(process.execPath, [script, 'validate'], { cwd: root, encoding: 'utf8' });

  await copyFile(backlogUrl, path.join(root, 'planning', 'backlog.json'));
  const clean = run();
  assert.equal(clean.status, 0, clean.stderr);

  const backlog = copy();
  backlog.items[0].completion = 0.5;
  await writeFile(path.join(root, 'planning', 'backlog.json'), JSON.stringify(backlog));
  const drifted = run();
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /schema: \/items\/0 has unexpected property 'completion'/);
});

test('decomposed features contribute child stories exactly once', () => {
  const progress = calculateProgress(baseline);
  const documentFeature = baseline.items.find((feature) => feature.id === 'COM-004');
  const documentStories = baseline.stories.filter((story) => story.parentItemId === 'COM-004');
  assert.equal(
    documentStories.reduce((sum, story) => sum + story.points, 0),
    documentFeature.points,
  );
  // Each decomposed feature (COM-004, RUN-005) leaves the count and its stories join it.
  const decomposed = new Set(baseline.stories.map((story) => story.parentItemId)).size;
  assert.equal(
    progress.fullProduct.units,
    baseline.items.length - decomposed + baseline.stories.length,
  );
  assert.equal(progress.fullProduct.committed, 786);
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
  assert.equal(after.mvp.committed, 563);
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
