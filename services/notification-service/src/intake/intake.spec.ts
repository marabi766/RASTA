import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import { decideIntake, ID_PREFIX, newId, PoisonEventError, POISON_REASONS } from './intake';

const delivery = Object.freeze({ topic: 'rasta.insurance.v1', partition: 0 });

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: ulid(),
    eventName: 'INSURANCE_EXPIRING',
    eventVersion: 1,
    occurredAt: '2026-09-17T06:00:00.000Z',
    producer: 'asset-service',
    producerVersion: '0.1.0',
    aggregateType: 'InsurancePolicy',
    aggregateId: 'POL_1',
    tenantId: 'ORG_A',
    correlationId: 'COR_1',
    causationId: 'CAU_1',
    payload: {
      assetId: 'AST_1',
      organizationId: 'ORG_A',
      policyId: 'POL_1',
      insurerName: 'Insurer',
      validTo: '2026-10-17T00:00:00.000Z',
      daysRemaining: 25,
    },
    ...overrides,
  };
}

describe('intake decision', () => {
  it('ignores an event no rule claims, writing nothing', () => {
    expect(decideIntake(envelope({ eventName: 'INSURANCE_RECORDED' }), delivery)).toEqual({
      kind: 'IGNORED',
    });
  });

  it('describes a full intent for a supported event', () => {
    const source = envelope({ streamKey: 'POL_1', streamSeq: 42 });
    const decision = decideIntake(source, delivery);
    if (decision.kind !== 'INTENT') throw new Error('expected an intent');

    const { intent } = decision;
    expect(intent.id).toMatch(new RegExp(`^${ID_PREFIX.intent}_`));
    expect(intent.organizationId).toBe('ORG_A');
    expect(intent.sourceEventId).toBe(source.eventId);
    expect(intent.sourceEventName).toBe('INSURANCE_EXPIRING');
    expect(intent.sourceTopic).toBe('rasta.insurance.v1');
    expect(intent.sourcePartitionKey).toBe('POL_1');
    expect(intent.sourceStreamSeq).toBe(42n);
    expect(intent.occurredAt.toISOString()).toBe('2026-09-17T06:00:00.000Z');
    expect(intent.correlationId).toBe('COR_1');
    expect(intent.causationId).toBe('CAU_1');
    expect(intent.ruleKey).toBe('insurance.expiring');
    expect(intent.templateKey).toBe('insurance.expiring.in-app');
    expect(intent.severity).toBe('WARNING');
    expect(intent.classification).toBe('ROUTINE');
    expect(intent.subjectType).toBe('InsurancePolicy');
    expect(intent.subjectId).toBe('POL_1');
    expect(intent.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(intent.contextData).toEqual({
      assetId: 'AST_1',
      policyId: 'POL_1',
      insurerName: 'Insurer',
      validTo: '2026-10-17T00:00:00.000Z',
      daysRemaining: 25,
    });
    // organizationId is on the row, not in the context.
    expect(intent.contextData).not.toHaveProperty('organizationId');
    expect(intent.droppedContextKeys).toEqual(['organizationId']);
  });

  it('falls back to the aggregate id as the partition key and null sequence', () => {
    const decision = decideIntake(envelope(), delivery);
    if (decision.kind !== 'INTENT') throw new Error('expected an intent');
    expect(decision.intent.sourcePartitionKey).toBe('POL_1');
    expect(decision.intent.sourceStreamSeq).toBeNull();
    expect(decision.intent.causationId).toBe('CAU_1');
  });

  it('gives two distinct events about one fact in one band the same dedupe key', () => {
    // The 120-emission property at the envelope level: different eventId,
    // different occurredAt, same policy, same band → same key.
    const first = decideIntake(envelope({ eventId: ulid() }), delivery);
    const second = decideIntake(
      envelope({
        eventId: ulid(),
        occurredAt: '2026-09-17T12:00:00.000Z',
        payload: { ...(envelope().payload as object), daysRemaining: 20 },
      }),
      delivery,
    );
    if (first.kind !== 'INTENT' || second.kind !== 'INTENT') throw new Error('expected intents');
    expect(first.intent.sourceEventId).not.toBe(second.intent.sourceEventId);
    expect(first.intent.dedupeKey).toBe(second.intent.dedupeKey);
  });

  it('gives a new band a new dedupe key', () => {
    const wide = decideIntake(envelope(), delivery);
    const narrow = decideIntake(
      envelope({ payload: { ...(envelope().payload as object), daysRemaining: 3 } }),
      delivery,
    );
    if (wide.kind !== 'INTENT' || narrow.kind !== 'INTENT') throw new Error('expected intents');
    expect(wide.intent.dedupeKey).not.toBe(narrow.intent.dedupeKey);
  });

  describe('poison', () => {
    it('refuses an envelope with no tenant', () => {
      const { tenantId: _omitted, ...withoutTenant } = envelope();
      expect(() => decideIntake(withoutTenant as EventEnvelope, delivery)).toThrow(
        PoisonEventError,
      );
      try {
        decideIntake(withoutTenant as EventEnvelope, delivery);
      } catch (error) {
        expect((error as PoisonEventError).reason).toBe(POISON_REASONS.MISSING_TENANT);
      }
    });

    it('refuses a payload that fails the rule schema, naming paths and never values', () => {
      const bad = envelope({
        payload: { assetId: 'AST_1', daysRemaining: 'seven', secret: 'hunter2' },
      });
      let caught: PoisonEventError | undefined;
      try {
        decideIntake(bad, delivery);
      } catch (error) {
        caught = error as PoisonEventError;
      }
      expect(caught).toBeInstanceOf(PoisonEventError);
      expect(caught?.reason).toBe(POISON_REASONS.PAYLOAD_INVALID);
      expect(caught?.message).toContain('daysRemaining');
      expect(caught?.message).not.toContain('hunter2');
      expect(caught?.message).not.toContain('seven');
    });

    it('refuses a payload whose organization disagrees with the envelope tenant', () => {
      const crossed = envelope({
        payload: { ...(envelope().payload as object), organizationId: 'ORG_B' },
      });
      expect(() => decideIntake(crossed, delivery)).toThrow(/different organization/);
      try {
        decideIntake(crossed, delivery);
      } catch (error) {
        expect((error as PoisonEventError).reason).toBe(POISON_REASONS.TENANT_MISMATCH);
      }
    });
  });

  it('prefixes every id it mints', () => {
    for (const kind of Object.keys(ID_PREFIX) as (keyof typeof ID_PREFIX)[]) {
      expect(newId(kind)).toMatch(new RegExp(`^${ID_PREFIX[kind]}_[0-9A-HJKMNP-TV-Z]{26}$`));
    }
  });
});
