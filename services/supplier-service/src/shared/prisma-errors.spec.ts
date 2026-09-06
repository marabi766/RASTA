import { isCheckViolation, isUniqueViolation, violatedConstraint } from './prisma-errors';

/**
 * Driver error shapes, as predicates.
 *
 * These decide which platform error a caller gets: a duplicate organization is
 * a `409 ALREADY_EXISTS`, a duplicate open qualification is a
 * `422 BUSINESS_RULE_VIOLATION`, and anything unrecognised must fall through
 * rather than be swallowed as one of those. A predicate that answered `true` too
 * eagerly would turn a genuine bug into a tidy-looking business refusal.
 */

describe('unique violations', () => {
  it('recognises P2002', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
  });

  it.each([{ code: 'P2003' }, { code: '' }, {}, null, undefined, 'P2002', new Error('P2002')])(
    'does not recognise %p',
    (value) => {
      // A message that merely mentions P2002 is not a unique violation. Treating
      // one as such would report an unrelated failure as "already exists".
      expect(isUniqueViolation(value)).toBe(false);
    },
  );
});

describe('check violations', () => {
  it('recognises a driver message naming a check constraint', () => {
    expect(
      isCheckViolation(new Error('new row violates check constraint "ck_qualification_..."')),
    ).toBe(true);
  });

  it('does not recognise an unrelated error', () => {
    expect(isCheckViolation(new Error('connection terminated'))).toBe(false);
    expect(isCheckViolation(null)).toBe(false);
  });
});

describe('naming the constraint', () => {
  it('reads a single target', () => {
    expect(violatedConstraint({ meta: { target: 'supplier_organization_id_key' } })).toBe(
      'supplier_organization_id_key',
    );
  });

  it('joins a composite target', () => {
    expect(violatedConstraint({ meta: { target: ['supplier_id', 'capability'] } })).toBe(
      'supplier_id,capability',
    );
  });

  it('returns undefined when the driver reports none', () => {
    // Undefined rather than a guess: an error handler that invented a
    // constraint name would send somebody to look at the wrong index.
    expect(violatedConstraint({ code: 'P2002' })).toBeUndefined();
    expect(violatedConstraint(null)).toBeUndefined();
  });
});
