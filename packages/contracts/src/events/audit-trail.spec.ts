import type { z } from 'zod';
import { ERROR_CODES } from '../common/errors';
import { AUDIT_TRAIL_TOPIC, parseEnvelope } from './envelope';
import {
  AUDIT_ACTION_PATTERN,
  AUDIT_CHANGES_MAX_ENTRIES,
  AUDIT_CORRECTION_ACTION,
  AUDIT_EVENT_RECORDED,
  AUDIT_EVENT_RECORDED_VERSION,
  AUDIT_OUTCOMES,
  auditChangeSchema,
  auditChangeValueSchema,
  auditTrailActorSchema,
  auditTrailPayloadSchemaV1,
} from './audit-trail';

/**
 * ADR-053 §§ 1, 5, 7 — the path-B wire contract.
 *
 * These tests hold the contract to the ADR's own words: the outcomes, the
 * dotted-verb shape, the `changes` bounds and markers, and the four
 * correction invariants. None of them exercise a producer or a consumer —
 * neither exists yet (AUD-004 Phase A) — only the schema a future one of each
 * must agree on.
 */

const validActor = {
  type: 'USER' as const,
  id: 'USR_01J000000000000000000001',
  roles: ['FLEET_MANAGER'],
};
const serviceActor = { type: 'SERVICE' as const, id: 'asset-service', roles: [] };

