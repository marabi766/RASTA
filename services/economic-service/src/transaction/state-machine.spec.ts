import {
  assertSettlementReady,
  attractsCommission,
  canTransition,
  isTerminal,
  nextStatus,
  resolvedStatus,
  reversedStatus,
  TERMINAL_STATUSES,
  type TransactionEvent,
} from './state-machine';
import { RastaError } from '@rasta/nest-common';
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
  'PARTIALLY_REVERSED',
  'REVERSED',
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
  'REVERSE_SETTLEMENT',
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
    expect(
      nextStatus('TXN_1', 'DISPUTED', 'RESOLVE_DISPUTE', {
        settlementAuthorised: true,
        fundsHeld: true,
      }),
    ).toBe('PENDING_SETTLEMENT');
  });

  describe('a resolution never authorises (D-083, marketplace audit F1)', () => {
    it('returns an escrowed transaction never authorised to HELD, not to the settlement queue', () => {
      expect(
        nextStatus('TXN_1', 'DISPUTED', 'RESOLVE_DISPUTE', {
          settlementAuthorised: false,
          fundsHeld: true,
        }),
      ).toBe('HELD');
    });

    it('returns an authorised transaction to PENDING_SETTLEMENT, held or not', () => {
      for (const fundsHeld of [true, false]) {
        expect(resolvedStatus({ settlementAuthorised: true, fundsHeld })).toBe(
          'PENDING_SETTLEMENT',
        );
      }
    });

    it('returns an obligation with no escrow to PENDING_SETTLEMENT: it was authorised when recorded', () => {
      expect(resolvedStatus({ settlementAuthorised: false, fundsHeld: false })).toBe(
        'PENDING_SETTLEMENT',
      );
    });

    it('refuses to guess a resolution without the authority it depends on', () => {
      expect(() => nextStatus('TXN_1', 'DISPUTED', 'RESOLVE_DISPUTE')).toThrow(
        /needs its settlement authority/,
      );
    });

    it('reads no authority for any other move', () => {
      expect(nextStatus('TXN_1', 'DISPUTED', 'REFUND')).toBe('REFUNDED');
    });
  });

  it('can be raised from HELD and from PENDING_SETTLEMENT', () => {
    expect(nextStatus('TXN_1', 'HELD', 'DISPUTE')).toBe('DISPUTED');
    expect(nextStatus('TXN_1', 'PENDING_SETTLEMENT', 'DISPUTE')).toBe('DISPUTED');
  });
});

