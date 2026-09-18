import {
  AUDIT_EVENT_RECORDED,
  AUDIT_EVENT_RECORDED_VERSION,
  AUDIT_TRAIL_TOPIC,
  ERROR_CODES,
  type EventEnvelope,
} from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import { SENSITIVE_KEYS } from '@rasta/logging';
import {
  AUDIT_TRAIL_CONSUMER,
  AUDIT_TRAIL_REJECTION_REASONS,
  AuditTrailRejectedError,
  toAuditTrailRecord,
} from './audit-trail.mapper';
import { DOMAIN_PROJECTOR_CONSUMER } from './audit.mapper';

/**
 * Path B's boundary: what an `AUDIT_EVENT_RECORDED` message must be before it
 * becomes evidence, and what each field becomes.
 *
 * Fixtures are built from the exported contract constants rather than from
 * restated literals, so this suite tests the consumer against the contract the
 * producer will be held to — not against a second copy of it.
 */

const TENANT = 'ORG_01JTRAIL0000000000000001';
const ACTOR = 'USR_01JTRAIL0000000000000001';
const EVENT_ID = '01JTRAILMAPPERSPEC00000001';

const delivery = (topic: string = AUDIT_TRAIL_TOPIC): EventDelivery =>
  Object.freeze({ topic, partition: 2 });

/** A minimal, valid ADR-053 § 4 refusal. */
function refusal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor: { type: 'USER', id: ACTOR, roles: ['UNION_ADMIN', 'FLEET_MANAGER'] },
    organizationId: TENANT,
    action: 'audit.access.refuse',
    resourceType: 'AuditEvent',
    resourceId: 'AEV_01JTRAIL0000000000000009',
    outcome: 'REFUSED',
    errorCode: ERROR_CODES.TENANT_MISMATCH,
    occurrenceCount: 3,
    source: { ip: '10.0.1.42', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' },
    ...overrides,
  };
}

/** A valid ADR-053 § 7 correction of the record `target`. */
function correction(target: string, overrides: Record<string, unknown> = {}) {
  return refusal({
    action: 'audit.correction',
    outcome: 'SUCCESS',
    errorCode: undefined,
    occurrenceCount: 1,
    reason: 'Actor was recorded against the wrong resource; ticket SEC-114.',
    resourceId: target,
    correctionOf: target,
    ...overrides,
  });
}

function envelope(
  payload: unknown = refusal(),
  overrides: Record<string, unknown> = {},
): EventEnvelope {
  return {
    eventId: EVENT_ID,
    eventName: AUDIT_EVENT_RECORDED,
    eventVersion: AUDIT_EVENT_RECORDED_VERSION,
    occurredAt: '2026-09-15T10:30:00.000Z',
    producer: 'identity-service',
    producerVersion: '1.2.0',
    aggregateType: 'AuditEvent',
    aggregateId: 'AEV_01JTRAIL0000000000000009',
    tenantId: TENANT,
    correlationId: 'corr-trail-1',
    causationId: 'cause-trail-1',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    streamSeq: 11,
    payload,
    ...overrides,
  } as EventEnvelope;
}

/** The rejection a message produces, or a failure if it was accepted. */
function rejectionOf(
  source: EventEnvelope,
  via: EventDelivery = delivery(),
): AuditTrailRejectedError {
  try {
    toAuditTrailRecord(source, via);
  } catch (error) {
    if (error instanceof AuditTrailRejectedError) return error;
    throw error;
  }
  throw new Error('expected the message to be rejected');
}

describe('the path-B consumer identity', () => {
  it('is its own group and its own idempotency namespace', () => {
    expect(AUDIT_TRAIL_CONSUMER).toBe('audit-service.trail');
    expect(AUDIT_TRAIL_CONSUMER).not.toBe(DOMAIN_PROJECTOR_CONSUMER);
  });

  it('refuses for a closed set of reasons', () => {
    expect([...AUDIT_TRAIL_REJECTION_REASONS]).toEqual([
      'trail_invalid_envelope',
      'trail_unsupported_event',
      'trail_invalid_payload',
      'trail_tenant_mismatch',
      'trail_unredacted_sensitive_change',
    ]);
  });
});