/** A minimal, otherwise-valid refusal — the § 4 case this contract exists for. */
function baseRefusal(overrides: Partial<z.input<typeof auditTrailPayloadSchemaV1>> = {}) {
  return {
    actor: validActor,
    organizationId: 'ORG_01J000000000000000000001',
    action: 'audit.access.refuse',
    resourceType: 'AuditEvent',
    resourceId: null,
    outcome: 'REFUSED' as const,
    errorCode: ERROR_CODES.TENANT_MISMATCH,
    occurrenceCount: 1,
    source: { ip: '10.0.1.42', userAgent: 'Mozilla/5.0' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valid shapes the ADR names by name
// ---------------------------------------------------------------------------

describe('a valid refusal (ADR-053 § 4)', () => {
  it('parses with an aggregated occurrence count and no changes', () => {
    const payload = auditTrailPayloadSchemaV1.parse(
      baseRefusal({ occurrenceCount: 500, errorCode: ERROR_CODES.TENANT_MISMATCH }),
    );
    expect(payload.outcome).toBe('REFUSED');
    expect(payload.occurrenceCount).toBe(500);
    expect(payload.errorCode).toBe(ERROR_CODES.TENANT_MISMATCH);
    expect(payload.changes).toBeUndefined();
    expect(payload.correctionOf).toBeUndefined();
  });

  it('defaults occurrenceCount to 1 when a single refusal is reported', () => {
    const payload = auditTrailPayloadSchemaV1.parse(baseRefusal({ occurrenceCount: undefined }));
    expect(payload.occurrenceCount).toBe(1);
  });
});

describe('a valid high-value success carrying a safe delta (ADR-053 § 5)', () => {
  it('parses with a scalar before/after and a redacted field side by side', () => {
    const payload = auditTrailPayloadSchemaV1.parse({
      actor: validActor,
      organizationId: 'ORG_01J000000000000000000001',
      action: 'asset.decommission',
      resourceType: 'Asset',
      resourceId: 'AST_01J000000000000000000001',
      outcome: 'SUCCESS',
      reason: 'پایان عمر مفید',
      changes: [
        { field: 'status', from: 'ACTIVE', to: 'DECOMMISSIONED' },
        { field: 'nationalId', from: { redacted: true }, to: { redacted: true } },
        { field: 'sealedPayload', from: null, to: { hash: 'sha256:abc123' } },
      ],
      source: { ip: '10.0.1.42', userAgent: 'Mozilla/5.0' },
    });
    expect(payload.changes).toHaveLength(3);
    expect(payload.changes?.[0]).toEqual({ field: 'status', from: 'ACTIVE', to: 'DECOMMISSIONED' });
  });

  it('parses an event with no organizationId for a genuinely platform-scoped action', () => {
    const payload = auditTrailPayloadSchemaV1.parse({
      actor: serviceActor,
      action: 'audit.chain.verify',
      resourceType: 'AuditChain',
      resourceId: null,
      outcome: 'SUCCESS',
    });
    expect(payload.organizationId).toBeUndefined();
  });
});

describe('a valid correction (ADR-053 § 7)', () => {
  it('parses with every invariant satisfied', () => {
    const payload = auditTrailPayloadSchemaV1.parse({
      actor: validActor,
      organizationId: 'ORG_01J000000000000000000001',
      action: AUDIT_CORRECTION_ACTION,
      resourceType: 'AuditEvent',
      resourceId: 'AUD_01J000000000000000000009',
      outcome: 'SUCCESS',
      reason: 'ثبت اشتباه؛ نتیجهٔ واقعی FAILURE بود',
      changes: [{ field: 'outcome', from: 'SUCCESS', to: 'FAILURE' }],
      correctionOf: 'AUD_01J000000000000000000009',
    });
    expect(payload.correctionOf).toBe('AUD_01J000000000000000000009');
    expect(payload.action).toBe('audit.correction');
  });
});

// ---------------------------------------------------------------------------
// outcome — the closed set
// ---------------------------------------------------------------------------

describe('outcome', () => {
  it.each(AUDIT_OUTCOMES)('accepts %s', (outcome) => {
    expect(() =>
      auditTrailPayloadSchemaV1.parse(
        baseRefusal({
          outcome,
          errorCode: outcome === 'REFUSED' ? ERROR_CODES.FORBIDDEN : undefined,
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a value outside the enum', () => {
    expect(() =>
      auditTrailPayloadSchemaV1.parse(baseRefusal({ outcome: 'DENIED' as never })),
    ).toThrow();
  });

  it('rejects a lowercase spelling of a real outcome', () => {
    expect(() =>
      auditTrailPayloadSchemaV1.parse(baseRefusal({ outcome: 'success' as never })),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// action — the dotted-verb shape
// ---------------------------------------------------------------------------

describe('action naming', () => {
  it.each([
    ['a bare SCREAMING_SNAKE_CASE event name', 'ASSET_DECOMMISSIONED'],
    ['no dot at all', 'decommission'],
    ['an uppercase segment', 'Asset.decommission'],
    ['a leading digit', '1asset.decommission'],
    ['a trailing dot', 'asset.decommission.'],
    ['a space', 'asset decommission'],
    ['an empty string', ''],
  ])('rejects %s (%p)', (_label, action) => {
    expect(() => auditTrailPayloadSchemaV1.parse(baseRefusal({ action }))).toThrow();
  });

  it.each(['asset.decommission', 'audit.correction', 'a.b.c', 'x1.y2'])('accepts %p', (action) => {
    expect(() => auditTrailPayloadSchemaV1.parse(baseRefusal({ action }))).not.toThrow();
  });

  it('rejects an action longer than the persisted column (256 chars)', () => {
    const tooLong = `a.${'b'.repeat(256)}`;
    expect(tooLong.length).toBeGreaterThan(256);
    expect(() => auditTrailPayloadSchemaV1.parse(baseRefusal({ action: tooLong }))).toThrow();
  });

  it('the pattern requires at least one dot', () => {
    expect(AUDIT_ACTION_PATTERN.test('audit.correction')).toBe(true);
    expect(AUDIT_ACTION_PATTERN.test('auditcorrection')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reason — bounded and, when present, non-empty
// ---------------------------------------------------------------------------

describe('reason', () => {
  it('accepts an absent reason', () => {
    const payload = auditTrailPayloadSchemaV1.parse(baseRefusal({ reason: undefined }));
    expect(payload.reason).toBeUndefined();
  });

  it('rejects an empty reason when the key is present', () => {
    expect(() => auditTrailPayloadSchemaV1.parse(baseRefusal({ reason: '' }))).toThrow();
  });

  it('accepts a reason at exactly the 1000-character ceiling', () => {
    const reason = 'x'.repeat(1000);
    expect(() => auditTrailPayloadSchemaV1.parse(baseRefusal({ reason }))).not.toThrow();
  });

  it('rejects a reason one character past the ceiling', () => {
    const reason = 'x'.repeat(1001);
    expect(() => auditTrailPayloadSchemaV1.parse(baseRefusal({ reason }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// occurrenceCount — invalid shapes
// ---------------------------------------------------------------------------

describe('occurrenceCount', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('rejects %s', (_label, value) => {
    expect(() =>
      auditTrailPayloadSchemaV1.parse(baseRefusal({ occurrenceCount: value })),
    ).toThrow();
  });

  it('accepts the windowed-aggregation example the ADR itself gives (500)', () => {
    const payload = auditTrailPayloadSchemaV1.parse(baseRefusal({ occurrenceCount: 500 }));
    expect(payload.occurrenceCount).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// changes — bounds and markers (ADR-053 § 5)
// ---------------------------------------------------------------------------

describe('changes', () => {
  it('accepts exactly the 50-entry ceiling', () => {
    const changes = Array.from({ length: AUDIT_CHANGES_MAX_ENTRIES }, (_, i) => ({
      field: `field${i}`,
      from: i,
      to: i + 1,
    }));
    expect(() => auditTrailPayloadSchemaV1.parse(baseRefusal({ changes }))).not.toThrow();
  });

  it('rejects one entry past the 50-entry ceiling', () => {
    const changes = Array.from({ length: AUDIT_CHANGES_MAX_ENTRIES + 1 }, (_, i) => ({
      field: `field${i}`,
      from: i,
      to: i + 1,
    }));
    expect(() => auditTrailPayloadSchemaV1.parse(baseRefusal({ changes }))).toThrow();
  });

  it.each([
    ['a plain nested object as a value', { field: 'x', from: { nested: 'dump' }, to: 1 }],
    ['an array as a value', { field: 'x', from: [1, 2, 3], to: 1 }],
    ['undefined as a value', { field: 'x', from: undefined, to: 1 }],
    [
      'a redacted marker with an extra key',
      { field: 'x', from: { redacted: true, value: 'leak' }, to: 1 },
    ],
    [
      'a hash marker with an extra key',
      { field: 'x', from: { hash: 'abc', value: 'leak' }, to: 1 },
    ],
    ['redacted: false, which is not the marker', { field: 'x', from: { redacted: false }, to: 1 }],
    ['an entry with an unexpected extra key', { field: 'x', from: 1, to: 2, extra: 'nope' }],
  ])('rejects an unsafe/raw change shape: %s', (_label, entry) => {
    expect(() => auditChangeSchema.parse(entry)).toThrow();
  });

  it.each([
    ['__proto__', { field: '__proto__', from: 1, to: 2 }],
    ['constructor', { field: 'constructor', from: 1, to: 2 }],
    ['prototype', { field: 'prototype', from: 1, to: 2 }],
  ])('rejects the prototype-pollution-prone field name %s', (_label, entry) => {
    expect(() => auditChangeSchema.parse(entry)).toThrow();
  });

  it('rejects a raw payload dump in place of the changes array', () => {
    // The exact failure mode ADR-053 § 2.1 forbids for path A and § 5 forbids
    // outright: a whole object where an array of declared entries belongs.
    expect(() =>
      auditTrailPayloadSchemaV1.parse(
        baseRefusal({ changes: { bidAmount: 500_000, sealedPayload: 'raw' } as never }),
      ),
    ).toThrow();
  });

  it.each([
    ['a string value', 'ACTIVE'],
    ['a number value', 42],
    ['a boolean value', true],
    ['a null value', null],
    ['a redacted marker', { redacted: true }],
    ['a hash marker', { hash: 'sha256:abc123' }],
  ])('accepts %s as a change value', (_label, value) => {
    expect(() => auditChangeValueSchema.parse(value)).not.toThrow();
  });

  it('rejects an undeclared field being silently accepted as present', () => {
    // § 5 point 1: an undeclared field is absent, never redacted-and-present.
    // This is enforced by never accepting a shape wider than one declared
    // entry per element — proven above — not by a runtime "declared fields"
    // registry, which is a producer-side concern this contract does not own.
    expect(() => auditChangeSchema.parse({ field: 'x', from: 1, to: 2, declared: true })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// actor — reused envelope actor type, plus roles
// ---------------------------------------------------------------------------

describe('actor', () => {
  it('defaults roles to an empty array, never omitting the key', () => {
    const actor = auditTrailActorSchema.parse({ type: 'SERVICE', id: 'asset-service' });
    expect(actor.roles).toEqual([]);
  });

  it('rejects ANONYMOUS — path B never has an unattributable actor (ADR-053 § 4)', () => {
    expect(() =>
      auditTrailActorSchema.parse({ type: 'ANONYMOUS', id: 'unknown', roles: [] }),
    ).toThrow();
  });

  it('rejects an actor with no id', () => {
    expect(() => auditTrailActorSchema.parse({ type: 'USER', id: '', roles: [] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// organizationId — optional, and bounded when present
// ---------------------------------------------------------------------------

describe('organizationId', () => {
  it('rejects a blank organizationId rather than treating it as platform-scoped', () => {
    expect(() => auditTrailPayloadSchemaV1.parse(baseRefusal({ organizationId: '' }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// errorCode — a platform ErrorCode, never a free string
// ---------------------------------------------------------------------------

describe('errorCode', () => {
  it('accepts every platform ErrorCode', () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(() => auditTrailPayloadSchemaV1.parse(baseRefusal({ errorCode: code }))).not.toThrow();
    }
  });

  it('rejects a free-text string that is not a platform ErrorCode', () => {
    expect(() =>
      auditTrailPayloadSchemaV1.parse(baseRefusal({ errorCode: 'SOMETHING_MADE_UP' as never })),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// correction invariants — every one of the four, tested in isolation
// ---------------------------------------------------------------------------

describe('correction invariants (ADR-053 § 7)', () => {
  function baseCorrection(overrides: Partial<z.input<typeof auditTrailPayloadSchemaV1>> = {}) {
    return {
      actor: validActor,
      organizationId: 'ORG_01J000000000000000000001',
      action: AUDIT_CORRECTION_ACTION,
      resourceType: 'AuditEvent',
      resourceId: 'AUD_01J000000000000000000009',
      outcome: 'SUCCESS' as const,
      reason: 'ثبت اشتباه',
      correctionOf: 'AUD_01J000000000000000000009',
      ...overrides,
    };
  }

  it('a payload with no correctionOf is exempt from all four rules', () => {
    expect(() =>
      auditTrailPayloadSchemaV1.parse(
        baseRefusal({
          action: 'audit.correction',
          outcome: 'REFUSED',
          errorCode: ERROR_CODES.FORBIDDEN,
          reason: undefined,
          correctionOf: undefined,
        }),
      ),
    ).not.toThrow();
  });

  it('requires action === "audit.correction"', () => {
    expect(() =>
      auditTrailPayloadSchemaV1.parse(baseCorrection({ action: 'asset.decommission' })),
    ).toThrow(/audit\.correction/);
  });

  it('requires outcome === "SUCCESS"', () => {
    expect(() =>
      auditTrailPayloadSchemaV1.parse(
        baseCorrection({ outcome: 'FAILURE', errorCode: ERROR_CODES.INTERNAL_ERROR }),
      ),
    ).toThrow(/SUCCESS/);
  });

  it('requires a non-empty reason', () => {
    expect(() => auditTrailPayloadSchemaV1.parse(baseCorrection({ reason: undefined }))).toThrow(
      /reason/,
    );
  });

  it('requires a human USER actor — rejects SERVICE', () => {
    expect(() =>
      auditTrailPayloadSchemaV1.parse(
        baseCorrection({ actor: { type: 'SERVICE', id: 'audit-service', roles: [] } }),
      ),
    ).toThrow(/USER/);
  });

  it('requires a human USER actor — rejects SYSTEM', () => {
    expect(() =>
      auditTrailPayloadSchemaV1.parse(
        baseCorrection({ actor: { type: 'SYSTEM', id: 'audit-service', roles: [] } }),
      ),
    ).toThrow(/USER/);
  });

  it('reports all four violations together rather than stopping at the first', () => {
    const result = auditTrailPayloadSchemaV1.safeParse(
      baseCorrection({
        action: 'asset.decommission',
        outcome: 'FAILURE',
        errorCode: ERROR_CODES.INTERNAL_ERROR,
        reason: undefined,
        actor: { type: 'SERVICE', id: 'audit-service', roles: [] },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['action', 'outcome', 'reason', 'actor.type']));
    }
  });
});

// ---------------------------------------------------------------------------
// Rejects undeclared keys — the payload itself
// ---------------------------------------------------------------------------

describe('undeclared keys', () => {
  it('rejects an unknown top-level key rather than dropping it silently', () => {
    expect(() =>
      auditTrailPayloadSchemaV1.parse({ ...baseRefusal(), rawPayloadDump: { anything: 'goes' } }),
    ).toThrow();
  });

  it('rejects an unknown key inside source', () => {
    expect(() =>
      auditTrailPayloadSchemaV1.parse(
        baseRefusal({ source: { ip: '1.1.1.1', extra: 'nope' } as never }),
      ),
    ).toThrow();
  });

  it('rejects an unknown key inside actor', () => {
    expect(() =>
      auditTrailPayloadSchemaV1.parse(
        baseRefusal({ actor: { ...validActor, extra: 'nope' } as never }),
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Contract-envelope test — the standard envelope, not a second transport
// ---------------------------------------------------------------------------

describe('on the standard envelope (ADR-053 § 1 — no second envelope)', () => {
  const envelope = {
    eventId: '01J000000000000000000000AA',
    eventName: AUDIT_EVENT_RECORDED,
    eventVersion: AUDIT_EVENT_RECORDED_VERSION,
    occurredAt: '2026-09-11T10:00:00.000Z',
    producer: 'identity-service',
    producerVersion: '1.0.0',
    aggregateType: 'AuditEvent',
    aggregateId: 'AUD_01J000000000000000000009',
    correlationId: 'COR_1',
    tenantId: 'ORG_01J000000000000000000001',
    payload: baseRefusal(),
  };

  it('parses via parseEnvelope on AUDIT_TRAIL_TOPIC', () => {
    const parsed = parseEnvelope(envelope, auditTrailPayloadSchemaV1);
    expect(parsed.eventName).toBe(AUDIT_EVENT_RECORDED);
    expect(parsed.payload.outcome).toBe('REFUSED');
  });

  it('AUDIT_TRAIL_TOPIC is still exactly rasta.audit.trail.v1', () => {
    expect(AUDIT_TRAIL_TOPIC).toBe('rasta.audit.trail.v1');
  });

  it('rejects an envelope whose payload fails this schema, even if the envelope itself is well-formed', () => {
    expect(() =>
      parseEnvelope(
        { ...envelope, payload: { ...baseRefusal(), action: 'NOT_A_DOTTED_VERB' } },
        auditTrailPayloadSchemaV1,
      ),
    ).toThrow();
  });
});
