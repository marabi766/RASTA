import {
  isCheckViolation,
  isLockTimeout,
  isTransactionUnavailable,
  isUniqueViolation,
  sqlStateOf,
  violatedConstraint,
} from './prisma-errors';

/**
 * Driver error shapes, as predicates.
 *
 * These decide which platform error a caller gets: a key that already applied a movement is a
 * `409 IDEMPOTENCY_KEY_REUSED`, a stock item another command holds is a `409 CONFLICT` with
 * Retry-After, and anything unrecognised must fall through rather than be swallowed as one of
 * those. A predicate that answered `true` too eagerly would turn a genuine bug into a
 * tidy-looking refusal.
 */

/** What Prisma throws when a raw query fails: P2010, the SQLSTATE in `meta.code`. */
const raw = (code: string, message = `Code: \`${code}\`. Message: \`refused\``) => ({
  code: 'P2010',
  meta: { code, message },
  message: `Raw query failed. ${message}`,
});

describe('unique violations', () => {
  it('recognises P2002 and a raw 23505', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
    expect(isUniqueViolation(raw('23505'))).toBe(true);
  });

  it.each([{ code: 'P2003' }, { code: '' }, {}, null, undefined, 'P2002', new Error('P2002')])(
    'does not recognise %p',
    (value) => {
      expect(isUniqueViolation(value)).toBe(false);
    },
  );

  it('does not take another raw failure for one', () => {
    expect(isUniqueViolation(raw('23514'))).toBe(false);
  });
});

describe('check violations', () => {
  it('recognises a raw 23514 and a driver message naming a check constraint', () => {
    expect(isCheckViolation(raw('23514'))).toBe(true);
    expect(
      isCheckViolation(new Error('new row violates check constraint "ck_stock_item_reserved"')),
    ).toBe(true);
  });

  it('does not recognise an unrelated error', () => {
    expect(isCheckViolation(new Error('connection terminated'))).toBe(false);
    expect(isCheckViolation(raw('23505'))).toBe(false);
    expect(isCheckViolation(null)).toBe(false);
  });
});

describe('lock timeouts', () => {
  it('recognises a raw 55P03 and the server’s message', () => {
    expect(isLockTimeout(raw('55P03'))).toBe(true);
    expect(isLockTimeout(new Error('canceling statement due to lock timeout'))).toBe(true);
  });

  it('does not recognise anything else', () => {
    expect(isLockTimeout(raw('40P01'))).toBe(false);
    expect(isLockTimeout(undefined)).toBe(false);
  });
});

describe('a transaction Prisma could not give in time', () => {
  it('is P2028 (no transaction within maxWait, or past its timeout) and P2024 (no connection)', () => {
    expect(isTransactionUnavailable({ code: 'P2028', message: 'Transaction API error' })).toBe(
      true,
    );
    expect(isTransactionUnavailable({ code: 'P2024', message: 'Timed out fetching' })).toBe(true);
  });

  it('is nothing else', () => {
    expect(isTransactionUnavailable(raw('55P03'))).toBe(false);
    expect(isTransactionUnavailable({ code: 'P2002' })).toBe(false);
    expect(isTransactionUnavailable(new Error('P2028'))).toBe(false);
    expect(isTransactionUnavailable(null)).toBe(false);
  });
});

describe('reading the SQLSTATE', () => {
  it('reads meta.code, then the message, and invents nothing', () => {
    expect(sqlStateOf(raw('22003'))).toBe('22003');
    expect(sqlStateOf({ message: 'Error occurred: Code: `40P01`. Message: `deadlock`' })).toBe(
      '40P01',
    );
    expect(sqlStateOf({ meta: { code: 'not-a-state' } })).toBeUndefined();
    expect(sqlStateOf(new Error('no state here'))).toBeUndefined();
    expect(sqlStateOf('23505')).toBeUndefined();
  });
});

describe('naming the constraint', () => {
  it('reads a single target', () => {
    expect(violatedConstraint({ meta: { target: 'ux_stock_movement_command' } })).toBe(
      'ux_stock_movement_command',
    );
  });

  it('joins a composite target', () => {
    expect(violatedConstraint({ meta: { target: ['organization_id', 'stock_item_id'] } })).toBe(
      'organization_id,stock_item_id',
    );
  });

  it('reads the constraint a raw failure names', () => {
    expect(
      violatedConstraint(
        raw('23505', 'duplicate key value violates unique constraint "ux_stock_movement_command"'),
      ),
    ).toBe('ux_stock_movement_command');
  });

  it('returns undefined when the driver reports none', () => {
    expect(violatedConstraint({ code: 'P2002' })).toBeUndefined();
    expect(violatedConstraint(null)).toBeUndefined();
  });
});
