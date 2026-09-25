import { nextValidTo } from './rule-validity';

/**
 * A rule's window only moves forward. Rules are chosen by when an event
 * occurred and read again when it is settled or granted, so a change that
 * reached backwards would re-price work the rule already covered.
 */
describe('nextValidTo', () => {
  const now = new Date('2026-09-24T12:00:00.000Z');
  const inForce = { validFrom: new Date('2026-09-01T00:00:00.000Z'), validTo: null };
  const refused = expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' });

  it('closes a rule in force from now on', () => {
    expect(nextValidTo(inForce, '2026-09-24T12:00:00.000Z', now)).toEqual(now);
    expect(nextValidTo(inForce, '2026-10-01T00:00:00.000Z', now)).toEqual(
      new Date('2026-10-01T00:00:00.000Z'),
    );
  });

  it('refuses a close in the past, which would drop work the rule covered', () => {
    expect(() => nextValidTo(inForce, '2026-09-24T11:59:59.000Z', now)).toThrow(refused);
  });

  it('refuses a close at or before the rule began', () => {
    const scheduled = { validFrom: new Date('2026-10-01T00:00:00.000Z'), validTo: null };
    expect(() => nextValidTo(scheduled, '2026-09-30T00:00:00.000Z', now)).toThrow(refused);
    expect(() => nextValidTo(scheduled, '2026-10-01T00:00:00.000Z', now)).toThrow(refused);
  });

  it('makes a rule still in force indefinite again', () => {
    const closing = { ...inForce, validTo: new Date('2026-10-01T00:00:00.000Z') };
    expect(nextValidTo(closing, null, now)).toBeNull();
  });

  it('refuses to reopen or move a rule that has already ended', () => {
    const ended = { ...inForce, validTo: new Date('2026-09-20T00:00:00.000Z') };
    expect(() => nextValidTo(ended, null, now)).toThrow(refused);
    expect(() => nextValidTo(ended, '2026-12-01T00:00:00.000Z', now)).toThrow(refused);
  });
});
