import { isCheckViolation, isUniqueViolation, violatedConstraint } from './prisma-errors';

/**
 * Which driver failure this service is looking at.
 *
 * These predicates decide which platform error a caller gets, so a false
 * positive here turns a genuine bug into a business-rule message the client
 * cannot act on, and a false negative turns an expected collision into a 500.
 * Both are worth pinning, and neither needs a database.
 */

describe('recognising a unique violation', () => {
  it('recognises the driver code', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
  });

  it('does not mistake another driver code for one', () => {
    expect(isUniqueViolation({ code: 'P2025' })).toBe(false);
  });

  it('is not confused by something that is not an error object', () => {
    for (const value of [null, undefined, 'P2002', 42]) {
      expect(isUniqueViolation(value)).toBe(false);
    }
  });
});

describe('recognising a CHECK violation', () => {
  it('recognises the raw-query codes the driver uses', () => {
    // A CHECK failure surfaces differently depending on whether it came
    // through the query builder or a raw statement.
    expect(isCheckViolation({ code: 'P2010' })).toBe(true);
    expect(isCheckViolation({ code: 'P2000' })).toBe(true);
  });

  it('falls back to what PostgreSQL actually said', () => {
    expect(
      isCheckViolation({
        code: 'P2034',
        message: 'new row violates check constraint "ck_document_size_positive"',
      }),
    ).toBe(true);
  });

  it('does not treat an unrelated failure as one', () => {
    expect(isCheckViolation({ code: 'P2025', message: 'Record to update not found' })).toBe(false);
  });

  it('is not confused by a non-object', () => {
    expect(isCheckViolation(null)).toBe(false);
    expect(isCheckViolation('violates check constraint')).toBe(false);
  });
});

describe('naming the constraint that refused the row', () => {
  it('reads a single target', () => {
    expect(violatedConstraint({ meta: { target: 'upload_intent_pkey' } })).toBe(
      'upload_intent_pkey',
    );
  });

  it('joins a composite target', () => {
    expect(violatedConstraint({ meta: { target: ['organization_id', 'object_key'] } })).toBe(
      'organization_id,object_key',
    );
  });

  it('returns nothing when the driver names none', () => {
    // Better than inventing a name: a caller that logged a guess would send
    // the next reader looking for a constraint that does not exist.
    expect(violatedConstraint({ meta: {} })).toBeUndefined();
    expect(violatedConstraint({})).toBeUndefined();
    expect(violatedConstraint(null)).toBeUndefined();
  });
});
