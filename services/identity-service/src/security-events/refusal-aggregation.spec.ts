import { auditTrailPayloadSchemaV1 } from '@rasta/contracts';
import {
  AGGREGATION_OUTCOMES,
  AGGREGATION_WINDOW_ORIGIN,
  AGGREGATION_WINDOW_SECONDS,
  MAX_OCCURRENCE_COUNT,
  aggregationIdentityOf,
  aggregationOutcomeOf,
  aggregationWindowOf,
  assertAggregationWindowSeconds,
  isAggregationWindowClosed,
  sameAggregationIdentity,
  type AggregationDimensions,
} from './refusal-aggregation';

/**
 * The aggregation rules the capture statement implements (ADR-053 § 4, AUD-004
 * Phase C2). The integration suite holds the SQL to these same functions
 * against a real PostgreSQL.
 */

const SENTINEL = 'AGGREGATION-SENTINEL-4d2e';

function refusal(overrides: Record<string, unknown> = {}) {
  return {
    id: '01J9ZC0000000000000000TEST',
    organizationId: 'ORG_A',
    actorType: 'USER',
    actorId: 'USR_A',
    actorRoles: ['FLEET_MANAGER'],
    action: 'identity.active_organization.switch',
    resourceType: 'User',
    resourceId: 'USR_A',
    errorCode: 'TENANT_MISMATCH',
    reason: 'fixed site reason',
    sourceIp: '203.0.113.7',
    sourceUserAgent: `agent ${SENTINEL}`,
    correlationId: `COR_${SENTINEL}`,
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    producerVersion: '1.0.0',
    occurredAt: new Date('2026-09-11T10:00:00.000Z'),
    occurrenceCount: 1,
    ...overrides,
  } as AggregationDimensions & Record<string, unknown>;
}

const at = (iso: string): Date => new Date(iso);