describe('a valid refusal', () => {
  it('maps every path-B field into the record', () => {
    const record = toAuditTrailRecord(envelope(), delivery());

    expect(record).toEqual({
      id: expect.any(String),
      occurredAt: new Date('2026-09-15T10:30:00.000Z'),

      actorType: 'USER',
      actorId: ACTOR,
      actorRoles: ['UNION_ADMIN', 'FLEET_MANAGER'],
      organizationId: TENANT,

      action: 'audit.access.refuse',
      resourceType: 'AuditEvent',
      resourceId: 'AEV_01JTRAIL0000000000000009',

      outcome: 'REFUSED',
      errorCode: 'TENANT_MISMATCH',
      reason: null,
      changes: null,
      occurrenceCount: 3,

      sourceIp: '10.0.1.42',
      sourceUserAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
      correctionOf: null,

      sourceService: 'identity-service',
      sourceServiceVersion: '1.2.0',
      sourceEventId: EVENT_ID,
      sourceEventName: AUDIT_EVENT_RECORDED,
      sourceTopic: AUDIT_TRAIL_TOPIC,
      correlationId: 'corr-trail-1',
      causationId: 'cause-trail-1',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      sourceStreamSeq: 11n,
    });
  });

  it('gives the record a fresh audit id, never the source event id', () => {
    const first = toAuditTrailRecord(envelope(), delivery());
    const second = toAuditTrailRecord(envelope(), delivery());

    expect(first.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first.id).not.toBe(EVENT_ID);
    expect(first.id).not.toBe(second.id);
  });

  it('copies the role list rather than sharing it with the message', () => {
    const source = envelope();
    const record = toAuditTrailRecord(source, delivery());

    record.actorRoles.push('SYSTEM_ADMIN');

    expect((source.payload as { actor: { roles: string[] } }).actor.roles).toEqual([
      'UNION_ADMIN',
      'FLEET_MANAGER',
    ]);
  });

  it('applies the contract defaults and keeps an explicit null resource', () => {
    const record = toAuditTrailRecord(
      envelope(
        refusal({
          actor: { type: 'SERVICE', id: 'asset-service' },
          occurrenceCount: undefined,
          resourceId: null,
          source: undefined,
          errorCode: undefined,
        }),
      ),
      delivery(),
    );

    // Empty, never null: "known to hold no roles" (ADR-053 § 5).
    expect(record.actorRoles).toEqual([]);
    expect(record.actorType).toBe('SERVICE');
    expect(record.occurrenceCount).toBe(1);
    expect(record.resourceId).toBeNull();
    expect(record.sourceIp).toBeNull();
    expect(record.sourceUserAgent).toBeNull();
    expect(record.errorCode).toBeNull();
  });

  it('accepts an envelope that omits eventVersion, which the envelope contract defaults to 1', () => {
    const source = envelope();
    delete (source as { eventVersion?: number }).eventVersion;

    expect(toAuditTrailRecord(source, delivery()).sourceEventName).toBe(AUDIT_EVENT_RECORDED);
  });
});

