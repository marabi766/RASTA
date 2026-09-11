import {
  AUDIT_EVENT_RECORDED,
  AUDIT_EVENT_RECORDED_VERSION,
  AUDIT_TRAIL_TOPIC,
  auditTrailPayloadSchemaV1,
  parseEnvelope,
} from '@rasta/contracts';
import type { OutboxRow } from '@rasta/nest-common';
import {
  AuditTrailContractError,
  assertPublishableAuditTrailRow,
  partitionKeyOf,
  toAuditTrailEnvelope,
  toSecurityEventOutboxRow,
  type SecurityEventDeliveryState,
  type SecurityEventRecord,
} from './audit-trail-envelope';

const SENTINEL = 'LEAK-SENTINEL-VALUE';

function record(
  overrides: Partial<SecurityEventRecord & SecurityEventDeliveryState> = {},
): SecurityEventRecord & SecurityEventDeliveryState {
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
    reason:
      'Active organization switch refused: no active membership in the requested organization',
    sourceIp: '203.0.113.7',
    sourceUserAgent: 'Mozilla/5.0 (identity unit)',
    correlationId: 'COR_1',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    producerVersion: '1.4.2',
    occurredAt: new Date('2026-09-11T10:00:00.000Z'),
    occurrenceCount: 1,
    createdAt: new Date('2026-09-11T10:00:00.000Z'),
    publishedAt: null,
    attempts: 0,
    lastError: null,
    ...overrides,
  };
}

/** A copy of a built row whose envelope has been edited. */
function tampered(
  edit: (envelope: Record<string, unknown>, payload: Record<string, unknown>) => void,
  rowOverrides: Partial<OutboxRow> = {},
): OutboxRow {
  const row = toSecurityEventOutboxRow(record());
  const envelope = JSON.parse(JSON.stringify(row.payload)) as Record<string, unknown>;
  edit(envelope, envelope.payload as Record<string, unknown>);
  return { ...row, payload: envelope, ...rowOverrides };
}