describe('settlement checks its authority, not only its status (D-083, #623 r1 F1)', () => {
  it('refuses an escrowed transaction with no recorded authorisation — the legacy PENDING_SETTLEMENT row', () => {
    try {
      assertSettlementReady('TXN_1', {
        settlementAuthorised: false,
        fundsHeld: true,
        holdDecisionUnresolved: false,
      });
      throw new Error('settled without authority');
    } catch (error) {
      expect(error).toBeInstanceOf(RastaError);
      expect((error as RastaError).code).toBe('INVALID_STATE_TRANSITION');
    }
  });

  it('lets an authorised transaction, or one with nothing held, settle', () => {
    for (const authority of [
      { settlementAuthorised: true, fundsHeld: true },
      { settlementAuthorised: true, fundsHeld: false },
      { settlementAuthorised: false, fundsHeld: false },
    ]) {
      expect(() =>
        assertSettlementReady('TXN_1', { ...authority, holdDecisionUnresolved: false }),
      ).not.toThrow();
    }
  });

  // FU-138: nothing held would otherwise say ready, and debit the payer's spendable balance.
  it.each([
    [{ settlementAuthorised: false, fundsHeld: false }],
    [{ settlementAuthorised: false, fundsHeld: true }],
    [{ settlementAuthorised: true, fundsHeld: false }],
    [{ settlementAuthorised: true, fundsHeld: true }],
  ])('refuses %j while its hold decision is unresolved, or not known', (authority) => {
    for (const holdDecisionUnresolved of [true, undefined]) {
      expect(() =>
        assertSettlementReady('TXN_1', { ...authority, holdDecisionUnresolved } as never),
      ).toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
    }
  });

  it('agrees with where a resolution sends it: settlement-ready exactly when settleable', () => {
    for (const settlementAuthorised of [true, false]) {
      for (const fundsHeld of [true, false]) {
        const authority = { settlementAuthorised, fundsHeld };
        const settleable = (() => {
          try {
            assertSettlementReady('TXN_1', { ...authority, holdDecisionUnresolved: false });
            return true;
          } catch {
            return false;
          }
        })();
        expect(resolvedStatus(authority) === 'PENDING_SETTLEMENT').toBe(settleable);
      }
    }
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

describe('a settlement is undone only by a reversal, as far as money moved (docs/24 Q-76, D-115 A)', () => {
  const progress = (reversedGrossMinor: bigint) => ({
    settlementGrossMinor: 1_000n,
    reversedGrossMinor,
  });

  it('leaves SETTLED by no other event', () => {
    const exits = ALL_EVENTS.filter((event) => canTransition('SETTLED', event));
    expect(exits).toEqual(['REVERSE_SETTLEMENT']);
  });

  it.each(['SETTLED', 'PARTIALLY_REVERSED'] as const)(
    'goes from %s as far as the applied reversals say',
    (from) => {
      expect(nextStatus('TXN_1', from, 'REVERSE_SETTLEMENT', progress(1n))).toBe(
        'PARTIALLY_REVERSED',
      );
      expect(nextStatus('TXN_1', from, 'REVERSE_SETTLEMENT', progress(999n))).toBe(
        'PARTIALLY_REVERSED',
      );
      expect(nextStatus('TXN_1', from, 'REVERSE_SETTLEMENT', progress(1_000n))).toBe('REVERSED');
    },
  );

  it('leaves PARTIALLY_REVERSED by no other event, and REVERSED by none at all', () => {
    expect(ALL_EVENTS.filter((event) => canTransition('PARTIALLY_REVERSED', event))).toEqual([
      'REVERSE_SETTLEMENT',
    ]);
    expect(isTerminal('REVERSED')).toBe(true);
    expect(() => nextStatus('TXN_1', 'REVERSED', 'REVERSE_SETTLEMENT', progress(1_000n))).toThrow(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }),
    );
  });

  it.each([0n, -1n, 1_001n])('refuses a reversed total of %s rather than round it', (total) => {
    expect(() => reversedStatus(progress(total))).toThrow(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }),
    );
    expect(() => nextStatus('TXN_1', 'SETTLED', 'REVERSE_SETTLEMENT', progress(total))).toThrow(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }),
    );
  });

  it('decides exactly above what a number can hold', () => {
    const big = 2n ** 62n;
    expect(reversedStatus({ settlementGrossMinor: big + 1n, reversedGrossMinor: big })).toBe(
      'PARTIALLY_REVERSED',
    );
  });

  it('refuses to guess without the facts, or with the wrong ones', () => {
    expect(() => nextStatus('TXN_1', 'SETTLED', 'REVERSE_SETTLEMENT')).toThrow(
      'needs its progress',
    );
    expect(() =>
      nextStatus('TXN_1', 'SETTLED', 'REVERSE_SETTLEMENT', {
        settlementAuthorised: true,
        fundsHeld: false,
      }),
    ).toThrow('needs its progress');
    expect(() => nextStatus('TXN_1', 'DISPUTED', 'RESOLVE_DISPUTE', progress(1n))).toThrow(
      'needs its settlement authority',
    );
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
      'PARTIALLY_REVERSED:REVERSE_SETTLEMENT',
      'PENDING_SETTLEMENT:DISPUTE',
      'PENDING_SETTLEMENT:REFUND',
      'PENDING_SETTLEMENT:SETTLE',
      'SETTLED:REVERSE_SETTLEMENT',
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

describe('the refusal message', () => {
  /**
   * Every event, refused from a state that does not allow it.
   *
   * The message is what an operator reads at three in the morning, and it
   * names the act rather than restating the rule: "a SETTLED transaction
   * cannot be settled" tells them what happened; "settlement requires prior
   * authorisation" makes them go and find out which transaction and which
   * state. Each event is exercised here because a missing case in the
   * description switch would produce `undefined` in the middle of that
   * sentence, and nothing else would notice.
   */
  const refusals: [TransactionStatus, TransactionEvent, string][] = [
    ['SETTLED', 'HOLD_PLACED', 'have funds held against it'],
    ['SETTLED', 'AUTHORISE_SETTLEMENT', 'be authorised for settlement'],
    ['CREATED', 'SETTLE', 'be settled'],
    ['CREATED', 'REVERSE_SETTLEMENT', 'have its settlement reversed'],
    ['CREATED', 'REFUND', 'be refunded'],
    ['HELD', 'CANCEL', 'be cancelled'],
    ['HELD', 'FAIL', 'be marked failed'],
    ['CREATED', 'DISPUTE', 'be disputed'],
    ['HELD', 'RESOLVE_DISPUTE', 'have a dispute resolved'],
  ];

  it.each(refusals)('refuses %s + %s and says it cannot %s', (from, event, phrase) => {
    expect(() => nextStatus('TXN_MESSAGE', from, event)).toThrow(
      new RegExp(`A ${from} transaction cannot ${phrase}`),
    );
  });

  it('carries the transaction id for the operator, and the platform error code', () => {
    // The identifier reaches the log through `internalContext`, never the
    // response body: a refusal must not confirm which transactions exist.
    try {
      nextStatus('TXN_CONTEXT', 'DISPUTED', 'SETTLE');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(RastaError);
      const rasta = error as RastaError;
      expect(rasta.code).toBe('INVALID_STATE_TRANSITION');
      expect(rasta.status).toBe(409);
      expect(rasta.internalContext).toEqual({
        transactionId: 'TXN_CONTEXT',
        from: 'DISPUTED',
        event: 'SETTLE',
      });
      expect(rasta.details).toBeUndefined();
    }
  });
});
