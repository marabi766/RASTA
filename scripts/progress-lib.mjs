const VALID_SCOPES = new Set(['MVP', 'POST_MVP']);
const VALID_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const VALID_STATUSES = new Set([
  'PROPOSED',
  'READY',
  'IN_PROGRESS',
  'BLOCKED',
  'ACCEPTED',
  'CANCELLED',
]);
const VALID_EVIDENCE_KINDS = new Set(['COMMIT', 'PR', 'CI', 'TEST', 'RUNTIME', 'DOCUMENT']);
const VALID_CHANGE_TYPES = new Set([
  'BASELINE_CREATED',
  'SCOPE_ADDED',
  'SCOPE_REMOVED',
  'POINTS_CHANGED',
  'STATUS_CORRECTED',
  'BASELINE_APPROVED',
  'ITEM_DECOMPOSED',
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function percent(earned, committed) {
  return committed === 0 ? 0 : Number(((earned / committed) * 100).toFixed(1));
}

function uniqueErrors(values, label) {
  const seen = new Set();
  const errors = [];
  for (const value of values) {
    if (seen.has(value)) errors.push(`${label} '${value}' is duplicated`);
    seen.add(value);
  }
  return errors;
}

function findDependencyCycles(recordsById) {
  const errors = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(id, path) {
    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id);
      errors.push(`dependency cycle: ${[...path.slice(cycleStart), id].join(' -> ')}`);
      return;
    }
    if (visited.has(id)) return;

    visiting.add(id);
    const record = recordsById.get(id);
    for (const dependency of record?.dependencies ?? []) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of recordsById.keys()) visit(id, []);
  return [...new Set(errors)];
}

function validateEvidence(record, label, errors) {
  if (!Array.isArray(record.evidence)) {
    errors.push(`${label} evidence must be an array`);
    return;
  }
  if (record.status === 'ACCEPTED' && record.evidence.length === 0) {
    errors.push(`${label} is ACCEPTED but has no evidence`);
  }
  for (const evidence of record.evidence) {
    if (!VALID_EVIDENCE_KINDS.has(evidence.kind)) {
      errors.push(`${label} has invalid evidence kind`);
    }
    if (!isNonEmptyString(evidence.ref) || !isNonEmptyString(evidence.note)) {
      errors.push(`${label} has incomplete evidence`);
    }
  }
}

function validateReferences(record, label, errors) {
  if (
    !Array.isArray(record.sourceRefs) ||
    record.sourceRefs.length === 0 ||
    record.sourceRefs.some((ref) => !isNonEmptyString(ref))
  ) {
    errors.push(`${label} requires at least one source reference`);
  }
  if (!Array.isArray(record.dependencies)) {
    errors.push(`${label} dependencies must be an array`);
  }
}

