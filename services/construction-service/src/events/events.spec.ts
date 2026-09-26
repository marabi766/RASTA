import {
  CONSTRUCTION_EVENTS,
  CONSTRUCTION_EVENT_SCHEMAS,
  validateConstructionPayload,
  type ConstructionEventName,
} from './events';
import { AGGREGATE_OF, resolvePartitionKey } from './routing';

/**
 * The published contract of every construction event.
 *
 * For each event: a valid payload passes, an unknown field fails (`.strict()`,
 * so nothing a later change adds by accident reaches the log), and the fields
 * that must never be published — geometry, prose, document ids — are refused.
 */

const AT = '2026-09-26T08:00:00.000Z';
const BASE = { projectId: 'PRJ_01', organizationId: 'ORG_A' };

const VALID: Partial<Record<ConstructionEventName, Record<string, unknown>>> = {
  PROJECT_CREATED: {
    ...BASE,
    estimatedCostMinor: '1500000000',
    hasArea: true,
    createdBy: 'USR_1',
    createdAt: AT,
  },
  PROJECT_UPDATED: { ...BASE, changedFields: ['title'], updatedBy: 'USR_1', updatedAt: AT },
  PROJECT_STATUS_CHANGED: {
    ...BASE,
    from: 'DRAFT',
    to: 'CANCELLED',
    changedBy: 'USR_1',
    changedAt: AT,
  },
  PROJECT_NEED_ADDED: { ...BASE, needId: 'PND_1', addedBy: 'USR_1', addedAt: AT },
  PROJECT_NEED_UPDATED: {
    ...BASE,
    needId: 'PND_1',
    changedFields: ['quantity', 'unit'],
    updatedBy: 'USR_1',
    updatedAt: AT,
  },
  PROJECT_NEED_SUBMITTED: { ...BASE, needId: 'PND_1', submittedBy: 'USR_1', submittedAt: AT },
  PROJECT_NEED_WITHDRAWN: {
    ...BASE,
    needId: 'PND_1',
    withdrawnBy: 'USR_1',
    withdrawnAt: AT,
  },
};

const STEP = {
  approvalId: 'APR_1',
  projectId: 'PRJ_01',
  organizationId: 'ORG_A',
  workflowKey: 'project.execution',
  round: 1,
  stepOrder: 1,
};
const POLICY = { policyId: 'APL_1', organizationId: 'ORG_A', workflowKey: 'project.execution' };

Object.assign(VALID, {
  APPROVAL_REQUESTED: {
    ...STEP,
    authorityOrganizationId: 'ORG_COUNCIL',
    authorityRole: 'ORGANIZATION_ADMIN',
    policyId: 'APL_1',
    policyVersion: 1,
    requestedAt: AT,
  },
  APPROVAL_GRANTED: {
    ...STEP,
    decidedBy: 'USR_2',
    decidedAt: AT,
    hasConditions: false,
  },
  APPROVAL_REJECTED: {
    ...STEP,
    decidedBy: 'USR_2',
    decidedAt: AT,
  },
  PROJECT_STARTED: { ...BASE, contractId: null, startedBy: 'USR_1', startedAt: AT },
  PROJECT_PROGRESS_UPDATED: {
    ...BASE,
    reportId: 'PRG_1',
    progressBasisPoints: 2500,
    submittedBy: 'USR_1',
    submittedAt: AT,
  },
  PROJECT_COMPLETED: { ...BASE, completedBy: 'USR_1', completedAt: AT },
  APPROVAL_POLICY_CREATED: {
    ...POLICY,
    authorOrganizationId: 'ORG_UNION',
    authorRole: 'UNION_ADMIN',
    policyVersion: 1,
    stepCount: 2,
    isSample: true,
    createdBy: 'USR_1',
    createdAt: AT,
  },
  APPROVAL_POLICY_ACTIVATED: {
    ...POLICY,
    policyVersion: 2,
    retiredPolicyId: 'APL_0',
    activatedBy: 'USR_1',
    activatedAt: AT,
  },
  APPROVAL_POLICY_RETIRED: { ...POLICY, policyVersion: 2, retiredBy: 'USR_1', retiredAt: AT },
  APPROVAL_POLICY_SUBMITTED: { ...POLICY, policyVersion: 2, submittedBy: 'USR_1', submittedAt: AT },
  APPROVAL_POLICY_REJECTED: { ...POLICY, policyVersion: 2, rejectedBy: 'USR_9', rejectedAt: AT },
  PROJECT_PROGRESS_REPORT_DRAFTED: {
    ...BASE,
    reportId: 'PRG_1',
    draftedBy: 'USR_1',
    draftedAt: AT,
  },
  PROJECT_PROGRESS_REPORT_DISCARDED: {
    ...BASE,
    reportId: 'PRG_1',
    discardedBy: 'USR_1',
    discardedAt: AT,
  },
});

