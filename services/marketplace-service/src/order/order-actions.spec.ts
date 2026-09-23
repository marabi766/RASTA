import { runWithContext, type RequestContext } from '@rasta/nest-common';
import type { OrderStatus } from '../generated/prisma';
import { viewerParties } from '../access/access';
import { ORDER_TRANSITIONS } from './state-machine';
import { ORDER_ACTIONS, availableOrderActions, type OrderAction } from './order-actions';

/**
 * Which commands a given viewer may issue on an order in a given state.
 *
 * The table below is the claim this module makes, written out in full rather
 * than derived — a test that computed the expectation the same way the code
 * does would agree with any bug either of them had. Every cell was read off
 * `OrderService`'s call sites (`this.transition(orderId, <to>, { from, authorise })`)
 * and `access.ts`.
 *
 * The case the whole module exists for is `CONFIRM_RECEIPT` on a `DISPUTED`
 * order: `ORDER_TRANSITIONS` permits `DISPUTED → RECEIPT_CONFIRMED` so that a
 * platform operator resolving a dispute can put the order back on the
 * settlement path, and a client deriving from the table alone would offer the
 * **buyer** that button mid-dispute.
 */

const BUYER_ORG = 'ORG_BUYER';
const SUPPLIER_ORG = 'ORG_SUPPLIER';
const OTHER_ORG = 'ORG_STRANGER';

const ORDER = {
  id: 'ORD_1',
  organizationId: BUYER_ORG,
  supplierOrganizationId: SUPPLIER_ORG,
};

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: 'CORR_1',
    requestId: 'REQ_1',
    organizationId: BUYER_ORG,
    organizationIds: [BUYER_ORG],
    userId: 'USR_1',
    roles: ['PROCUREMENT_USER'],
    authType: 'USER',
    startedAt: 0,
    ...overrides,
  };
}

const AS_BUYER = context();
const AS_SUPPLIER = context({
  organizationId: SUPPLIER_ORG,
  organizationIds: [SUPPLIER_ORG],
  roles: ['SUPPLIER'],
});
/** A platform operator acting for an organization that is neither party. */
const AS_OPERATOR = context({
  organizationId: OTHER_ORG,
  organizationIds: [OTHER_ORG],
  roles: ['UNION_ADMIN'],
});

function actionsFor(
  ctx: RequestContext,
  status: OrderStatus,
  hasReview = false,
): readonly OrderAction[] {
  return runWithContext(ctx, () =>
    availableOrderActions({ status, hasReview }, viewerParties(ORDER)),
  );
}

// ---------------------------------------------------------------------------

describe('the supplier', () => {
  const cases: Array<[OrderStatus, OrderAction[]]> = [
    ['PENDING', []],
    ['FUNDS_HELD', ['CONFIRM']],
    ['CONFIRMED', ['FULFILL']],
    ['AWAITING_RECEIPT_CONFIRMATION', []],
    ['RECEIPT_CONFIRMED', []],
    ['SETTLING', []],
    ['DISPUTED', []],
    ['CANCELLING', []],
    ['COMPLETED', []],
    ['CANCELLED', []],
    ['FAILED', []],
  ];

  it.each(cases)('at %s may do %p', (status, expected) => {
    expect(actionsFor(AS_SUPPLIER, status)).toEqual(expected);
  });

  it('never gets a buyer command, at any status', () => {
    for (const status of Object.keys(ORDER_TRANSITIONS) as OrderStatus[]) {
      const actions = actionsFor(AS_SUPPLIER, status);
      expect(actions).not.toContain('CONFIRM_RECEIPT');
      expect(actions).not.toContain('CANCEL');
      expect(actions).not.toContain('RAISE_DISPUTE');
      expect(actions).not.toContain('REVIEW');
    }
  });
});