export function validateBacklog(backlog) {
  const errors = [];
  if (backlog === null || typeof backlog !== 'object' || Array.isArray(backlog)) {
    return ['backlog must be an object'];
  }

  if (backlog.version !== 2) errors.push('version must be 2');
  if (backlog.project !== 'RASTA') errors.push("project must be 'RASTA'");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(backlog.asOf ?? '')) errors.push('asOf must be YYYY-MM-DD');

  const governance = backlog.governance ?? {};
  const expectedScale = '1,2,3,5,8,13,21';
  if ((governance.pointScale ?? []).join(',') !== expectedScale) {
    errors.push(`pointScale must be ${expectedScale}`);
  }
  if (!['PROVISIONAL', 'APPROVED'].includes(governance.baselineState)) {
    errors.push('baselineState must be PROVISIONAL or APPROVED');
  }
  if (governance.baselineState === 'APPROVED' && !isNonEmptyString(governance.approvedBy)) {
    errors.push('an APPROVED baseline requires approvedBy');
  }
  if (governance.earnedStatus !== 'ACCEPTED') errors.push('earnedStatus must be ACCEPTED');
  if (governance.cancelledStatus !== 'CANCELLED') errors.push('cancelledStatus must be CANCELLED');
  if (
    !Number.isInteger(governance.minimumClosedIterationsForForecast) ||
    governance.minimumClosedIterationsForForecast < 2
  ) {
    errors.push('minimumClosedIterationsForForecast must be an integer >= 2');
  }

  const epics = Array.isArray(backlog.epics) ? backlog.epics : [];
  const features = Array.isArray(backlog.items) ? backlog.items : [];
  const stories = Array.isArray(backlog.stories) ? backlog.stories : [];
  const iterations = Array.isArray(backlog.iterations) ? backlog.iterations : [];
  const changeLog = Array.isArray(backlog.changeLog) ? backlog.changeLog : [];
  if (!Array.isArray(backlog.epics)) errors.push('epics must be an array');
  if (!Array.isArray(backlog.items)) errors.push('items must be an array');
  if (!Array.isArray(backlog.stories)) errors.push('stories must be an array');
  if (!Array.isArray(backlog.iterations)) errors.push('iterations must be an array');
  if (!Array.isArray(backlog.changeLog) || changeLog.length === 0) {
    errors.push('changeLog must be a non-empty array');
  }

  errors.push(
    ...uniqueErrors(
      epics.map((epic) => epic.id),
      'epic id',
    ),
  );
  errors.push(
    ...uniqueErrors(
      features.map((feature) => feature.id),
      'feature id',
    ),
  );
  errors.push(
    ...uniqueErrors(
      stories.map((story) => story.id),
      'story id',
    ),
  );
  errors.push(
    ...uniqueErrors(
      [...features.map((feature) => feature.id), ...stories.map((story) => story.id)],
      'backlog record id',
    ),
  );
  errors.push(
    ...uniqueErrors(
      iterations.map((iteration) => iteration.id),
      'iteration id',
    ),
  );

  const epicsById = new Map(epics.map((epic) => [epic.id, epic]));
  const featuresById = new Map(features.map((feature) => [feature.id, feature]));
  const storiesByParent = new Map();
  for (const story of stories) {
    const siblings = storiesByParent.get(story.parentItemId) ?? [];
    siblings.push(story);
    storiesByParent.set(story.parentItemId, siblings);
  }
  const recordsById = new Map([
    ...features.map((feature) => [feature.id, feature]),
    ...stories.map((story) => [story.id, story]),
  ]);
  const iterationsById = new Map(iterations.map((iteration) => [iteration.id, iteration]));
  const scale = new Set(governance.pointScale ?? []);

  for (const epic of epics) {
    if (!/^EP-[A-Z0-9-]+$/.test(epic.id ?? '')) errors.push(`epic '${epic.id}' has an invalid id`);
    if (!isNonEmptyString(epic.title)) errors.push(`epic '${epic.id}' requires a title`);
    if (!VALID_SCOPES.has(epic.scope)) errors.push(`epic '${epic.id}' has an invalid scope`);
    if (!isNonEmptyString(epic.owner)) errors.push(`epic '${epic.id}' requires an owner`);
  }

  for (const iteration of iterations) {
    if (!/^IT-[A-Z0-9-]+$/.test(iteration.id ?? '')) {
      errors.push(`iteration '${iteration.id}' has an invalid id`);
    }
    if (!['PLANNED', 'ACTIVE', 'CLOSED'].includes(iteration.status)) {
      errors.push(`iteration '${iteration.id}' has an invalid status`);
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(iteration.startDate ?? '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(iteration.endDate ?? '')
    ) {
      errors.push(`iteration '${iteration.id}' requires YYYY-MM-DD dates`);
    } else if (iteration.startDate > iteration.endDate) {
      errors.push(`iteration '${iteration.id}' ends before it starts`);
    }
  }

  for (const feature of features) {
    const label = `feature '${feature.id}'`;
    if (!/^[A-Z]+-[0-9]{3}$/.test(feature.id ?? '')) errors.push(`${label} has an invalid id`);
    if (!isNonEmptyString(feature.title)) errors.push(`${label} requires a title`);
    if (!VALID_SCOPES.has(feature.scope)) errors.push(`${label} has an invalid scope`);
    if (!VALID_PRIORITIES.has(feature.priority)) errors.push(`${label} has an invalid priority`);
    if (!VALID_STATUSES.has(feature.status)) errors.push(`${label} has an invalid status`);
    if (!scale.has(feature.points)) {
      errors.push(`${label} points must use the configured Fibonacci scale`);
    }
    if (
      !Array.isArray(feature.acceptanceCriteria) ||
      feature.acceptanceCriteria.length === 0 ||
      feature.acceptanceCriteria.some((criterion) => !isNonEmptyString(criterion))
    ) {
      errors.push(`${label} requires non-empty acceptance criteria`);
    }
    validateReferences(feature, label, errors);
    validateEvidence(feature, label, errors);

    const epic = epicsById.get(feature.epicId);
    if (!epic) errors.push(`${label} references missing epic '${feature.epicId}'`);
    else if (epic.scope !== feature.scope) {
      errors.push(`${label} scope does not match epic '${epic.id}'`);
    }

    if (feature.scope === 'POST_MVP' && feature.priority !== 'P3') {
      errors.push(`${label} must use P3 in POST_MVP scope`);
    }
    if (feature.scope === 'MVP' && feature.priority === 'P3') {
      errors.push(`${label} cannot use P3 in MVP scope`);
    }

    for (const dependency of feature.dependencies ?? []) {
      if (dependency === feature.id) errors.push(`${label} cannot depend on itself`);
      else if (!recordsById.has(dependency)) {
        errors.push(`${label} references missing dependency '${dependency}'`);
      }
    }
    if (feature.targetIteration !== undefined && !iterationsById.has(feature.targetIteration)) {
      errors.push(`${label} references missing iteration '${feature.targetIteration}'`);
    }
  }

  for (const story of stories) {
    const label = `story '${story.id}'`;
    if (!/^[A-Z]+-[0-9]{3}$/.test(story.id ?? '')) errors.push(`${label} has an invalid id`);
    if (!isNonEmptyString(story.title)) errors.push(`${label} requires a title`);
    if (!scale.has(story.points))
      errors.push(`${label} points must use the configured Fibonacci scale`);
    if (!VALID_STATUSES.has(story.status)) errors.push(`${label} has an invalid status`);

    const parent = featuresById.get(story.parentItemId);
    if (!parent) errors.push(`${label} references missing parent feature '${story.parentItemId}'`);

    const userStory = story.userStory ?? {};
    if (
      !isNonEmptyString(userStory.asA) ||
      !isNonEmptyString(userStory.iWant) ||
      !isNonEmptyString(userStory.soThat)
    ) {
      errors.push(`${label} requires non-empty asA, iWant and soThat fields`);
    }
    if (
      !Array.isArray(story.acceptanceCriteria) ||
      story.acceptanceCriteria.length === 0 ||
      story.acceptanceCriteria.some(
        (scenario) =>
          scenario === null ||
          typeof scenario !== 'object' ||
          !isNonEmptyString(scenario.given) ||
          !isNonEmptyString(scenario.when) ||
          !isNonEmptyString(scenario.then),
      )
    ) {
      errors.push(`${label} requires non-empty Given/When/Then acceptance criteria`);
    }
    validateReferences(story, label, errors);
    validateEvidence(story, label, errors);

    for (const dependency of story.dependencies ?? []) {
      if (dependency === story.id) errors.push(`${label} cannot depend on itself`);
      else if (!recordsById.has(dependency)) {
        errors.push(`${label} references missing dependency '${dependency}'`);
      }
    }
    if (story.targetIteration !== undefined && !iterationsById.has(story.targetIteration)) {
      errors.push(`${label} references missing iteration '${story.targetIteration}'`);
    }
  }

  for (const [parentId, childStories] of storiesByParent) {
    const parent = featuresById.get(parentId);
    if (!parent) continue;

    const childPoints = childStories.reduce((sum, story) => sum + story.points, 0);
    if (childPoints !== parent.points) {
      errors.push(
        `feature '${parentId}' has ${parent.points} points but its stories total ${childPoints}`,
      );
    }

    const activeStories = childStories.filter((story) => story.status !== 'CANCELLED');
    if (
      parent.status === 'ACCEPTED' &&
      activeStories.some((story) => story.status !== 'ACCEPTED')
    ) {
      errors.push(`feature '${parentId}' is ACCEPTED before all active stories are ACCEPTED`);
    }
    if (
      parent.status === 'CANCELLED' &&
      childStories.some((story) => story.status !== 'CANCELLED')
    ) {
      errors.push(`feature '${parentId}' is CANCELLED but has an active story`);
    }
  }

  for (const entry of changeLog) {
    const label = `change log entry '${entry.type}' on '${entry.date}'`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date ?? '')) {
      errors.push(`${label} requires a YYYY-MM-DD date`);
    }
    if (!VALID_CHANGE_TYPES.has(entry.type)) errors.push(`${label} has an invalid type`);
    if (!isNonEmptyString(entry.reason) || !isNonEmptyString(entry.recordedBy)) {
      errors.push(`${label} requires a reason and recordedBy`);
    }
    if (entry.type === 'ITEM_DECOMPOSED') {
      if (!isNonEmptyString(entry.approvalRef)) {
        errors.push(`${label} requires an approvalRef`);
      }
      if (
        !Array.isArray(entry.recordIds) ||
        entry.recordIds.length < 2 ||
        entry.recordIds.some((id) => !recordsById.has(id))
      ) {
        errors.push(`${label} requires existing parent and story recordIds`);
      }
    }
  }

  errors.push(...findDependencyCycles(recordsById));

  if (governance.baselineState === 'APPROVED') {
    const hasApproval = changeLog.some(
      (entry) => entry.type === 'BASELINE_APPROVED' && isNonEmptyString(entry.approvalRef),
    );
    if (!hasApproval) {
      errors.push(
        'an APPROVED baseline requires a BASELINE_APPROVED change-log entry with approvalRef',
      );
    }
  }

  return errors;
}

