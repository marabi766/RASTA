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

const VALID: Record<ConstructionEventName, Record<string, unknown>> = {
  PROJECT_CREATED: {
    ...BASE,
    title: 'Road repair',
    operationType: 'road',
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
    reason: 'Funding withdrawn',
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
    reason: 'Covered by another line',
    withdrawnBy: 'USR_1',
    withdrawnAt: AT,
  },
};

const NAMES = Object.values(CONSTRUCTION_EVENTS);

describe('the construction event catalogue', () => {
  it('publishes exactly the seven events the PM approved for CON-001 PR 1', () => {
    expect([...NAMES].sort()).toEqual([
      'PROJECT_CREATED',
      'PROJECT_NEED_ADDED',
      'PROJECT_NEED_SUBMITTED',
      'PROJECT_NEED_UPDATED',
      'PROJECT_NEED_WITHDRAWN',
      'PROJECT_STATUS_CHANGED',
      'PROJECT_UPDATED',
    ]);
    expect(Object.keys(CONSTRUCTION_EVENT_SCHEMAS).sort()).toEqual([...NAMES].sort());
  });

  it.each(NAMES)('%s accepts its documented payload', (name) => {
    expect(() => validateConstructionPayload(name, VALID[name])).not.toThrow();
  });

  it.each(NAMES)('%s refuses an unknown field', (name) => {
    expect(() => validateConstructionPayload(name, { ...VALID[name], extra: 1 })).toThrow(
      /does not match its published contract/,
    );
  });

  it.each(NAMES)('%s requires the project and organization it concerns', (name) => {
    const { projectId: _p, ...withoutProject } = VALID[name];
    const { organizationId: _o, ...withoutOrganization } = VALID[name];
    expect(() => validateConstructionPayload(name, withoutProject)).toThrow();
    expect(() => validateConstructionPayload(name, withoutOrganization)).toThrow();
  });
});

describe('what never reaches the log', () => {
  it('refuses the operating area on PROJECT_CREATED: hasArea, never the polygon', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_CREATED', {
        ...VALID.PROJECT_CREATED,
        area: { type: 'Polygon', coordinates: [] },
      }),
    ).toThrow();
  });

  it('refuses the scope-of-work prose on PROJECT_CREATED', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_CREATED', {
        ...VALID.PROJECT_CREATED,
        scopeOfWork: 'Private text',
      }),
    ).toThrow();
  });

  it('refuses field values on the *_UPDATED events: names only', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_UPDATED', {
        ...VALID.PROJECT_UPDATED,
        title: 'New title',
      }),
    ).toThrow();
  });

  it('refuses money as a number', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_CREATED', {
        ...VALID.PROJECT_CREATED,
        estimatedCostMinor: 1500000000,
      }),
    ).toThrow();
  });
});

describe('payload rules', () => {
  it('allows a null estimate', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_CREATED', {
        ...VALID.PROJECT_CREATED,
        estimatedCostMinor: null,
      }),
    ).not.toThrow();
  });

  it('refuses a status change that changes nothing', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_STATUS_CHANGED', {
        ...VALID.PROJECT_STATUS_CHANGED,
        to: 'DRAFT',
      }),
    ).toThrow();
  });

  it('refuses duplicate or empty changedFields', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_UPDATED', {
        ...VALID.PROJECT_UPDATED,
        changedFields: ['title', 'title'],
      }),
    ).toThrow();
    expect(() =>
      validateConstructionPayload('PROJECT_UPDATED', {
        ...VALID.PROJECT_UPDATED,
        changedFields: [],
      }),
    ).toThrow();
  });

  it('refuses a timestamp that is not ISO-8601', () => {
    expect(() =>
      validateConstructionPayload('PROJECT_NEED_ADDED', {
        ...VALID.PROJECT_NEED_ADDED,
        addedAt: 'yesterday',
      }),
    ).toThrow();
  });

  it('requires a withdrawal to carry its reason', () => {
    const { reason: _r, ...withoutReason } = VALID.PROJECT_NEED_WITHDRAWN;
    expect(() => validateConstructionPayload('PROJECT_NEED_WITHDRAWN', withoutReason)).toThrow();
  });
});

describe('routing (docs/07 § 7.7)', () => {
  it.each(NAMES)('%s is about a Project and keyed by its projectId', (name) => {
    expect(AGGREGATE_OF[name]).toBe('Project');
    const payload = validateConstructionPayload(name, VALID[name]);
    expect(resolvePartitionKey(name, payload).key).toBe('PRJ_01');
  });

  it('keys a need event by the project, not the need', () => {
    const payload = validateConstructionPayload('PROJECT_NEED_ADDED', VALID.PROJECT_NEED_ADDED);
    const decision = resolvePartitionKey('PROJECT_NEED_ADDED', payload);
    expect(decision.key).not.toBe('PND_1');
    expect(decision.reason).toMatch(/project aggregate/);
  });
});
