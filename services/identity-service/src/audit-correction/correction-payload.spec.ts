import {
  AUDIT_CORRECTION_ACTION,
  auditTrailPayloadSchemaV1,
  type AuditChange,
} from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import {
  buildCorrectionPayload,
  isSensitiveField,
  redactChanges,
  safeSource,
  type CorrectionPayloadInput,
} from './correction-payload';

/**
 * The correction payload, field by field (AUD-003 correction): every value traced to the
 * one place it may come from, sensitive values never carried raw, and the
 * result valid against the exact schema audit-service consumes.
 */

const TARGET_ID = '01JAUDIT0000000000000001';

const input = (overrides: Partial<CorrectionPayloadInput> = {}): CorrectionPayloadInput => ({
  actorId: 'USR-PLATFORM-ADMIN',
  actorRoles: ['SYSTEM_ADMIN'],
  target: { id: TARGET_ID, organizationId: 'ORG-DEH-0001' },
  reason: 'Recorded as SUCCESS; the operation actually failed',
  changes: [{ field: 'outcome', from: 'SUCCESS', to: 'FAILURE' }],
  source: { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (correction unit)' },
  ...overrides,
});

describe('isSensitiveField', () => {
  it.each([
    ['password', true],
    ['Password', true],
    ['credentials.password', true],
    ['profile.TOKEN', true],
    ['outcome', false],
    ['profile.status', false],
    ['passwordless_hint', false],
  ])('%s → %s', (field, expected) => {
    expect(isSensitiveField(field)).toBe(expected);
  });
});

describe('redactChanges', () => {
  it('replaces every value of a sensitive field — scalar or hash — with the redaction marker', () => {
    const changes: AuditChange[] = [
      { field: 'password', from: 'old-secret', to: 'new-secret' },
      { field: 'credentials.token', from: { hash: 'sha256:abc' }, to: 42 },
    ];

    expect(redactChanges(changes)).toEqual([
      { field: 'password', from: { redacted: true }, to: { redacted: true } },
      { field: 'credentials.token', from: { redacted: true }, to: { redacted: true } },
    ]);
    expect(JSON.stringify(redactChanges(changes))).not.toMatch(/old-secret|new-secret|abc|42/);
  });

  it('keeps null on a sensitive field, which discloses nothing', () => {
    expect(redactChanges([{ field: 'password', from: null, to: 'set' }])).toEqual([
      { field: 'password', from: null, to: { redacted: true } },
    ]);
  });

  it('leaves a non-sensitive field exactly as declared, and never mutates its input', () => {
    const changes: AuditChange[] = [{ field: 'outcome', from: 'SUCCESS', to: 'FAILURE' }];
    const copy = structuredClone(changes);

    expect(redactChanges(changes)).toEqual(copy);
    expect(changes).toEqual(copy);
  });
});

describe('safeSource', () => {
  it('keeps a literal address and a clean user agent', () => {
    expect(safeSource({ ip: '2001:db8::7', userAgent: 'agent/1.0' })).toEqual({
      ip: '2001:db8::7',
      userAgent: 'agent/1.0',
    });
  });

  it.each([
    ['a hostname', { ip: 'proxy.internal' }],
    ['a header-injected list', { ip: '1.2.3.4, 5.6.7.8' }],
    ['a user agent with a control character', { userAgent: `agent${String.fromCharCode(0)}/1` }],
    ['a user agent over 512 characters (dropped, never truncated)', { userAgent: 'a'.repeat(513) }],
    ['a blank user agent', { userAgent: '   ' }],
    ['nothing', {}],
  ])('drops %s', (_label, source) => {
    expect(safeSource(source)).toBeUndefined();
  });

  it('keeps a user agent of exactly 512 characters as it was sent', () => {
    expect(safeSource({ userAgent: 'a'.repeat(512) })?.userAgent).toHaveLength(512);
  });
});

describe('buildCorrectionPayload', () => {
  it('builds exactly the ADR-053 § 7 record for a tenant target', () => {
    expect(buildCorrectionPayload(input())).toEqual({
      actor: { type: 'USER', id: 'USR-PLATFORM-ADMIN', roles: ['SYSTEM_ADMIN'] },
      organizationId: 'ORG-DEH-0001',
      action: AUDIT_CORRECTION_ACTION,
      resourceType: 'AuditEvent',
      resourceId: TARGET_ID,
      outcome: 'SUCCESS',
      reason: 'Recorded as SUCCESS; the operation actually failed',
      changes: [{ field: 'outcome', from: 'SUCCESS', to: 'FAILURE' }],
      occurrenceCount: 1,
      source: { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (correction unit)' },
      correctionOf: TARGET_ID,
    });
  });

  it('carries no organization at all for a genuinely platform-scoped target', () => {
    const payload = buildCorrectionPayload(
      input({ target: { id: TARGET_ID, organizationId: null } }),
    );

    expect(payload).not.toHaveProperty('organizationId');
    expect(payload.correctionOf).toBe(TARGET_ID);
  });

  it('has no errorCode, and is valid against the schema audit-service consumes', () => {
    const payload = buildCorrectionPayload(input());

    expect(payload).not.toHaveProperty('errorCode');
    expect(auditTrailPayloadSchemaV1.parse(payload)).toEqual(payload);
  });

  it('redacts a sensitive change before it is ever built into the payload', () => {
    const payload = buildCorrectionPayload(
      input({ changes: [{ field: 'credentials.password', from: 'hunter2', to: 'hunter3' }] }),
    );

    expect(payload.changes).toEqual([
      { field: 'credentials.password', from: { redacted: true }, to: { redacted: true } },
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/hunter/);
  });

  it('deduplicates the actor roles and omits an unsafe source', () => {
    const payload = buildCorrectionPayload(
      input({ actorRoles: ['SYSTEM_ADMIN', 'SYSTEM_ADMIN'], source: { ip: 'not-an-ip' } }),
    );

    expect(payload.actor.roles).toEqual(['SYSTEM_ADMIN']);
    expect(payload).not.toHaveProperty('source');
  });

  it('fails without quoting the value it refused', () => {
    const oversized = 'U'.repeat(300);
    let thrown: unknown;
    try {
      buildCorrectionPayload(input({ actorId: oversized }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RastaError);
    expect((thrown as RastaError).code).toBe('INTERNAL_ERROR');
    expect((thrown as RastaError).message).not.toContain(oversized);
  });

  it('refuses more roles than the contract allows rather than truncating the list', () => {
    expect(() =>
      buildCorrectionPayload(input({ actorRoles: Array.from({ length: 65 }, (_, i) => `R${i}`) })),
    ).toThrow(RastaError);
  });
});