describe('a safe structured delta', () => {
  const SAFE_CHANGES = [
    { field: 'status', from: 'ACTIVE', to: 'SUSPENDED' },
    { field: 'seatCount', from: 3, to: 4 },
    { field: 'mfaRequired', from: false, to: true },
    { field: 'suspendedAt', from: null, to: '2026-09-15T10:30:00.000Z' },
    { field: 'password', from: { redacted: true }, to: { redacted: true } },
    { field: 'nationalId', from: { hash: 'sha256:aa11' }, to: { hash: 'sha256:bb22' } },
    { field: 'bidAmount', from: null, to: { redacted: true } },
  ];

  it('is stored exactly as declared, markers included', () => {
    const record = toAuditTrailRecord(
      envelope(refusal({ outcome: 'SUCCESS', errorCode: undefined, changes: SAFE_CHANGES })),
      delivery(),
    );

    expect(record.changes).toEqual(SAFE_CHANGES);
  });

  it('keeps an empty delta as an empty array, distinct from no delta', () => {
    expect(toAuditTrailRecord(envelope(refusal({ changes: [] })), delivery()).changes).toEqual([]);
    expect(toAuditTrailRecord(envelope(refusal()), delivery()).changes).toBeNull();
  });

  it('refuses a raw nested object, which is a payload dump by another name', () => {
    const rejection = rejectionOf(
      envelope(refusal({ changes: [{ field: 'profile', from: null, to: { email: 'x@y.test' } }] })),
    );

    expect(rejection.reason).toBe('trail_invalid_payload');
    expect(rejection.message).toContain('changes.0.to');
    expect(rejection.message).not.toContain('x@y.test');
  });

  describe('a sensitive field carrying a raw value', () => {
    // Derived from the platform list, so a key added to `@rasta/logging`
    // tomorrow is exercised here the moment it is declared.
    it.each(SENSITIVE_KEYS.map((key) => [key]))('refuses %s in the clear', (key) => {
      const secret = `SENTINEL-${key}-value`;
      const rejection = rejectionOf(
        envelope(refusal({ changes: [{ field: key, from: null, to: secret }] })),
      );

      expect(rejection.reason).toBe('trail_unredacted_sensitive_change');
      expect(rejection.detail).toContain('changes.0');
      expect(rejection.message).not.toContain(secret);
    });

    it('refuses it in the `from` position, in any case, and under a dotted path', () => {
      for (const field of ['PASSWORD', 'credentials.password', 'payment.cardNumber']) {
        const rejection = rejectionOf(
          envelope(
            refusal({
              changes: [
                { field: 'status', from: 'A', to: 'B' },
                { field, from: 'SENTINEL-old', to: { redacted: true } },
              ],
            }),
          ),
        );

        expect(rejection.reason).toBe('trail_unredacted_sensitive_change');
        expect(rejection.detail).toContain('changes.1');
        expect(rejection.detail).not.toContain('changes.0');
        expect(rejection.message).not.toContain('SENTINEL');
      }
    });

    it('does not mistake a field that merely contains a sensitive word', () => {
      // `passwordChangedAt` is not `password`. A substring rule would refuse
      // ordinary evidence about a sensitive action, which is exactly the
      // evidence a reviewer wants.
      const record = toAuditTrailRecord(
        envelope(
          refusal({ changes: [{ field: 'passwordChangedAt', from: null, to: '2026-09-15' }] }),
        ),
        delivery(),
      );

      expect(record.changes).toHaveLength(1);
    });
  });
});

describe('a correction (ADR-053 § 7)', () => {
  const TARGET = '01JAUDITTARGET000000000001';

  it('is a fresh record that names the record it corrects', () => {
    const record = toAuditTrailRecord(envelope(correction(TARGET)), delivery());

    expect(record.correctionOf).toBe(TARGET);
    expect(record.action).toBe('audit.correction');
    expect(record.outcome).toBe('SUCCESS');
    expect(record.reason).toBe('Actor was recorded against the wrong resource; ticket SEC-114.');
    expect(record.actorType).toBe('USER');
    // A new audit id, never the corrected one: nothing here edits the original.
    expect(record.id).not.toBe(TARGET);
  });

  it('still enforces the contract invariants, never a looser version of them', () => {
    const rejection = rejectionOf(
      envelope(correction(TARGET, { actor: { type: 'SERVICE', id: 'identity-service' } })),
    );

    expect(rejection.reason).toBe('trail_invalid_payload');
    expect(rejection.detail).toContain('actor.type custom');
  });

  it('refuses a correction link wider than the column rather than truncating it', () => {
    // A truncated link would point the correction at a record nobody named.
    const rejection = rejectionOf(envelope(correction('X'.repeat(65))));

    expect(rejection.reason).toBe('trail_invalid_payload');
    expect(rejection.detail).toBe('correctionOf exceeds 64 characters');
  });

  it('refuses a reason made of whitespace, which says nothing', () => {
    const rejection = rejectionOf(envelope(correction(TARGET, { reason: '   ' })));

    expect(rejection.reason).toBe('trail_invalid_payload');
    expect(rejection.detail).toBe('reason blank');
  });

  it('refuses a blank correction link', () => {
    const rejection = rejectionOf(envelope(correction('   ')));

    expect(rejection.detail).toContain('correctionOf');
  });
});