function toDeliveryUnits(backlog) {
  const storiesByParent = new Map();
  for (const story of backlog.stories) {
    const siblings = storiesByParent.get(story.parentItemId) ?? [];
    siblings.push(story);
    storiesByParent.set(story.parentItemId, siblings);
  }

  return backlog.items.flatMap((feature) => {
    const stories = storiesByParent.get(feature.id) ?? [];
    if (stories.length === 0) return [{ ...feature, kind: 'FEATURE' }];
    return stories.map((story) => ({
      ...story,
      kind: 'STORY',
      epicId: feature.epicId,
      scope: feature.scope,
      priority: feature.priority,
      parentStatus: feature.status,
    }));
  });
}

function summarize(units) {
  const active = units.filter(
    (unit) => unit.status !== 'CANCELLED' && unit.parentStatus !== 'CANCELLED',
  );
  const committed = active.reduce((sum, unit) => sum + unit.points, 0);
  const accepted = active.filter((unit) => unit.status === 'ACCEPTED');
  const earned = accepted.reduce((sum, unit) => sum + unit.points, 0);
  return {
    units: active.length,
    acceptedUnits: accepted.length,
    committed,
    earned,
    remaining: committed - earned,
    percent: percent(earned, committed),
  };
}

function countRecords(records) {
  const active = records.filter((record) => record.status !== 'CANCELLED');
  return {
    active: active.length,
    accepted: active.filter((record) => record.status === 'ACCEPTED').length,
  };
}

