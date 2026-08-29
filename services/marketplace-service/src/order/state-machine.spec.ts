import { isRastaError } from '@rasta/nest-common';
import {
  ORDER_TRANSITIONS,
  TERMINAL_STATUSES,
  assertTransition,
  canReachSettlement,
  canTransition,
  isTerminal,
} from './state-machine';
import type { OrderStatus } from '../generated/prisma';

/**
 * The order lifecycle (ADR-038).
 *
 * The table is the specification, so this file asserts every edge that exists
 * and — more importantly — the specific edges that must **not** exist. A
 * missing edge is how "a dispute stops settlement" is enforced, and a test
 * that only checked the happy path would not notice one being added.
 */

const ALL: OrderStatus[] = [
  'PENDING',
  'FUNDS_HELD',
  'CONFIRMED',
  'AWAITING_RECEIPT_CONFIRMATION',
  'RECEIPT_CONFIRMED',
  'SETTLING',
  'COMPLETED',
  'DISPUTED',
  'CANCELLING',
  'CANCELLED',
  'FAILED',
];

describe('the transition table', () => {
  it('covers every status exactly once', () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ALL].sort());
    expect(ALL).toHaveLength(11);
  });

  it('names only statuses that exist', () => {
    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      for (const to of targets) {
        expect(ALL).toContain(to);
        expect(to).not.toBe(from);
      }
    }
  });

  it('permits the whole happy path', () => {
    const path: OrderStatus[] = [
      'PENDING',
      'FUNDS_HELD',
      'CONFIRMED',
      'AWAITING_RECEIPT_CONFIRMATION',
      'RECEIPT_CONFIRMED',
      'SETTLING',
      'COMPLETED',
    ];

    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i] as OrderStatus, path[i + 1] as OrderStatus)).toBe(true);
    }
  });
});

describe('settlement cannot happen without receipt confirmation', () => {
  it('reaches SETTLING from RECEIPT_CONFIRMED and from nowhere else', () => {
    // The single most consequential property in this service. Derived from the
    // table rather than restated, so it cannot drift from what it describes.
    const sources = ALL.filter((from) => canTransition(from, 'SETTLING'));
    expect(sources).toEqual(['RECEIPT_CONFIRMED']);
  });

  it('reaches COMPLETED only from SETTLING', () => {
    const sources = ALL.filter((from) => canTransition(from, 'COMPLETED'));
    expect(sources).toEqual(['SETTLING']);
  });

  it('refuses to jump from fulfilment straight to settlement', () => {
    expect(canTransition('AWAITING_RECEIPT_CONFIRMATION', 'SETTLING')).toBe(false);
    expect(canTransition('AWAITING_RECEIPT_CONFIRMATION', 'COMPLETED')).toBe(false);
    expect(canTransition('CONFIRMED', 'COMPLETED')).toBe(false);
    expect(canTransition('FUNDS_HELD', 'COMPLETED')).toBe(false);
  });
});

describe('a dispute stops settlement', () => {
  it('has no edge from DISPUTED to SETTLING', () => {
    // Not a check somebody has to remember to write — an absent edge.
    expect(canTransition('DISPUTED', 'SETTLING')).toBe(false);
    expect(canTransition('DISPUTED', 'COMPLETED')).toBe(false);
    expect(canReachSettlement('DISPUTED')).toBe(false);
  });

  it('leaves DISPUTED only through an operator decision', () => {
    expect(ORDER_TRANSITIONS.DISPUTED).toEqual(['RECEIPT_CONFIRMED', 'CANCELLING']);
  });

  it('is reachable from every state where money is held but not yet moved', () => {
    for (const from of [
      'FUNDS_HELD',
      'CONFIRMED',
      'AWAITING_RECEIPT_CONFIRMATION',
      'RECEIPT_CONFIRMED',
    ] as OrderStatus[]) {
      expect(canTransition(from, 'DISPUTED')).toBe(true);
    }
  });

  it('is not reachable once the money has moved or the order is closed', () => {
    for (const from of ['COMPLETED', 'CANCELLED', 'FAILED', 'SETTLING'] as OrderStatus[]) {
      expect(canTransition(from, 'DISPUTED')).toBe(false);
    }
  });
});

describe('a terminal order cannot be replayed', () => {
  it('names exactly the three end states', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['CANCELLED', 'COMPLETED', 'FAILED']);
  });

  it('gives each of them no outgoing edge at all', () => {
    // This is what makes a replayed command financially inert: there is
    // nowhere for a completed order to go.
    for (const status of TERMINAL_STATUSES) {
      expect(ORDER_TRANSITIONS[status]).toEqual([]);
      expect(isTerminal(status)).toBe(true);
    }
  });

  it('refuses a repeated command on a completed order with a message that says why', () => {
    try {
      assertTransition('ORD_1', 'COMPLETED', 'SETTLING');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isRastaError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('BUSINESS_RULE_VIOLATION');
      expect((error as Error).message).toMatch(/already COMPLETED/);
    }
  });
});

describe('cancellation completes before the order is closed', () => {
  it('goes through CANCELLING, never straight to CANCELLED', () => {
    const sources = ALL.filter((from) => canTransition(from, 'CANCELLED'));
    // The intermediate state is what stops an order being reported cancelled
    // before the refund has actually happened.
    expect(sources).toEqual(['CANCELLING']);
  });

  it('can be started from every state before settlement', () => {
    for (const from of [
      'PENDING',
      'FUNDS_HELD',
      'CONFIRMED',
      'AWAITING_RECEIPT_CONFIRMATION',
    ] as OrderStatus[]) {
      expect(canTransition(from, 'CANCELLING')).toBe(true);
    }
  });

  it('cannot be started once settlement is under way', () => {
    // Cancelling mid-settlement would mean refunding money that may already
    // have moved. `docs/08` § 8.4 forbids automatic compensation there.
    expect(canTransition('SETTLING', 'CANCELLING')).toBe(false);
    expect(canTransition('RECEIPT_CONFIRMED', 'CANCELLING')).toBe(false);
  });
});

describe('a failed settlement attempt is retryable', () => {
  it('returns SETTLING to RECEIPT_CONFIRMED rather than failing the order', () => {
    // The order is still authorised; only the attempt failed. Marking it
    // FAILED would strand held money with no way to release it.
    expect(canTransition('SETTLING', 'RECEIPT_CONFIRMED')).toBe(true);
    expect(canTransition('SETTLING', 'FAILED')).toBe(false);
  });
});

describe('FAILED is only reachable before any money is committed', () => {
  it('comes from PENDING and from nowhere else', () => {
    const sources = ALL.filter((from) => canTransition(from, 'FAILED'));
    expect(sources).toEqual(['PENDING']);
  });
});

describe('assertTransition', () => {
  it('permits every edge the table declares', () => {
    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      for (const to of targets) {
        expect(() => assertTransition('ORD_1', from as OrderStatus, to)).not.toThrow();
      }
    }
  });

  it('refuses every edge the table does not', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        if (from === to || canTransition(from, to)) continue;
        expect(() => assertTransition('ORD_1', from, to)).toThrow();
      }
    }
  });

  it('names the order so an operator can find it', () => {
    expect(() => assertTransition('ORD_XYZ', 'PENDING', 'COMPLETED')).toThrow(/ORD_XYZ/);
  });
});
