import {
  auditCorrectionCommandSchema,
  hashCorrectionCommand,
  type AuditCorrectionCommand,
} from './dto';

/**
 * The correction command at the boundary (AUD-003 correction): what is normalised, what is
 * refused, and that nothing is ever silently truncated or ignored.
 */

const VALID = {
  auditEventId: '01JAUDIT0000000000000001',
  occurredAt: '2026-09-12T10:00:00.000Z',
  reason: 'Recorded as SUCCESS; the operation actually failed',
  changes: [{ field: 'outcome', from: 'SUCCESS', to: 'FAILURE' }],
};

const parse = (body: unknown) => auditCorrectionCommandSchema.safeParse(body);
const accepted = (body: unknown): AuditCorrectionCommand => {
  const result = parse(body);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  return result.data;
};

describe('auditCorrectionCommandSchema', () => {
  it('accepts a minimal valid command', () => {
    expect(accepted(VALID)).toEqual(VALID);
  });

  it('trims the reason and normalises the instant to one ISO form', () => {
    const command = accepted({
      ...VALID,
      reason: '   Recorded under the wrong outcome   ',
      occurredAt: '2026-09-12T13:30:00+03:30',
    });

    expect(command.reason).toBe('Recorded under the wrong outcome');
    expect(command.occurredAt).toBe('2026-09-12T10:00:00.000Z');
  });

  it.each([
    'organizationId',
    'actorId',
    'actor',
    'roles',
    'source',
    'action',
    'outcome',
    'resourceType',
    'correctionOf',
    'tenantId',
  ])('refuses a body that tries to state %s, rather than ignoring it', (key) => {
    expect(parse({ ...VALID, [key]: 'ATTACKER-CHOSEN' }).success).toBe(false);
  });

  it.each([
    ['a blank reason', { reason: '' }],
    ['a whitespace-only reason', { reason: '    ' }],
    ['a reason over 1000 characters (refused, never truncated)', { reason: 'r'.repeat(1001) }],
    ['a missing reason', { reason: undefined }],
    ['no changes', { changes: [] }],
    [
      '51 changes',
      { changes: Array.from({ length: 51 }, (_, i) => ({ field: `f${i}`, from: 1, to: 2 })) },
    ],
    ['a missing instant', { occurredAt: undefined }],
    ['an instant that is not a timestamp', { occurredAt: 'yesterday' }],
    ['a date without a time', { occurredAt: '2026-09-12' }],
    ['a blank target', { auditEventId: '' }],
    ['a target outside the id alphabet', { auditEventId: '../01JAUDIT' }],
    ['a target over 64 characters', { auditEventId: 'A'.repeat(65) }],
  ])('refuses %s', (_label, overrides) => {
    expect(parse({ ...VALID, ...overrides }).success).toBe(false);
  });

  it('accepts exactly 1000 characters of reason and exactly 50 changes', () => {
    expect(parse({ ...VALID, reason: 'r'.repeat(1000) }).success).toBe(true);
    expect(
      parse({
        ...VALID,
        changes: Array.from({ length: 50 }, (_, i) => ({ field: `f${i}`, from: 1, to: 2 })),
      }).success,
    ).toBe(true);
  });

  it.each([
    ['an object', { nested: 'value' }],
    ['an array', ['a', 'b']],
    ['a string over the 2000-character contract bound', 'x'.repeat(2001)],
    ['an unknown marker', { secret: true }],
    ['a marker with a second key', { redacted: true, value: 'x' }],
  ])(
    'refuses %s as a value — large or structured values are never carried as themselves',
    (_label, value) => {
      expect(
        parse({ ...VALID, changes: [{ field: 'outcome', from: 'SUCCESS', to: value }] }).success,
      ).toBe(false);
    },
  );

  it('accepts the documented markers and the scalar kinds', () => {
    expect(
      parse({
        ...VALID,
        changes: [
          { field: 'outcome', from: 'SUCCESS', to: 'FAILURE' },
          { field: 'occurrenceCount', from: 1, to: 2 },
          { field: 'flagged', from: false, to: true },
          { field: 'reason', from: null, to: 'now stated' },
          { field: 'credentials.password', from: { redacted: true }, to: { redacted: true } },
          { field: 'document', from: { hash: 'sha256:aaaa' }, to: { hash: 'sha256:bbbb' } },
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    '__proto__',
    'constructor',
    'prototype',
    'profile.__proto__',
    'profile.constructor.name',
    'a..b',
    '.a',
    'a.',
    '1field',
    'field name',
    'field[0]',
    'field/other',
  ])('refuses the unsafe or non-identifier field %s', (field) => {
    expect(parse({ ...VALID, changes: [{ field, from: 'a', to: 'b' }] }).success).toBe(false);
  });

  it('refuses an extra key on a change entry', () => {
    expect(
      parse({ ...VALID, changes: [{ field: 'outcome', from: 'a', to: 'b', note: 'x' }] }).success,
    ).toBe(false);
  });

  it('refuses the same field twice and a change that changes nothing', () => {
    expect(
      parse({
        ...VALID,
        changes: [
          { field: 'outcome', from: 'SUCCESS', to: 'FAILURE' },
          { field: 'outcome', from: 'FAILURE', to: 'REFUSED' },
        ],
      }).success,
    ).toBe(false);
    expect(
      parse({ ...VALID, changes: [{ field: 'outcome', from: 'SUCCESS', to: 'SUCCESS' }] }).success,
    ).toBe(false);
  });
});

describe('hashCorrectionCommand', () => {
  it('recognises the same request serialised differently as the same request', () => {
    const a = accepted(VALID);
    const b = accepted({
      changes: [{ to: 'FAILURE', from: 'SUCCESS', field: 'outcome' }],
      reason: `  ${VALID.reason}  `,
      occurredAt: '2026-09-12T13:30:00.000+03:30',
      auditEventId: VALID.auditEventId,
    });

    expect(hashCorrectionCommand(a)).toBe(hashCorrectionCommand(b));
    expect(hashCorrectionCommand(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['another reason', { reason: 'A different reason' }],
    ['another target', { auditEventId: '01JAUDIT0000000000000002' }],
    ['another instant', { occurredAt: '2026-09-12T10:00:00.001Z' }],
    ['another change', { changes: [{ field: 'outcome', from: 'SUCCESS', to: 'REFUSED' }] }],
  ])('tells %s apart', (_label, overrides) => {
    expect(hashCorrectionCommand(accepted({ ...VALID, ...overrides }))).not.toBe(
      hashCorrectionCommand(accepted(VALID)),
    );
  });

  it('treats a reordered change list as a different declaration', () => {
    const one = { field: 'outcome', from: 'SUCCESS', to: 'FAILURE' };
    const two = { field: 'reason', from: null, to: 'stated' };
    expect(hashCorrectionCommand(accepted({ ...VALID, changes: [one, two] }))).not.toBe(
      hashCorrectionCommand(accepted({ ...VALID, changes: [two, one] })),
    );
  });
});
