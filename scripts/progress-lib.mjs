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

function findDependencyCycles(itemsById) {
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
    const item = itemsById.get(id);
    for (const dependency of item?.dependencies ?? []) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of itemsById.keys()) visit(id, []);
  return [...new Set(errors)];
}

export function validateBacklog(backlog) {
  const errors = [];
  if (backlog === null || typeof backlog !== 'object' || Array.isArray(backlog)) {
    return ['backlog must be an object'];
  }

  if (backlog.version !== 1) errors.push('version must be 1');
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
  const items = Array.isArray(backlog.items) ? backlog.items : [];
  const iterations = Array.isArray(backlog.iterations) ? backlog.iterations : [];
  const changeLog = Array.isArray(backlog.changeLog) ? backlog.changeLog : [];
  if (!Array.isArray(backlog.epics)) errors.push('epics must be an array');
  if (!Array.isArray(backlog.items)) errors.push('items must be an array');
  if (!Array.isArray(backlog.iterations)) errors.push('iterations must be an array');
  if (!Array.isArray(backlog.changeLog) || changeLog.length === 0)
    errors.push('changeLog must be a non-empty array');

  errors.push(
    ...uniqueErrors(
      epics.map((epic) => epic.id),
      'epic id',
    ),
  );
  errors.push(
    ...uniqueErrors(
      items.map((item) => item.id),
      'item id',
    ),
  );
  errors.push(
    ...uniqueErrors(
      iterations.map((iteration) => iteration.id),
      'iteration id',
    ),
  );

  const epicsById = new Map(epics.map((epic) => [epic.id, epic]));
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const iterationsById = new Map(iterations.map((iteration) => [iteration.id, iteration]));
  const scale = new Set(governance.pointScale ?? []);

  for (const epic of epics) {
    if (!/^EP-[A-Z0-9-]+$/.test(epic.id ?? '')) errors.push(`epic '${epic.id}' has an invalid id`);
    if (!isNonEmptyString(epic.title)) errors.push(`epic '${epic.id}' requires a title`);
    if (!VALID_SCOPES.has(epic.scope)) errors.push(`epic '${epic.id}' has an invalid scope`);
    if (!isNonEmptyString(epic.owner)) errors.push(`epic '${epic.id}' requires an owner`);
  }

  for (const iteration of iterations) {
    if (!/^IT-[A-Z0-9-]+$/.test(iteration.id ?? ''))
      errors.push(`iteration '${iteration.id}' has an invalid id`);
    if (!['PLANNED', 'ACTIVE', 'CLOSED'].includes(iteration.status))
      errors.push(`iteration '${iteration.id}' has an invalid status`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(iteration.startDate ?? '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(iteration.endDate ?? '')
    ) {
      errors.push(`iteration '${iteration.id}' requires YYYY-MM-DD dates`);
    } else if (iteration.startDate > iteration.endDate) {
      errors.push(`iteration '${iteration.id}' ends before it starts`);
    }
  }

  for (const item of items) {
    const label = `item '${item.id}'`;
    if (!/^[A-Z]+-[0-9]{3}$/.test(item.id ?? '')) errors.push(`${label} has an invalid id`);
    if (!isNonEmptyString(item.title)) errors.push(`${label} requires a title`);
    if (!VALID_SCOPES.has(item.scope)) errors.push(`${label} has an invalid scope`);
    if (!VALID_PRIORITIES.has(item.priority)) errors.push(`${label} has an invalid priority`);
    if (!VALID_STATUSES.has(item.status)) errors.push(`${label} has an invalid status`);
    if (!scale.has(item.points))
      errors.push(`${label} points must use the configured Fibonacci scale`);
    if (
      !Array.isArray(item.acceptanceCriteria) ||
      item.acceptanceCriteria.length === 0 ||
      item.acceptanceCriteria.some((criterion) => !isNonEmptyString(criterion))
    ) {
      errors.push(`${label} requires non-empty acceptance criteria`);
    }
    if (
      !Array.isArray(item.sourceRefs) ||
      item.sourceRefs.length === 0 ||
      item.sourceRefs.some((ref) => !isNonEmptyString(ref))
    ) {
      errors.push(`${label} requires at least one source reference`);
    }
    if (!Array.isArray(item.dependencies)) errors.push(`${label} dependencies must be an array`);
    if (!Array.isArray(item.evidence)) errors.push(`${label} evidence must be an array`);

    const epic = epicsById.get(item.epicId);
    if (!epic) errors.push(`${label} references missing epic '${item.epicId}'`);
    else if (epic.scope !== item.scope)
      errors.push(`${label} scope does not match epic '${epic.id}'`);

    if (item.scope === 'POST_MVP' && item.priority !== 'P3')
      errors.push(`${label} must use P3 in POST_MVP scope`);
    if (item.scope === 'MVP' && item.priority === 'P3')
      errors.push(`${label} cannot use P3 in MVP scope`);

    for (const dependency of item.dependencies ?? []) {
      if (dependency === item.id) errors.push(`${label} cannot depend on itself`);
      else if (!itemsById.has(dependency))
        errors.push(`${label} references missing dependency '${dependency}'`);
    }

    if (item.targetIteration !== undefined && !iterationsById.has(item.targetIteration)) {
      errors.push(`${label} references missing iteration '${item.targetIteration}'`);
    }

    if (item.status === 'ACCEPTED' && (item.evidence ?? []).length === 0) {
      errors.push(`${label} is ACCEPTED but has no evidence`);
    }
    for (const evidence of item.evidence ?? []) {
      if (!['COMMIT', 'PR', 'CI', 'TEST', 'RUNTIME', 'DOCUMENT'].includes(evidence.kind))
        errors.push(`${label} has invalid evidence kind`);
      if (!isNonEmptyString(evidence.ref) || !isNonEmptyString(evidence.note))
        errors.push(`${label} has incomplete evidence`);
    }
  }

  errors.push(...findDependencyCycles(itemsById));

  if (governance.baselineState === 'APPROVED') {
    const hasApproval = changeLog.some(
      (entry) => entry.type === 'BASELINE_APPROVED' && isNonEmptyString(entry.approvalRef),
    );
    if (!hasApproval)
      errors.push(
        'an APPROVED baseline requires a BASELINE_APPROVED change-log entry with approvalRef',
      );
  }

  return errors;
}

function summarize(items) {
  const active = items.filter((item) => item.status !== 'CANCELLED');
  const committed = active.reduce((sum, item) => sum + item.points, 0);
  const accepted = active.filter((item) => item.status === 'ACCEPTED');
  const earned = accepted.reduce((sum, item) => sum + item.points, 0);
  return {
    items: active.length,
    acceptedItems: accepted.length,
    committed,
    earned,
    remaining: committed - earned,
    percent: percent(earned, committed),
  };
}

export function calculateProgress(backlog) {
  const activeItems = backlog.items.filter((item) => item.status !== 'CANCELLED');
  const closedIterations = backlog.iterations.filter((iteration) => iteration.status === 'CLOSED');
  const iterationVelocity = closedIterations.map((iteration) => ({
    id: iteration.id,
    points: activeItems
      .filter((item) => item.targetIteration === iteration.id && item.status === 'ACCEPTED')
      .reduce((sum, item) => sum + item.points, 0),
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
      summarize(activeItems.filter((item) => item.status === status)),
    ]),
  );
  const byEpic = backlog.epics.map((epic) => ({
    ...epic,
    ...summarize(activeItems.filter((item) => item.epicId === epic.id)),
  }));

  return {
    mvp: summarize(activeItems.filter((item) => item.scope === 'MVP')),
    postMvp: summarize(activeItems.filter((item) => item.scope === 'POST_MVP')),
    fullProduct: summarize(activeItems),
    byStatus,
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
    [
      'MVP',
      progress.mvp.earned,
      progress.mvp.committed,
      progress.mvp.remaining,
      `${progress.mvp.percent}%`,
      progress.mvp.acceptedItems,
      progress.mvp.items,
    ],
    [
      'Post-MVP only',
      progress.postMvp.earned,
      progress.postMvp.committed,
      progress.postMvp.remaining,
      `${progress.postMvp.percent}%`,
      progress.postMvp.acceptedItems,
      progress.postMvp.items,
    ],
    [
      'Full product',
      progress.fullProduct.earned,
      progress.fullProduct.committed,
      progress.fullProduct.remaining,
      `${progress.fullProduct.percent}%`,
      progress.fullProduct.acceptedItems,
      progress.fullProduct.items,
    ],
  ];
  const epicRows = progress.byEpic.map((epic) => [
    epic.id,
    epic.title,
    epic.scope,
    epic.earned,
    epic.committed,
    `${epic.percent}%`,
  ]);
  const statusRows = [...VALID_STATUSES].map((status) => {
    const summary = progress.byStatus[status];
    return [status, summary.items, summary.committed];
  });

  const forecast = progress.forecast.available
    ? `Average accepted velocity is **${progress.forecast.averageVelocity} points/iteration**, based on ${progress.forecast.closedIterations} closed iterations. This is historical throughput, not a commitment.`
    : `**Unavailable.** ${progress.forecast.closedIterations} closed iterations exist; at least ${backlog.governance.minimumClosedIterationsForForecast} are required before velocity or a completion forecast may be shown.`;
  const baselineWarning =
    backlog.governance.baselineState === 'APPROVED'
      ? `Approved by **${backlog.governance.approvedBy}**.`
      : '**The product owner has not yet approved the initial estimates. Percentages are mechanically correct for this baseline, but the baseline itself is not yet a commitment.**';

  return `# RASTA project progress\n\n> Generated from \`planning/backlog.json\`. Do not edit this report directly.\n\n- As of: **${backlog.asOf}**\n- Baseline: **${backlog.governance.baselineState}** — ${baselineWarning}\n- Earned-points rule: only **ACCEPTED** items earn points; in-progress work earns zero.\n- Cancelled items are excluded from the denominator.\n\n## Progress by product horizon\n\n${markdownTable(['Horizon', 'Earned SP', 'Committed SP', 'Remaining SP', 'Progress', 'Accepted items', 'Active items'], scopeRows)}\n\n## Progress by epic\n\n${markdownTable(['Epic', 'Title', 'Scope', 'Earned SP', 'Committed SP', 'Progress'], epicRows)}\n\n## Backlog state\n\n${markdownTable(['Status', 'Items', 'Story Points'], statusRows)}\n\n## Forecast\n\n${forecast}\n\n## Interpretation\n\nStory Points measure relative delivery effort and uncertainty; they are not hours. A percentage changes only when an item is accepted with evidence, or when an approved scope/estimate change is recorded in the backlog change log. Design artefacts, partially written code and a green test run without fulfilled acceptance criteria do not earn partial credit.\n`;
}