describe('aggregation identity', () => {
  it('is exactly tenant, actor type, actor, action, resource type, resource and error code', () => {
    expect(aggregationIdentityOf(refusal())).toEqual({
      organizationId: 'ORG_A',
      actorType: 'USER',
      actorId: 'USR_A',
      action: 'identity.active_organization.switch',
      resourceType: 'User',
      resourceId: 'USR_A',
      errorCode: 'TENANT_MISMATCH',
    });
  });

  it('holds no caller-chosen or sensitive value — no ip, user agent, correlation, trace or roles', () => {
    const serialised = JSON.stringify(aggregationIdentityOf(refusal()));
    expect(serialised).not.toContain(SENTINEL);
    expect(serialised).not.toContain('203.0.113.7');
    expect(serialised).not.toContain('FLEET_MANAGER');
    expect(serialised).not.toContain('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(serialised).not.toContain('fixed site reason');
  });

  it.each([
    ['another tenant', { organizationId: 'ORG_B' }],
    ['the platform scope against a tenant', { organizationId: null }],
    ['another actor', { actorId: 'USR_B' }],
    ['another actor type', { actorType: 'SERVICE' }],
    ['another action', { action: 'identity.membership.revoke' }],
    ['another resource type', { resourceType: 'Membership' }],
    ['another resource', { resourceId: 'USR_B' }],
    ['no resource against a resource', { resourceId: null }],
    ['another error code', { errorCode: 'FORBIDDEN' }],
  ])('never merges %s', (_label, overrides) => {
    expect(sameAggregationIdentity(refusal(), refusal(overrides))).toBe(false);
  });

  it.each([
    ['another source ip', { sourceIp: '198.51.100.9' }],
    ['a rotated user agent', { sourceUserAgent: 'curl/8.0' }],
    ['another correlation id', { correlationId: 'COR_OTHER' }],
    ['another trace', { traceparent: null }],
    ['changed roles', { actorRoles: ['ORGANIZATION_ADMIN'] }],
    ['another producer version', { producerVersion: '2.0.0' }],
    ['a later instant', { occurredAt: at('2026-09-11T10:00:30.000Z') }],
  ])('keeps counting through %s — a prober cannot split its probe by header', (_l, overrides) => {
    expect(sameAggregationIdentity(refusal(), refusal(overrides))).toBe(true);
  });

  it('treats two platform-scoped refusals as the same tenant, not as two unknowns', () => {
    expect(
      sameAggregationIdentity(
        refusal({ organizationId: null, resourceId: null }),
        refusal({ organizationId: null, resourceId: null }),
      ),
    ).toBe(true);
  });
});

describe('aggregation window', () => {
  it('defaults to the one minute ADR-053 § 4 describes, within one second to one hour', () => {
    expect(AGGREGATION_WINDOW_SECONDS).toEqual({ MIN: 1, MAX: 3600, DEFAULT: 60 });
    expect(AGGREGATION_WINDOW_ORIGIN.toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });

  it('is half-open: its start is inside, its end belongs to the next window', () => {
    expect(aggregationWindowOf(at('2026-09-11T10:00:00.000Z'), 60)).toEqual({
      startedAt: at('2026-09-11T10:00:00.000Z'),
      endsAt: at('2026-09-11T10:01:00.000Z'),
    });
    expect(aggregationWindowOf(at('2026-09-11T10:00:59.999Z'), 60)).toEqual({
      startedAt: at('2026-09-11T10:00:00.000Z'),
      endsAt: at('2026-09-11T10:01:00.000Z'),
    });
    expect(aggregationWindowOf(at('2026-09-11T10:01:00.000Z'), 60)).toEqual({
      startedAt: at('2026-09-11T10:01:00.000Z'),
      endsAt: at('2026-09-11T10:02:00.000Z'),
    });
  });

  it('aligns every window length to the Unix epoch in UTC', () => {
    expect(aggregationWindowOf(at('2026-09-11T10:00:07.250Z'), 10)).toEqual({
      startedAt: at('2026-09-11T10:00:00.000Z'),
      endsAt: at('2026-09-11T10:00:10.000Z'),
    });
    // 7 does not divide a minute: the window is epoch-aligned, not minute-aligned.
    const seven = aggregationWindowOf(at('2026-09-11T10:00:00.000Z'), 7);
    expect(seven.startedAt.getTime() % 7000).toBe(0);
    expect(seven.endsAt.getTime() - seven.startedAt.getTime()).toBe(7000);
    expect(seven.startedAt.getTime()).toBeLessThanOrEqual(at('2026-09-11T10:00:00.000Z').getTime());
    expect(aggregationWindowOf(at('2026-09-11T10:59:59.999Z'), 3600)).toEqual({
      startedAt: at('2026-09-11T10:00:00.000Z'),
      endsAt: at('2026-09-11T11:00:00.000Z'),
    });
  });

  it('puts two instants a millisecond apart across a boundary in different windows', () => {
    const before = aggregationWindowOf(at('2026-09-11T10:00:09.999Z'), 10);
    const after = aggregationWindowOf(at('2026-09-11T10:00:10.000Z'), 10);
    expect(before.endsAt).toEqual(after.startedAt);
    expect(before.startedAt).not.toEqual(after.startedAt);
  });

  it('is closed — claimable — exactly from its end onwards', () => {
    const window = aggregationWindowOf(at('2026-09-11T10:00:00.000Z'), 60);
    expect(isAggregationWindowClosed(window, at('2026-09-11T10:00:59.999Z'))).toBe(false);
    expect(isAggregationWindowClosed(window, at('2026-09-11T10:01:00.000Z'))).toBe(true);
    expect(isAggregationWindowClosed(window, at('2026-09-11T10:05:00.000Z'))).toBe(true);
  });

  it.each([1, 60, 3600])('accepts %p seconds', (seconds) => {
    expect(assertAggregationWindowSeconds(seconds)).toBe(seconds);
  });

  it.each([0, -1, 3601, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %p seconds',
    (seconds) => {
      expect(() => assertAggregationWindowSeconds(seconds)).toThrow(RangeError);
      expect(() => aggregationWindowOf(at('2026-09-11T10:00:00.000Z'), seconds)).toThrow(
        RangeError,
      );
    },
  );
});

describe('occurrence count and outcome', () => {
  it('caps at PostgreSQL INTEGER, which the audit contract and audit_event both accept', () => {
    expect(MAX_OCCURRENCE_COUNT).toBe(2 ** 31 - 1);
    const payload = {
      actor: { type: 'USER', id: 'USR_A', roles: [] },
      organizationId: 'ORG_A',
      action: 'identity.active_organization.switch',
      resourceType: 'User',
      resourceId: 'USR_A',
      outcome: 'REFUSED',
      errorCode: 'TENANT_MISMATCH',
      occurrenceCount: MAX_OCCURRENCE_COUNT,
    };
    expect(auditTrailPayloadSchemaV1.parse(payload).occurrenceCount).toBe(MAX_OCCURRENCE_COUNT);
  });

  it.each([
    ['an insert', { id: 'A', occurrenceCount: 1, created: true }, AGGREGATION_OUTCOMES.CREATED],
    [
      'an increment',
      { id: 'A', occurrenceCount: 2, created: false },
      AGGREGATION_OUTCOMES.INCREMENTED,
    ],
    [
      'the 500th refusal',
      { id: 'A', occurrenceCount: 500, created: false },
      AGGREGATION_OUTCOMES.INCREMENTED,
    ],
    [
      'the last count the column holds',
      { id: 'A', occurrenceCount: MAX_OCCURRENCE_COUNT - 1, created: false },
      AGGREGATION_OUTCOMES.INCREMENTED,
    ],
    [
      'reaching the ceiling',
      { id: 'A', occurrenceCount: MAX_OCCURRENCE_COUNT, created: false },
      AGGREGATION_OUTCOMES.CEILING_REACHED,
    ],
  ])('classifies %s', (_label, captured, outcome) => {
    expect(aggregationOutcomeOf(captured)).toBe(outcome);
  });

  it('offers a closed outcome set for the metric label', () => {
    expect(Object.values(AGGREGATION_OUTCOMES).sort()).toEqual([
      'ceiling_reached',
      'created',
      'incremented',
    ]);
  });
});