export function calculateProgress(backlog) {
  const featureById = new Map(backlog.items.map((feature) => [feature.id, feature]));
  const deliveryUnits = toDeliveryUnits(backlog);
  const activeUnits = deliveryUnits.filter(
    (unit) => unit.status !== 'CANCELLED' && unit.parentStatus !== 'CANCELLED',
  );
  const closedIterations = backlog.iterations.filter((iteration) => iteration.status === 'CLOSED');
  const iterationVelocity = closedIterations.map((iteration) => ({
    id: iteration.id,
    points: activeUnits
      .filter((unit) => unit.targetIteration === iteration.id && unit.status === 'ACCEPTED')
      .reduce((sum, unit) => sum + unit.points, 0),
  }));
  const canForecast =
    closedIterations.length >= backlog.governance.minimumClosedIterationsForForecast;
  const averageVelocity = canForecast
    ? Number(
        (
          iterationVelocity.reduce((sum, iteration) => sum + iteration.points, 0) /
          iterationVelocity.length
        ).toFixed(1),
      )
    : null;

  const byStatus = Object.fromEntries(
    [...VALID_STATUSES].map((status) => [
      status,
      summarize(activeUnits.filter((unit) => unit.status === status)),
    ]),
  );
  const featureByStatus = Object.fromEntries(
    [...VALID_STATUSES].map((status) => [
      status,
      backlog.items.filter((feature) => feature.status === status),
    ]),
  );
  const storyByStatus = Object.fromEntries(
    [...VALID_STATUSES].map((status) => [
      status,
      backlog.stories.filter((story) => story.status === status),
    ]),
  );
  const byEpic = backlog.epics.map((epic) => ({
    ...epic,
    ...summarize(activeUnits.filter((unit) => unit.epicId === epic.id)),
    features: countRecords(backlog.items.filter((feature) => feature.epicId === epic.id)),
    stories: countRecords(
      backlog.stories.filter((story) => featureById.get(story.parentItemId)?.epicId === epic.id),
    ),
  }));

  function horizon(scope) {
    return {
      ...summarize(activeUnits.filter((unit) => scope === undefined || unit.scope === scope)),
      features: countRecords(
        backlog.items.filter((feature) => scope === undefined || feature.scope === scope),
      ),
      stories: countRecords(
        backlog.stories.filter((story) => {
          const parent = featureById.get(story.parentItemId);
          return scope === undefined || parent?.scope === scope;
        }),
      ),
    };
  }

  return {
    mvp: horizon('MVP'),
    postMvp: horizon('POST_MVP'),
    fullProduct: horizon(),
    byStatus,
    featureByStatus,
    storyByStatus,
    byEpic,
    forecast: {
      available: canForecast,
      closedIterations: closedIterations.length,
      averageVelocity,
      iterationVelocity,
    },
  };
}