describe('the buyer', () => {
  const cases: Array<[OrderStatus, OrderAction[]]> = [
    ['PENDING', ['CANCEL']],
    ['FUNDS_HELD', ['RAISE_DISPUTE', 'CANCEL']],
    ['CONFIRMED', ['RAISE_DISPUTE', 'CANCEL']],
    ['AWAITING_RECEIPT_CONFIRMATION', ['CONFIRM_RECEIPT', 'RAISE_DISPUTE', 'CANCEL']],
    ['RECEIPT_CONFIRMED', ['RAISE_DISPUTE']],
    ['SETTLING', []],
    // The case this module exists for — see the header.
    ['DISPUTED', ['CANCEL']],
    ['CANCELLING', []],
    ['COMPLETED', ['REVIEW']],
    ['CANCELLED', []],
    ['FAILED', []],
  ];

  it.each(cases)('at %s may do %p', (status, expected) => {
    expect(actionsFor(AS_BUYER, status)).toEqual(expected);
  });

  it('is never offered receipt confirmation on a disputed order', () => {
    // `ORDER_TRANSITIONS` says DISPUTED → RECEIPT_CONFIRMED is a legal move —
    // it is, but only for `resolveDispute`, which is platform-only. Deriving
    // the buyer's actions from the table alone produces exactly this bug.
    expect(ORDER_TRANSITIONS.DISPUTED).toContain('RECEIPT_CONFIRMED');
    expect(actionsFor(AS_BUYER, 'DISPUTED')).not.toContain('CONFIRM_RECEIPT');
  });

  it('is never offered a supplier command', () => {
    for (const status of Object.keys(ORDER_TRANSITIONS) as OrderStatus[]) {
      const actions = actionsFor(AS_BUYER, status);
      expect(actions).not.toContain('CONFIRM');
      expect(actions).not.toContain('FULFILL');
    }
  });

  it('may not resolve the dispute it raised', () => {
    expect(actionsFor(AS_BUYER, 'DISPUTED')).not.toContain('RESOLVE_DISPUTE');
  });

  it('is offered a review once and not twice', () => {
    expect(actionsFor(AS_BUYER, 'COMPLETED', false)).toContain('REVIEW');
    expect(actionsFor(AS_BUYER, 'COMPLETED', true)).not.toContain('REVIEW');
  });
});

describe('a platform operator who is neither party', () => {
  it('may resolve a dispute and nothing else', () => {
    expect(actionsFor(AS_OPERATOR, 'DISPUTED')).toEqual(['RESOLVE_DISPUTE']);
  });

  it('may not confirm receipt — they were not there', () => {
    // `assertBuyer` gives a platform operator no exemption, deliberately:
    // confirming receipt asserts a delivery only the buyer witnessed.
    expect(actionsFor(AS_OPERATOR, 'AWAITING_RECEIPT_CONFIRMATION')).toEqual([]);
  });

  it('has nothing to offer on an order with no open dispute', () => {
    for (const status of Object.keys(ORDER_TRANSITIONS) as OrderStatus[]) {
      if (status === 'DISPUTED') continue;
      expect(actionsFor(AS_OPERATOR, status)).toEqual([]);
    }
  });
});

describe('a platform operator who is also the buyer', () => {
  const both = context({ roles: ['UNION_ADMIN', 'PROCUREMENT_USER'] });

  it('gets both sets, because the two are independent', () => {
    expect(actionsFor(both, 'DISPUTED')).toEqual(['RESOLVE_DISPUTE', 'CANCEL']);
  });

  it('may still confirm receipt, as the buyer', () => {
    expect(actionsFor(both, 'AWAITING_RECEIPT_CONFIRMATION')).toContain('CONFIRM_RECEIPT');
  });
});

describe('who gets nothing at all', () => {
  it('an organization that is neither party', () => {
    const stranger = context({ organizationId: OTHER_ORG, organizationIds: [OTHER_ORG] });
    for (const status of Object.keys(ORDER_TRANSITIONS) as OrderStatus[]) {
      expect(actionsFor(stranger, status)).toEqual([]);
    }
  });

  it('an AUDITOR, who has no access to an individual order', () => {
    // `docs/09` § 9.3: the oversight role is aggregate-only. Refused even
    // when it holds another role and acts for the buying organization.
    const auditor = context({ roles: ['AUDITOR', 'PROCUREMENT_USER'] });
    for (const status of Object.keys(ORDER_TRANSITIONS) as OrderStatus[]) {
      expect(actionsFor(auditor, status)).toEqual([]);
    }
  });

  it('a service caller, which acts for no organization', () => {
    const machine = context({ authType: 'SERVICE', roles: ['SERVICE'], userId: undefined });
    for (const status of Object.keys(ORDER_TRANSITIONS) as OrderStatus[]) {
      expect(actionsFor(machine, status)).toEqual([]);
    }
  });
});

describe('the shape of the answer', () => {
  it('is always in ORDER_ACTIONS order, whatever the rules table order is', () => {
    const actions = actionsFor(AS_BUYER, 'AWAITING_RECEIPT_CONFIRMATION');
    const positions = actions.map((a) => ORDER_ACTIONS.indexOf(a));
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
  });

  it('offers nothing from a terminal status except a review', () => {
    for (const status of ['CANCELLED', 'FAILED'] as OrderStatus[]) {
      expect(actionsFor(AS_BUYER, status)).toEqual([]);
      expect(actionsFor(AS_SUPPLIER, status)).toEqual([]);
    }
    expect(actionsFor(AS_BUYER, 'COMPLETED')).toEqual(['REVIEW']);
  });
});