describe('event name, version and topic', () => {
  it('refuses any event name other than AUDIT_EVENT_RECORDED', () => {
    const rejection = rejectionOf(envelope(refusal(), { eventName: 'ASSET_DECOMMISSIONED' }));

    expect(rejection.reason).toBe('trail_unsupported_event');
    expect(rejection.detail).toBe('eventName is not AUDIT_EVENT_RECORDED');
  });

  it('refuses a payload version this consumer does not implement', () => {
    const rejection = rejectionOf(
      envelope(refusal(), { eventVersion: AUDIT_EVENT_RECORDED_VERSION + 1 }),
    );

    expect(rejection.reason).toBe('trail_unsupported_event');
    expect(rejection.detail).toBe(`eventVersion is not ${AUDIT_EVENT_RECORDED_VERSION}`);
  });

  it('refuses a trail event delivered on any other topic', () => {
    // `sourceTopic` is what tells a path-B row from a path-A row forever.
    const rejection = rejectionOf(envelope(), delivery('rasta.identity.v1'));

    expect(rejection.reason).toBe('trail_unsupported_event');
    expect(rejection.detail).toBe(`not delivered on ${AUDIT_TRAIL_TOPIC}`);
  });

  it('checks the envelope before the name, and the name before the payload', () => {
    const noEnvelope = rejectionOf(
      envelope({ nonsense: true }, { eventName: 'OTHER', correlationId: undefined }),
    );
    expect(noEnvelope.reason).toBe('trail_invalid_envelope');

    const wrongName = rejectionOf(envelope({ nonsense: true }, { eventName: 'OTHER' }));
    expect(wrongName.reason).toBe('trail_unsupported_event');
  });
});

describe('malformed messages', () => {
  it('refuses an envelope that does not parse, naming the path and never the value', () => {
    const rejection = rejectionOf(
      envelope(refusal(), { eventName: 'SENTINEL not a name', correlationId: undefined }),
    );

    expect(rejection.reason).toBe('trail_invalid_envelope');
    expect(rejection.detail).toContain('eventName invalid_string');
    expect(rejection.detail).toContain('correlationId invalid_type');
    expect(rejection.message).not.toContain('SENTINEL');
  });

  it('refuses a payload that is not an object', () => {
    const rejection = rejectionOf(envelope('SENTINEL-a-string-payload'));

    expect(rejection.reason).toBe('trail_invalid_payload');
    expect(rejection.detail).toBe('(root) invalid_type');
    expect(rejection.message).not.toContain('SENTINEL');
  });

  it('refuses an out-of-contract value without quoting what Zod received', () => {
    // Zod's own message for an enum is "received 'X'". This is the case that
    // would leak a value if a Zod message were ever passed through.
    const rejection = rejectionOf(envelope(refusal({ outcome: 'SENTINEL-outcome' })));

    expect(rejection.reason).toBe('trail_invalid_payload');
    expect(rejection.detail).toBe('outcome invalid_enum_value');
    expect(rejection.message).not.toContain('SENTINEL');
  });

  it('refuses an undeclared key without naming it or its value', () => {
    const rejection = rejectionOf(envelope(refusal({ smuggledSecretKey: 'SENTINEL-smuggled' })));

    expect(rejection.reason).toBe('trail_invalid_payload');
    expect(rejection.detail).toBe('(root) unrecognized_keys');
    expect(rejection.message).not.toContain('smuggledSecretKey');
    expect(rejection.message).not.toContain('SENTINEL');
  });

  it('refuses blank identifiers PostgreSQL would refuse, before any write is attempted', () => {
    const rejection = rejectionOf(
      envelope(
        refusal({
          actor: { type: 'USER', id: '   ', roles: [] },
          resourceType: '  ',
          resourceId: '\t',
        }),
      ),
    );

    expect(rejection.reason).toBe('trail_invalid_payload');
    expect(rejection.detail).toBe('actor.id, resourceType, resourceId blank');
  });

  it.each([[2_147_483_648], [1e300]])(
    'refuses an occurrence count of %s, which the INTEGER column cannot hold',
    (occurrenceCount) => {
      const rejection = rejectionOf(envelope(refusal({ occurrenceCount })));

      expect(rejection.reason).toBe('trail_invalid_payload');
      expect(rejection.detail).toBe('occurrenceCount exceeds 2147483647');
    },
  );

  it('bounds how many issues one rejection names', () => {
    const changes = Array.from({ length: 30 }, () => ({ field: 'status', from: [], to: [] }));
    const rejection = rejectionOf(envelope(refusal({ changes })));

    expect(rejection.reason).toBe('trail_invalid_payload');
    expect(rejection.detail).toMatch(/…\(\d+ total\)$/);
    expect(rejection.message.length).toBeLessThan(1000);
  });
});