function markdownTable(headers, rows) {
  const header = `| ${headers.join(' | ')} |`;
  const divider = `| ${headers.map(() => '---').join(' | ')} |`;
  return [header, divider, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
}

export function renderProgressReport(backlog) {
  const progress = calculateProgress(backlog);
  const scopeRows = [
    ['MVP', progress.mvp],
    ['Post-MVP only', progress.postMvp],
    ['Full product', progress.fullProduct],
  ].map(([name, summary]) => [
    name,
    summary.earned,
    summary.committed,
    summary.remaining,
    `${summary.percent}%`,
    summary.acceptedUnits,
    summary.units,
    summary.features.active,
    summary.stories.active,
  ]);
  const epicRows = progress.byEpic.map((epic) => [
    epic.id,
    epic.title,
    epic.scope,
    epic.earned,
    epic.committed,
    `${epic.percent}%`,
    epic.features.active,
    epic.stories.active,
  ]);
  const deliveryStatusRows = [...VALID_STATUSES].map((status) => {
    const summary = progress.byStatus[status];
    return [status, summary.units, summary.committed];
  });
  const featureStatusRows = [...VALID_STATUSES].map((status) => {
    const features = progress.featureByStatus[status];
    return [status, features.length, features.reduce((sum, feature) => sum + feature.points, 0)];
  });
  const storyStatusRows = [...VALID_STATUSES].map((status) => {
    const stories = progress.storyByStatus[status];
    return [status, stories.length, stories.reduce((sum, story) => sum + story.points, 0)];
  });

  const forecast = progress.forecast.available
    ? `Average accepted velocity is **${progress.forecast.averageVelocity} points/iteration**, based on ${progress.forecast.closedIterations} closed iterations. This is historical throughput, not a commitment.`
    : `**Unavailable.** ${progress.forecast.closedIterations} closed iterations exist; at least ${backlog.governance.minimumClosedIterationsForForecast} are required before velocity or a completion forecast may be shown.`;
  const baselineWarning =
    backlog.governance.baselineState === 'APPROVED'
      ? `Approved by **${backlog.governance.approvedBy}**.`
      : '**The product owner has not yet approved the initial estimates. Percentages are mechanically correct for this baseline, but the baseline itself is not yet a commitment.**';

  return `# RASTA project progress\n\n> Generated from \`planning/backlog.json\`. Do not edit this report directly.\n\n- As of: **${backlog.asOf}**\n- Baseline: **${backlog.governance.baselineState}** — ${baselineWarning}\n- Earned-points rule: only **ACCEPTED delivery units** earn points; in-progress work earns zero.\n- Decomposition rule: a decomposed Feature contributes its child Stories, never its own points again. An undecomposed Feature remains a legacy delivery unit.\n- Cancelled delivery units are excluded from the denominator.\n\n## Progress by product horizon\n\n${markdownTable(['Horizon', 'Earned SP', 'Committed SP', 'Remaining SP', 'Progress', 'Accepted units', 'Active units', 'Features', 'Stories'], scopeRows)}\n\n## Progress by epic\n\n${markdownTable(['Epic', 'Title', 'Scope', 'Earned SP', 'Committed SP', 'Progress', 'Features', 'Stories'], epicRows)}\n\n## Delivery-unit state\n\n${markdownTable(['Status', 'Delivery units', 'Story Points'], deliveryStatusRows)}\n\nA delivery unit is a User Story under a decomposed Feature, or the Feature itself while it has not yet been decomposed. This table is the accounting view and never double-counts parent and child points.\n\n## Feature state\n\n${markdownTable(['Status', 'Features', 'Baseline SP'], featureStatusRows)}\n\n## User Story state\n\n${markdownTable(['Status', 'Stories', 'Story Points'], storyStatusRows)}\n\n## Forecast\n\n${forecast}\n\n## Interpretation\n\nStory Points measure relative delivery effort and uncertainty; they are not hours. A percentage changes only when a delivery unit is accepted with evidence, or when an approved scope/estimate change is recorded in the backlog change log. Decomposing a Feature into Stories cannot change the approved denominator: child points must equal the parent estimate. Design artefacts, partially written code and a green test run without fulfilled acceptance criteria do not earn partial credit.\n`;
}
