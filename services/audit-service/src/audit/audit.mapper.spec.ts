import type { EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import { SENSITIVE_KEYS } from '@rasta/logging';
import {
  DOMAIN_PROJECTOR_CONSUMER,
  DOMAIN_TOPICS,
  describePayloadKeys,
  isSensitiveKey,
  toAuditEventRecord,
} from './audit.mapper';

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: '01JMAPPERSPEC000000000001',
    eventName: 'ASSET_DECOMMISSIONED',
    eventVersion: 1,
    occurredAt: '2026-09-15T10:30:00.000Z',
    producer: 'asset-service',
    producerVersion: '1.4.0',
    aggregateType: 'Asset',
    aggregateId: 'AST_0001',
    tenantId: 'ORG-1',
    correlationId: 'corr-1',
    payload: { reason: 'sold' },
    ...overrides,
  } as EventEnvelope;
}

const delivery = (topic = 'rasta.asset.v1', partition = 0): EventDelivery =>
  Object.freeze({ topic, partition });

describe('the ten subscribed topics', () => {
  it('is exactly the set ADR-053 path A names, and no more', () => {
    // Pinned deliberately. Adding `rasta.audit.trail.v1` here would have this
    // service auditing its own writes (that is AUD-004), and adding a topic
    // nothing produces would fail startup under `allowAutoTopicCreation:
    // false` while making the consumer look broader than it is.
    expect([...DOMAIN_TOPICS]).toEqual([
      'rasta.identity.v1',
      'rasta.organization.v1',
      'rasta.asset.v1',
      'rasta.insurance.v1',
      'rasta.fleet.v1',
      'rasta.maintenance.v1',
      'rasta.marketplace.v1',
      'rasta.economic.v1',
      'rasta.document.v1',
      'rasta.supplier.v1',
    ]);
    expect(DOMAIN_TOPICS).toHaveLength(10);
  });

  it('subscribes to no topic this service itself produces', () => {
    expect(DOMAIN_TOPICS).not.toContain('rasta.audit.v1');
    expect(DOMAIN_TOPICS).not.toContain('rasta.audit.trail.v1');
  });

  it('names the consumer group ADR-053 specifies', () => {
    expect(DOMAIN_PROJECTOR_CONSUMER).toBe('audit-service.domain-projector');
  });
});