describe('tenant agreement is fail-closed', () => {
  it('records a tenant payload whose organization equals the envelope tenant', () => {
    expect(toAuditTrailRecord(envelope(), delivery()).organizationId).toBe(TENANT);
  });

  it('records a platform payload only when both are absent', () => {
    const record = toAuditTrailRecord(
      envelope(refusal({ organizationId: undefined }), { tenantId: undefined }),
      delivery(),
    );

    expect(record.organizationId).toBeNull();
  });

  const MISMATCHES: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
    [
      'the payload names a tenant and the envelope none',
      {},
      { tenantId: undefined },
      'payload organizationId present, envelope tenantId absent',
    ],
    [
      'the envelope names a tenant and the payload none',
      { organizationId: undefined },
      {},
      'envelope tenantId present, payload organizationId absent',
    ],
    [
      'the envelope tenant is an empty string and the payload names none',
      { organizationId: undefined },
      { tenantId: '' },
      'envelope tenantId present, payload organizationId absent',
    ],
    [
      'the two name different tenants',
      { organizationId: 'ORG_01JTRAIL0000000000000002' },
      {},
      'payload organizationId differs from envelope tenantId',
    ],
    [
      'the two differ only by case',
      { organizationId: TENANT.toLowerCase() },
      {},
      'payload organizationId differs from envelope tenantId',
    ],
    [
      'both are the same blank value',
      { organizationId: '   ' },
      { tenantId: '   ' },
      'blank organization identifier',
    ],
    [
      'the payload organization is blank',
      { organizationId: '  ' },
      {},
      'blank organization identifier',
    ],
    ['the envelope tenant is blank', {}, { tenantId: ' ' }, 'blank organization identifier'],
  ];

  it.each(MISMATCHES)('refuses when %s', (_case, payloadOverrides, envelopeOverrides, detail) => {
    const rejection = rejectionOf(envelope(refusal(payloadOverrides), envelopeOverrides));

    expect(rejection.reason).toBe('trail_tenant_mismatch');
    expect(rejection.detail).toBe(detail);
    // Neither identifier reaches the message, in either spelling.
    expect(rejection.message).not.toContain(TENANT);
    expect(rejection.message.toLowerCase()).not.toContain(TENANT.toLowerCase());
    expect(rejection.message).not.toContain('ORG_01JTRAIL0000000000000002');
  });

  it('never infers a tenant from the actor, the resource or the aggregate', () => {
    // Every other field names the tenant, and the record is still a platform
    // record, because the only two places tenant identity may come from both
    // say "none".
    const platform = toAuditTrailRecord(
      envelope(
        refusal({
          organizationId: undefined,
          actor: { type: 'USER', id: TENANT, roles: [] },
          resourceType: 'Organization',
          resourceId: TENANT,
        }),
        { tenantId: undefined, aggregateId: TENANT },
      ),
      delivery(),
    );
    expect(platform.organizationId).toBeNull();

    // And a disagreement is not settled by them either.
    const rejection = rejectionOf(
      envelope(
        refusal({
          organizationId: undefined,
          actor: { type: 'USER', id: TENANT, roles: [] },
          resourceId: TENANT,
        }),
        { aggregateId: TENANT },
      ),
    );
    expect(rejection.reason).toBe('trail_tenant_mismatch');
  });
});