const NAMES = Object.values(CONSTRUCTION_EVENTS);
const POLICY_EVENTS = [
  'APPROVAL_POLICY_CREATED',
  'APPROVAL_POLICY_ACTIVATED',
  'APPROVAL_POLICY_RETIRED',
  'APPROVAL_POLICY_SUBMITTED',
  'APPROVAL_POLICY_REJECTED',
];
const PROJECT_EVENTS = NAMES.filter((name) => !POLICY_EVENTS.includes(name));

describe('the construction event catalogue', () => {
  it('publishes exactly the CON-001 events: seven of PR 1 and thirteen of PR 2', () => {
    expect([...NAMES].sort()).toEqual([
      'APPROVAL_GRANTED',
      'APPROVAL_POLICY_ACTIVATED',
      'APPROVAL_POLICY_CREATED',
      'APPROVAL_POLICY_REJECTED',
      'APPROVAL_POLICY_RETIRED',
      'APPROVAL_POLICY_SUBMITTED',
      'APPROVAL_REJECTED',
      'APPROVAL_REQUESTED',
      'PROJECT_COMPLETED',
      'PROJECT_CREATED',
      'PROJECT_NEED_ADDED',
      'PROJECT_NEED_SUBMITTED',
      'PROJECT_NEED_UPDATED',
      'PROJECT_NEED_WITHDRAWN',
      'PROJECT_PROGRESS_REPORT_DISCARDED',
      'PROJECT_PROGRESS_REPORT_DRAFTED',
      'PROJECT_PROGRESS_UPDATED',
      'PROJECT_STARTED',
      'PROJECT_STATUS_CHANGED',
      'PROJECT_UPDATED',
    ]);
    expect(Object.keys(CONSTRUCTION_EVENT_SCHEMAS).sort()).toEqual([...NAMES].sort());
  });

  it.each(NAMES)('%s accepts its documented payload', (name) => {
    expect(() => validateConstructionPayload(name, VALID[name])).not.toThrow();
  });

  it.each(NAMES)('%s refuses an unknown field', (name) => {
    expect(() => validateConstructionPayload(name, { ...VALID[name]!, extra: 1 })).toThrow(
      /does not match its published contract/,
    );
  });

  it.each(PROJECT_EVENTS)('%s requires the project and organization it concerns', (name) => {
    const { projectId: _p, ...withoutProject } = VALID[name]!;
    const { organizationId: _o, ...withoutOrganization } = VALID[name]!;
    expect(() => validateConstructionPayload(name, withoutProject)).toThrow();
    expect(() => validateConstructionPayload(name, withoutOrganization)).toThrow();
  });

  it.each(POLICY_EVENTS as typeof NAMES)(
    '%s requires the organization and workflow key',
    (name) => {
      const { workflowKey: _w, ...withoutKey } = VALID[name]!;
      expect(() => validateConstructionPayload(name, withoutKey)).toThrow();
    },
  );
});

describe('what never reaches the log', () => {
  it('refuses the operating area on PROJECT_CREATED: hasArea, never the polygon', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_CREATED', {
        ...VALID.PROJECT_CREATED!,
        area: { type: 'Polygon', coordinates: [] },
      }),
    ).toThrow();
  });

  it('refuses the scope-of-work prose on PROJECT_CREATED', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_CREATED', {
        ...VALID.PROJECT_CREATED!,
        scopeOfWork: 'Private text',
      }),
    ).toThrow();
  });

  it('refuses field values on the *_UPDATED events: names only', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_UPDATED', {
        ...VALID.PROJECT_UPDATED!,
        title: 'New title',
      }),
    ).toThrow();
  });

  it('refuses money as a number', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_CREATED', {
        ...VALID.PROJECT_CREATED!,
        estimatedCostMinor: 1500000000,
      }),
    ).toThrow();
  });
});

