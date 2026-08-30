import { isCheckViolation, isUniqueViolation, violatedConstraint } from './prisma-errors';

/**
 * The driver-error predicates.
 *
 * These decide which platform error a caller gets, and the two cases are not
 * interchangeable: a duplicate idempotency key is a **replay** and a duplicate
 * open dispute is a **business rule**. Getting the predicate wrong turns one
 * into the other, which is why they are functions with tests rather than
 * `error.code === 'P2002'` written at six call sites.
 *
 * Every input below is the shape Prisma actually produces — a `code` on the
 * error object, and `meta.target` naming the constraint — rather than a
 * convenient invention.
 */

describe('isUniqueViolation', () => {
  it('recognises P2002, which is the only code that means a duplicate', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
  });

  it('does not treat another Prisma error as one', () => {
    // P2025 is "record not found". Reading it as a duplicate would turn a
    // missing row into an "already exists".
    for (const code of ['P2025', 'P2003', 'P2010', 'P1001']) {
      expect(isUniqueViolation({ code })).toBe(false);
    }
  });

  it('is safe on the values a catch block can actually receive', () => {
    // A `catch` binds `unknown`. Any of these reaching a `.code` access would
    // throw inside the error handler, replacing a useful refusal with a crash.
    for (const value of [null, undefined, 'P2002', 42, [], new Error('P2002')]) {
      expect(isUniqueViolation(value)).toBe(false);
    }
  });
});

describe('isCheckViolation', () => {
  it('recognises the message PostgreSQL produces for a refused CHECK', () => {
    // Prisma surfaces a CHECK failure as an unknown request error whose message
    // carries the constraint name — there is no dedicated code for it, which is
    // exactly why this predicate exists rather than a code comparison.
    expect(
      isCheckViolation({
        message: 'new row for relation "order" violates check constraint "ck_order_total_positive"',
      }),
    ).toBe(true);
  });

  it('recognises the two Prisma codes that stand in for one', () => {
    expect(isCheckViolation({ code: 'P2010' })).toBe(true);
    expect(isCheckViolation({ code: 'P2000' })).toBe(true);
  });

  it('does not treat an unrelated failure as a refused constraint', () => {
    expect(isCheckViolation({ code: 'P2002', message: 'Unique constraint failed' })).toBe(false);
    expect(isCheckViolation({ message: 'connection terminated unexpectedly' })).toBe(false);
  });

  it('is safe on the values a catch block can actually receive', () => {
    for (const value of [null, undefined, 'violates check constraint', 7]) {
      expect(isCheckViolation(value)).toBe(false);
    }
  });
});

describe('violatedConstraint', () => {
  it('names a single-column constraint', () => {
    expect(violatedConstraint({ meta: { target: 'economic_transaction_id' } })).toBe(
      'economic_transaction_id',
    );
  });

  it('joins a composite one, so the caller sees the whole key', () => {
    // Prisma reports a composite unique as an array. Returning only the first
    // column would name the wrong constraint on
    // `(organization_id, endpoint, key)`.
    expect(violatedConstraint({ meta: { target: ['organization_id', 'endpoint', 'key'] } })).toBe(
      'organization_id,endpoint,key',
    );
  });

  it('returns undefined when the driver did not say', () => {
    // Some failures carry no target at all. Inventing a name would put a
    // constraint that does not exist into a log an operator reads.
    expect(violatedConstraint({ meta: {} })).toBeUndefined();
    expect(violatedConstraint({})).toBeUndefined();
    expect(violatedConstraint(null)).toBeUndefined();
    expect(violatedConstraint({ meta: { target: 42 } })).toBeUndefined();
  });
});
