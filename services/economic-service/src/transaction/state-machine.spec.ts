import {
  attractsCommission,
  canTransition,
  isTerminal,
  nextStatus,
  TERMINAL_STATUSES,
  type TransactionEvent,
} from './state-machine';
import type { TransactionStatus } from '../generated/prisma';

/**
 * The transaction lifecycle.
 *
 * Two of these are product-document controls rather than ordinary state
 * checks, and they are asserted from both directions — that the legal move
 * works, and that the illegal one is impossible:
 *
 *   **A dispute stops settlement completely** (docs/10 § 10.5). There is no
 *   edge from DISPUTED to SETTLED, and no timeout that creates one.
 *
 *   **Settlement requires prior authorisation** (docs/10 § 10.12: "تسویه بدون
 *   ORDER_RECEIPT_CONFIRMED غیرممکن است"). SETTLE is reachable only from
 *   PENDING_SETTLEMENT.
 */

const ALL_STATUSES: TransactionStatus[] = [
  'CREATED',
  'HELD',
  'PENDING_SETTLEMENT',
  'DISPUTED',
  'SETTLED',
  'REFUNDED',
  'CANCELLED',
  'FAILED',
];

const ALL_EVENTS: TransactionEvent[] = [
  'HOLD_PLACED',
  'AUTHORISE_SETTLEMENT',
  'SETTLE',
  'REFUND',
  'CANCEL',
  'FAIL',
  'DISPUTE',
  'RESOLVE_DISPUTE',
];

describe('the happy path', () => {
  it('walks an order from creation to settlement', () => {
    expect(nextStatus('TXN_1', 'CREATED', 'HOLD_PLACED')).toBe('HELD');
    expect(nextStatus('TXN_1', 'HELD', 'AUTHORISE_SETTLEMENT')).toBe('PENDING_SETTLEMENT');
    expect(nextStatus('TXN_1', 'PENDING_SETTLEMENT', 'SETTLE')).toBe('SETTLED');
  });

  it('lets an approved obligation reach settlement without ever being held', () => {
    // ADR-032: a MAINTENANCE_APPROVED obligation has no escrow behind it — the
    // work is done and the amount is owed. Refusing to record it because a
    // wallet is empty would lose a person's approval.
    expect(nextStatus('TXN_1', 'CREATED', 'AUTHORISE_SETTLEMENT')).toBe('PENDING_SETTLEMENT');
  });

  it('returns held funds on cancellation', () => {
    expect(nextStatus('TXN_1', 'HELD', 'REFUND')).toBe('REFUNDED');
  });
});

describe('a dispute stops settlement completely', () => {
  it('refuses to settle a disputed transaction', () => {
    // The product document control. Not a policy the service applies — an edge
    // that does not exist.
    expect(() => nextStatus('TXN_1', 'DISPUTED', 'SETTLE')).toThrow(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }),
    );
  });

  it('offers no automatic route out of DISPUTED', () => {
    // Only an explicit human decision (RESOLVE_DISPUTE) or a refund.
    const escapes = ALL_EVENTS.filter((event) => canTransition('DISPUTED', event));
    expect(escapes.sort()).toEqual(['REFUND', 'RESOLVE_DISPUTE']);
  });

  it('returns a resolved dispute to the queue rather than settling it', () => {
    // Unblocking and paying stay two acts.
    expect(nextStatus('TXN_1', 'DISPUTED', 'RESOLVE_DISPUTE')).toBe('PENDING_SETTLEMENT');
  });

  it('can be raised from HELD and from PENDING_SETTLEMENT', () => {
    expect(nextStatus('TXN_1', 'HELD', 'DISPUTE')).toBe('DISPUTED');
    expect(nextStatus('TXN_1', 'PENDING_SETTLEMENT', 'DISPUTE')).toBe('DISPUTED');
  });
});

describe('settlement requires authorisation', () => {
  it.each<TransactionStatus>([
    'CREATED',
    'HELD',
    'DISPUTED',
    'SETTLED',
    'REFUNDED',
    'CANCELLED',
    'FAILED',
  ])('refuses to settle from %s', (status) => {
    expect(canTransition(status, 'SETTLE')).toBe(false);
  });

  it('permits settlement only from PENDING_SETTLEMENT', () => {
    expect(canTransition('PENDING_SETTLEMENT', 'SETTLE')).toBe(true);
  });
});

describe('terminal states', () => {
  it.each(TERMINAL_STATUSES)('%s admits no further move', (status) => {
    expect(isTerminal(status)).toBe(true);
    for (const event of ALL_EVENTS) {
      expect(canTransition(status, event)).toBe(false);
    }
  });

  it('treats every non-terminal state as live', () => {
    for (const status of ALL_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s))) {
      expect(isTerminal(status)).toBe(false);
    }
  });

  it('refuses to settle an already-settled transaction', () => {
    // The double-settlement guard, at the domain layer. The row lock and the
    // compare-and-set update are the other two.
    expect(() => nextStatus('TXN_1', 'SETTLED', 'SETTLE')).toThrow(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }),
    );
  });
});

describe('refusals', () => {
  it('names the state and what was attempted', () => {
    // "cannot settle a DISPUTED transaction" tells an operator what happened;
    // "settlement requires prior authorisation" does not.
    expect(() => nextStatus('TXN_1', 'DISPUTED', 'SETTLE')).toThrow(
      /A DISPUTED transaction cannot be settled/,
    );
  });

  it('keeps the transaction id out of the message and in the context', () => {
    try {
      nextStatus('TXN_SECRET', 'SETTLED', 'SETTLE');
      throw new Error('expected a refusal');
    } catch (error) {
      const thrown = error as { message: string; internalContext?: Record<string, unknown> };
      expect(thrown.message).not.toContain('TXN_SECRET');
      expect(thrown.internalContext).toMatchObject({ transactionId: 'TXN_SECRET' });
    }
  });

  it('refuses every move that is not in the table, by default', () => {
    // The reason the machine is a table rather than a chain of `if`s: an
    // unanticipated move is refused, not permitted by falling through.
    const legal = new Set<string>();
    for (const status of ALL_STATUSES) {
      for (const event of ALL_EVENTS) {
        if (canTransition(status, event)) legal.add(`${status}:${event}`);
      }
    }

    // Exactly the moves documented in the class comment, and no others.
    expect([...legal].sort()).toEqual([
      'CREATED:AUTHORISE_SETTLEMENT',
      'CREATED:CANCEL',
      'CREATED:FAIL',
      'CREATED:HOLD_PLACED',
      'DISPUTED:REFUND',
      'DISPUTED:RESOLVE_DISPUTE',
      'HELD:AUTHORISE_SETTLEMENT',
      'HELD:DISPUTE',
      'HELD:REFUND',
      'PENDING_SETTLEMENT:DISPUTE',
      'PENDING_SETTLEMENT:REFUND',
      'PENDING_SETTLEMENT:SETTLE',
    ]);
  });
});

describe('attractsCommission', () => {
  it('never charges commission on money entering a wallet', () => {
    // A top-up is not a service the platform brokered, and charging a rate on
    // it would invent a fee the product document does not describe.
    expect(attractsCommission('WALLET_TOP_UP')).toBe(false);
  });

  it.each([
    'MARKETPLACE_ORDER',
    'MAINTENANCE_SERVICE',
    'LOGISTICS',
    'CONSTRUCTION_STATEMENT',
    'PROCUREMENT_ORDER',
  ])('treats %s as eligible — the rule decides whether anything is charged', (type) => {
    expect(attractsCommission(type)).toBe(true);
  });
});