describe('mapping an envelope to an audit record', () => {
  it('preserves domain time, provenance and the causal chain', () => {
    const record = toAuditEventRecord(
      envelope({
        causationId: 'cause-1',
        traceparent: '00-abc-def-01',
      }),
      delivery(),
    );

    expect(record.occurredAt.toISOString()).toBe('2026-09-15T10:30:00.000Z');
    expect(record.sourceService).toBe('asset-service');
    expect(record.sourceServiceVersion).toBe('1.4.0');
    expect(record.sourceEventId).toBe('01JMAPPERSPEC000000000001');
    expect(record.sourceEventName).toBe('ASSET_DECOMMISSIONED');
    expect(record.correlationId).toBe('corr-1');
    expect(record.causationId).toBe('cause-1');
    expect(record.traceparent).toBe('00-abc-def-01');
  });

  it('takes the topic from delivery metadata, not from the envelope', () => {
    // The reason `EventDelivery` exists. `producer` is `asset-service` here,
    // and the row must say which topic it actually arrived on.
    expect(toAuditEventRecord(envelope(), delivery('rasta.asset.v1')).sourceTopic).toBe(
      'rasta.asset.v1',
    );
    expect(toAuditEventRecord(envelope(), delivery('rasta.asset.v1.retry')).sourceTopic).toBe(
      'rasta.asset.v1.retry',
    );
  });

  it('maps aggregate to resource and always records SUCCESS on path A', () => {
    const record = toAuditEventRecord(envelope(), delivery());

    expect(record.resourceType).toBe('Asset');
    expect(record.resourceId).toBe('AST_0001');
    // A published domain event is a change that already happened. A refusal
    // never reaches a topic, which is why path B exists at all.
    expect(record.outcome).toBe('SUCCESS');
    expect(record.occurrenceCount).toBe(1);
  });

  it('gives every record a fresh id, never the source event id', () => {
    const a = toAuditEventRecord(envelope(), delivery());
    const b = toAuditEventRecord(envelope(), delivery());

    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(a.sourceEventId);
  });

  describe('actor provenance is never ambiguous (ADR § 5)', () => {
    it('keeps a present actor exactly', () => {
      const record = toAuditEventRecord(
        envelope({ actor: { type: 'USER', id: 'USR-77' } }),
        delivery(),
      );

      expect(record.actorType).toBe('USER');
      expect(record.actorId).toBe('USR-77');
    });

    it('attributes an actorless envelope to its producer as SYSTEM', () => {
      // The insurance-expiry-sweep case the ADR names. Without this the row
      // would carry an unexplained blank where the actor belongs.
      const record = toAuditEventRecord(envelope({ actor: undefined }), delivery());

      expect(record.actorType).toBe('SYSTEM');
      expect(record.actorId).toBe('asset-service');
    });

    it('records roles as an empty array, never null', () => {
      // Null would mean "unknown". Path A knows they are unavailable, which is
      // a different and more useful statement.
      const record = toAuditEventRecord(envelope(), delivery());

      expect(record.actorRoles).toEqual([]);
      expect(record.actorRoles).not.toBeNull();
    });
  });

  describe('tenant scope', () => {
    it('stores tenantId as the organization', () => {
      expect(toAuditEventRecord(envelope({ tenantId: 'ORG-9' }), delivery()).organizationId).toBe(
        'ORG-9',
      );
    });

    it('leaves a platform-scoped event with no organization', () => {
      // Nullable on purpose: a genuinely platform-wide action has no tenant,
      // and refusing it would drop evidence.
      expect(
        toAuditEventRecord(envelope({ tenantId: undefined }), delivery()).organizationId,
      ).toBeNull();
    });
  });

  describe('unknown event names', () => {
    it('stores an unrecognised name rather than dropping the event', () => {
      // The single most important property of this mapper. A store that
      // skipped unfamiliar events would be least reliable on the day a new
      // service ships.
      const record = toAuditEventRecord(
        envelope({ eventName: 'SOMETHING_NOBODY_DECLARED' }),
        delivery(),
      );

      expect(record.sourceEventName).toBe('SOMETHING_NOBODY_DECLARED');
      expect(record.action).toBe('SOMETHING_NOBODY_DECLARED');
    });

    it('falls the action back to the event name for every declared name too', () => {
      // ADR-053 defines no dotted actions for these events yet, so the action
      // is the name. If a future change adds a mapping, this test is where the
      // promise becomes visible.
      for (const name of ['USER_REGISTERED', 'ORDER_COMPLETED', 'MAINTENANCE_DUE']) {
        expect(toAuditEventRecord(envelope({ eventName: name }), delivery()).action).toBe(name);
      }
    });
  });

  describe('stream sequence (ADR § 8 — stored for detection only)', () => {
    it('preserves streamSeq as a bigint when present', () => {
      const record = toAuditEventRecord(envelope({ streamSeq: 42 }), delivery());
      expect(record.sourceStreamSeq).toBe(42n);
    });

    it('accepts an envelope without streamSeq', () => {
      // Required during a staged rollout: an old producer emits none and the
      // consumer must still record the event.
      expect(
        toAuditEventRecord(envelope({ streamSeq: undefined }), delivery()).sourceStreamSeq,
      ).toBeNull();
    });
  });

  describe('bounding, so an oversized field never costs the whole record', () => {
    it('truncates rather than letting PostgreSQL refuse the row', () => {
      // 22001 would turn one long value into a lost audit record. Losing the
      // tail of a string is the smaller harm.
      const record = toAuditEventRecord(
        envelope({ aggregateType: 'A'.repeat(500), correlationId: 'c'.repeat(500) }),
        delivery(`rasta.${'x'.repeat(400)}.v1`),
      );

      expect(record.resourceType).toHaveLength(128);
      expect(record.correlationId).toHaveLength(128);
      expect(record.sourceTopic).toHaveLength(256);
    });

    it('treats a blank optional field as absent', () => {
      // The migration refuses a blank string in these columns; absent and
      // blank mean the same thing.
      const record = toAuditEventRecord(envelope({ tenantId: '   ', causationId: '' }), delivery());

      expect(record.organizationId).toBeNull();
      expect(record.causationId).toBeNull();
    });
  });
});

describe('redaction reuses the platform list', () => {
  it('recognises the same keys @rasta/logging does, case-insensitively', () => {
    // ADR § 5 point 4: one list, reused. A second list is one that drifts.
    for (const key of SENSITIVE_KEYS.slice(0, 12)) {
      expect(isSensitiveKey(key)).toBe(true);
      expect(isSensitiveKey(key.toUpperCase())).toBe(true);
    }
    expect(isSensitiveKey('assetId')).toBe(false);
  });

  it('describes a payload by key names only, never values', () => {
    const described = describePayloadKeys({
      assetId: 'AST_1',
      password: 'hunter2',
      token: 'eyJhbGciOi',
    });

    // The whole point: no value from the payload may appear.
    expect(described).not.toContain('hunter2');
    expect(described).not.toContain('eyJhbGciOi');
    expect(described).not.toContain('AST_1');
    expect(described).toContain('assetId');
    expect(described).toContain('[REDACTED]');
  });

  it('bounds a wide payload description', () => {
    const wide = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field${i}`, i]));
    const described = describePayloadKeys(wide);

    expect(described).toContain('(60 keys)');
    expect(described.length).toBeLessThan(500);
  });

  it('handles payloads that are not objects', () => {
    expect(describePayloadKeys(undefined)).toBe('(none)');
    expect(describePayloadKeys(null)).toBe('(none)');
    expect(describePayloadKeys({})).toBe('(empty)');
    expect(describePayloadKeys('a string')).toBe('(string)');
    expect(describePayloadKeys([1, 2, 3])).toBe('(object)');
  });
});