describe('payload rules', () => {
  it('allows a null estimate', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_CREATED', {
        ...VALID.PROJECT_CREATED!,
        estimatedCostMinor: null,
      }),
    ).not.toThrow();
  });

  it('refuses a status change that changes nothing', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_STATUS_CHANGED', {
        ...VALID.PROJECT_STATUS_CHANGED!,
        to: 'DRAFT',
      }),
    ).toThrow();
  });

  it('refuses duplicate or empty changedFields', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_UPDATED', {
        ...VALID.PROJECT_UPDATED!,
        changedFields: ['title', 'title'],
      }),
    ).toThrow();
    expect(() =>
      validateConstructionPayload('PROJECT_UPDATED', {
        ...VALID.PROJECT_UPDATED!,
        changedFields: [],
      }),
    ).toThrow();
  });

  it('refuses a timestamp that is not ISO-8601', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_NEED_ADDED', {
        ...VALID.PROJECT_NEED_ADDED!,
        addedAt: 'yesterday',
      }),
    ).toThrow();
  });

  // Codex review of #119, finding 4: prose stays in the database.
  it.each<[ConstructionEventName, Record<string, unknown>]>([
    ['PROJECT_CREATED', { title: 'Road repair' }],
    ['PROJECT_CREATED', { operationType: 'road' }],
    ['PROJECT_STATUS_CHANGED', { reason: 'Funding withdrawn' }],
    ['PROJECT_NEED_WITHDRAWN', { reason: 'Covered by another line' }],
    // Codex review of #122, finding 4: unverified asset claims stay in the database.
    ['PROJECT_PROGRESS_UPDATED', { assetsUsed: ['AST_01JBQ4Y8ZK3M5N7P9R1S3T5V7W'] }],
    ['PROJECT_PROGRESS_UPDATED', { assetsUsed: ['the grader and two trucks'] }],
    ['PROJECT_PROGRESS_UPDATED', { obstacles: 'Rain on two days' }],
  ])('refuses free text on %s (%j)', (name, prose) => {
    expect(() => validateConstructionPayload(name, { ...VALID[name]!, ...prose })).toThrow();
  });
});

describe('routing (docs/07 § 7.7)', () => {
  it.each(PROJECT_EVENTS)('%s is about a Project and keyed by its projectId', (name) => {
    expect(AGGREGATE_OF[name]).toBe('Project');
    const payload = validateConstructionPayload(name, VALID[name]);
    expect(resolvePartitionKey(name, payload).key).toBe('PRJ_01');
  });

  it.each(POLICY_EVENTS as typeof NAMES)(
    '%s is about an ApprovalPolicy and keyed by its (organization, workflow key) line',
    (name) => {
      expect(AGGREGATE_OF[name]).toBe('ApprovalPolicy');
      const payload = validateConstructionPayload(name, VALID[name]);
      expect(resolvePartitionKey(name, payload).key).toBe('ORG_A/project.execution');
    },
  );

  it('refuses to route a project event with no projectId', () => {
    expect(() => resolvePartitionKey('PROJECT_CREATED', { organizationId: 'ORG_A' })).toThrow(
      /no projectId/,
    );
  });

  it('keys a need event by the project, not the need', () => {
    const payload = validateConstructionPayload('PROJECT_NEED_ADDED', VALID.PROJECT_NEED_ADDED);
    const decision = resolvePartitionKey('PROJECT_NEED_ADDED', payload);
    expect(decision.key).not.toBe('PND_1');
    expect(decision.reason).toMatch(/project aggregate/);
  });
});

describe('the PR 2 contracts', () => {
  it('never claims a contract on PROJECT_STARTED before CON-003', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_STARTED', {
        ...VALID.PROJECT_STARTED!,
        contractId: 'CTR_1',
      }),
    ).toThrow();
  });

  it('carries progress in basis points, never a float or beyond 100%', () => {
    for (const progressBasisPoints of [25.5, 10_001, -1]) {
      expect(() =>
        validateConstructionPayload('PROJECT_PROGRESS_UPDATED', {
          ...VALID.PROJECT_PROGRESS_UPDATED!,
          progressBasisPoints,
        }),
      ).toThrow();
    }
  });

  it.each<[ConstructionEventName, Record<string, unknown>]>([
    ['APPROVAL_REQUESTED', { approvalType: 'Council approval' }],
    ['APPROVAL_GRANTED', { conditions: 'Finish the drainage first' }],
    ['APPROVAL_GRANTED', { decisionNumber: '1405/12' }],
    ['APPROVAL_REJECTED', { reason: 'Estimate lacks detail' }],
    ['APPROVAL_POLICY_REJECTED', { reason: 'Authorities unclear' }],
    ['APPROVAL_POLICY_CREATED', { label: 'Council approvals' }],
  ])('refuses the prose of a decision on %s (%j)', (name, prose) => {
    expect(() => validateConstructionPayload(name, { ...VALID[name]!, ...prose })).toThrow();
  });

  it('refuses an unknown workflow key', () => {
    expect(() =>
      validateConstructionPayload('APPROVAL_REQUESTED', {
        ...VALID.APPROVAL_REQUESTED!,
        workflowKey: 'project.anything',
      }),
    ).toThrow();
  });
});