describe('audit-trail envelope for a refusal', () => {
  it('builds a row the standard envelope and the v1 payload schema both accept', () => {
    const row = toSecurityEventOutboxRow(record());
    const parsed = parseEnvelope(row.payload, auditTrailPayloadSchemaV1);

    expect(row.topic).toBe(AUDIT_TRAIL_TOPIC);
    expect(row.eventName).toBe(AUDIT_EVENT_RECORDED);
    expect(row.eventVersion).toBe(AUDIT_EVENT_RECORDED_VERSION);
    expect(parsed.eventId).toBe(row.id);
    expect(parsed.eventName).toBe(AUDIT_EVENT_RECORDED);
    expect(parsed.eventVersion).toBe(AUDIT_EVENT_RECORDED_VERSION);
    expect(parsed.producer).toBe('identity-service');
    expect(parsed.producerVersion).toBe('1.4.2');
    expect(parsed.occurredAt).toBe('2026-09-11T10:00:00.000Z');
    expect(parsed.tenantId).toBe('ORG_A');
    expect(parsed.correlationId).toBe('COR_1');
    expect(parsed.traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');

    expect(parsed.payload).toEqual({
      actor: { type: 'USER', id: 'USR_A', roles: ['FLEET_MANAGER'] },
      organizationId: 'ORG_A',
      action: 'identity.active_organization.switch',
      resourceType: 'User',
      resourceId: 'USR_A',
      outcome: 'REFUSED',
      errorCode: 'TENANT_MISMATCH',
      reason:
        'Active organization switch refused: no active membership in the requested organization',
      occurrenceCount: 1,
      source: { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (identity unit)' },
    });

    expect(row.headers).toEqual({
      'x-event-id': row.id,
      'x-event-name': AUDIT_EVENT_RECORDED,
      'x-event-version': String(AUDIT_EVENT_RECORDED_VERSION),
      'x-correlation-id': 'COR_1',
      'x-producer': 'identity-service',
      'x-tenant-id': 'ORG_A',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    expect(() => assertPublishableAuditTrailRow(row)).not.toThrow();
  });

  it('keys the partition by the refused resource, falling back to the actor', () => {
    expect(partitionKeyOf(record())).toBe('USR_A');
    expect(toSecurityEventOutboxRow(record()).partitionKey).toBe('USR_A');
    expect(partitionKeyOf(record({ resourceId: null, actorId: 'USR_Z' }))).toBe('USR_Z');
  });

  it('omits the tenant from both envelope and payload for a platform record', () => {
    const row = toSecurityEventOutboxRow(record({ organizationId: null }));
    const envelope = row.payload as { tenantId?: string; payload: { organizationId?: string } };
    expect(envelope.tenantId).toBeUndefined();
    expect(envelope.payload.organizationId).toBeUndefined();
    expect(row.headers['x-tenant-id']).toBeUndefined();
    expect(() => assertPublishableAuditTrailRow(row)).not.toThrow();
  });

  it('carries only the source fields it has, and none when it has neither', () => {
    expect(toAuditTrailEnvelope(record({ sourceIp: null })).payload.source).toEqual({
      userAgent: 'Mozilla/5.0 (identity unit)',
    });
    expect(
      toAuditTrailEnvelope(record({ sourceIp: null, sourceUserAgent: null })).payload.source,
    ).toBeUndefined();
    expect(toAuditTrailEnvelope(record({ traceparent: null })).traceparent).toBeUndefined();
    expect(toAuditTrailEnvelope(record({ reason: null })).payload.reason).toBeUndefined();
  });

  it('is deterministic per row, so a redelivery is byte-identical', () => {
    expect(JSON.stringify(toSecurityEventOutboxRow(record()))).toBe(
      JSON.stringify(toSecurityEventOutboxRow(record())),
    );
    expect(JSON.stringify(toSecurityEventOutboxRow(record({ occurrenceCount: 500 })))).toBe(
      JSON.stringify(toSecurityEventOutboxRow(record({ occurrenceCount: 500 }))),
    );
  });

  describe('publishes the persisted occurrence count (AUD-004 Phase C2)', () => {
    it.each([1, 2, 500, 2_147_483_647])('carries occurrenceCount %p exactly', (count) => {
      const row = toSecurityEventOutboxRow(record({ occurrenceCount: count }));
      const parsed = parseEnvelope(row.payload, auditTrailPayloadSchemaV1);

      expect(parsed.payload.occurrenceCount).toBe(count);
      // Aggregation changes the count and nothing else on the wire.
      expect(parsed.eventId).toBe(row.id);
      expect(parsed.tenantId).toBe('ORG_A');
      expect(parsed.payload.organizationId).toBe('ORG_A');
      expect(row.partitionKey).toBe('USR_A');
      expect(() => assertPublishableAuditTrailRow(row)).not.toThrow();
    });

    it('never folds the window or any source value into the envelope', () => {
      const wire = JSON.stringify(toSecurityEventOutboxRow(record({ occurrenceCount: 500 })));
      // `aggregateType`/`aggregateId` are the contract's own envelope fields.
      expect(wire).not.toContain('window');
      expect(wire).not.toContain('aggregation');
    });
  });

  describe('refuses to publish', () => {
    it.each<[string, OutboxRow]>([
      ['another topic', { ...toSecurityEventOutboxRow(record()), topic: 'rasta.identity.v1' }],
      [
        'another row event name',
        { ...toSecurityEventOutboxRow(record()), eventName: 'USER_UPDATED' },
      ],
      [
        'an envelope event name that is not AUDIT_EVENT_RECORDED',
        tampered((e) => {
          e.eventName = 'USER_UPDATED';
        }),
      ],
      [
        'another envelope version',
        tampered((e) => {
          e.eventVersion = 2;
        }),
      ],
      [
        'an eventId that is not the row id',
        tampered((e) => {
          e.eventId = SENTINEL;
        }),
      ],
      [
        'a partition key other than aggregateId',
        { ...toSecurityEventOutboxRow(record()), partitionKey: SENTINEL },
      ],
      [
        'a broken envelope',
        tampered((e) => {
          delete e.correlationId;
        }),
      ],
      [
        'an outcome other than REFUSED',
        tampered((_e, p) => {
          p.outcome = 'SUCCESS';
        }),
      ],
      [
        'an occurrence count above the PostgreSQL INTEGER ceiling',
        toSecurityEventOutboxRow(record({ occurrenceCount: 2_147_483_648 })),
      ],
      ['an occurrence count of zero', toSecurityEventOutboxRow(record({ occurrenceCount: 0 }))],
      [
        'a fractional occurrence count',
        tampered((_e, p) => {
          p.occurrenceCount = 1.5;
        }),
      ],
      [
        'a payload outside the v1 contract',
        tampered((_e, p) => {
          p.unexpected = SENTINEL;
        }),
      ],
      [
        'a correction',
        tampered((_e, p) => {
          p.correctionOf = SENTINEL;
          p.action = 'audit.correction';
        }),
      ],
      [
        'a tenant that differs between envelope and payload',
        tampered((_e, p) => {
          p.organizationId = SENTINEL;
        }),
      ],
      [
        'a tenant on the envelope only',
        tampered((_e, p) => {
          delete p.organizationId;
        }),
      ],
      [
        'a tenant on the payload only',
        tampered((e) => {
          delete e.tenantId;
        }),
      ],
      [
        'a blank tenant on both',
        tampered((e, p) => {
          e.tenantId = ' ';
          p.organizationId = ' ';
        }),
      ],
    ])('%s — without quoting a value', (_label, row) => {
      let failure: unknown;
      try {
        assertPublishableAuditTrailRow(row);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AuditTrailContractError);
      expect((failure as Error).message).not.toContain(SENTINEL);
      expect((failure as Error).message).not.toContain('USR_A');
      expect((failure as Error).message).not.toContain('ORG_A');
    });
  });
});
