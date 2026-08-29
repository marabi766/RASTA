import { MARKETPLACE_EVENTS, type MarketplaceEventName } from './events';
import {
  AGGREGATE_OF,
  PARTITION_KEY_POLICY,
  resolvePartitionKey,
  type PartitionScope,
} from './routing';

/**
 * Partition keys for the marketplace stream.
 *
 * The invariant a consumer of `rasta.marketplace.v1` depends on: every event
 * of one order's lifecycle lands on one partition, so a saga rebuilding that
 * order sees created → confirmed → fulfilled → receipt-confirmed → completed in
 * that sequence. Kafka orders within a partition and nowhere else.
 *
 * The table below is the specification, and the exhaustiveness test guards it
 * in both directions.
 */

const ORDER = 'ORD_1';
const OTHER_ORDER = 'ORD_2';
const BUYER = 'ORG-BUYER';
const SUPPLIER = 'ORG-SUPPLIER';

const PAYLOADS = {
  OFFER_PUBLISHED: {
    offerId: 'OFR_1',
    productId: 'PRD_1',
    supplierOrganizationId: SUPPLIER,
    unitPriceMinor: '250000',
    currency: 'IRR',
    availableQuantity: 10,
    leadTimeDays: 3,
    version: 1,
    publishedAt: '2026-08-29T00:00:00.000Z',
  },
  ORDER_CREATED: {
    orderId: ORDER,
    buyerOrganizationId: BUYER,
    supplierOrganizationId: SUPPLIER,
    totalAmountMinor: '500000',
    currency: 'IRR',
    lines: [
      {
        offerId: 'OFR_1',
        productId: 'PRD_1',
        quantity: 2,
        unitPriceMinor: '250000',
        lineTotalMinor: '500000',
        offerVersion: 1,
      },
    ],
    createdAt: '2026-08-29T00:00:01.000Z',
  },
  ORDER_CONFIRMED: {
    orderId: ORDER,
    buyerOrganizationId: BUYER,
    supplierOrganizationId: SUPPLIER,
    confirmedAt: '2026-08-29T00:00:02.000Z',
  },
  ORDER_FULFILLED: {
    orderId: ORDER,
    fulfillmentId: 'FUL_1',
    buyerOrganizationId: BUYER,
    supplierOrganizationId: SUPPLIER,
    trackingReference: null,
    fulfilledAt: '2026-08-29T00:00:03.000Z',
    receiptDueAt: '2026-09-01T00:00:03.000Z',
  },
  ORDER_RECEIPT_CONFIRMED: {
    orderId: ORDER,
    buyerOrganizationId: BUYER,
    supplierOrganizationId: SUPPLIER,
    totalAmountMinor: '500000',
    currency: 'IRR',
    confirmedBy: 'USR-1',
    confirmedAt: '2026-08-29T00:00:04.000Z',
  },
  ORDER_COMPLETED: {
    orderId: ORDER,
    buyerOrganizationId: BUYER,
    supplierOrganizationId: SUPPLIER,
    totalAmountMinor: '500000',
    commissionAmountMinor: '12500',
    netAmountMinor: '487500',
    currency: 'IRR',
    settlementId: 'STL_1',
    completedAt: '2026-08-29T00:00:05.000Z',
  },
  ORDER_CANCELLED: {
    orderId: ORDER,
    buyerOrganizationId: BUYER,
    supplierOrganizationId: SUPPLIER,
    totalAmountMinor: '500000',
    currency: 'IRR',
    reason: 'no longer needed',
    cancelledBy: 'USR-1',
    cancelledAt: '2026-08-29T00:00:06.000Z',
  },
  ORDER_DISPUTED: {
    orderId: ORDER,
    disputeId: 'DSP_1',
    buyerOrganizationId: BUYER,
    supplierOrganizationId: SUPPLIER,
    reason: 'the delivered goods do not match the offer',
    raisedBy: 'USR-1',
    raisedAt: '2026-08-29T00:00:07.000Z',
  },
  REVIEW_SUBMITTED: {
    reviewId: 'REV_1',
    orderId: ORDER,
    buyerOrganizationId: BUYER,
    supplierOrganizationId: SUPPLIER,
    rating: 5,
    submittedAt: '2026-08-29T00:00:08.000Z',
  },
} satisfies { [N in MarketplaceEventName]: Parameters<(typeof PARTITION_KEY_POLICY)[N]>[0] };

const EXPECTED: { [N in MarketplaceEventName]: { scope: PartitionScope; key: string } } = {
  OFFER_PUBLISHED: { scope: 'OFFER', key: 'OFR_1' },
  ORDER_CREATED: { scope: 'ORDER', key: ORDER },
  ORDER_CONFIRMED: { scope: 'ORDER', key: ORDER },
  ORDER_FULFILLED: { scope: 'ORDER', key: ORDER },
  ORDER_RECEIPT_CONFIRMED: { scope: 'ORDER', key: ORDER },
  ORDER_COMPLETED: { scope: 'ORDER', key: ORDER },
  ORDER_CANCELLED: { scope: 'ORDER', key: ORDER },
  ORDER_DISPUTED: { scope: 'ORDER', key: ORDER },
  REVIEW_SUBMITTED: { scope: 'ORDER', key: ORDER },
};

const NAMES = Object.values(MARKETPLACE_EVENTS);

function resolve<N extends MarketplaceEventName>(name: N) {
  return resolvePartitionKey(name, PAYLOADS[name]);
}

describe('every published marketplace event has a partition decision', () => {
  it.each(NAMES)('%s resolves the scope and key its contract specifies', (name) => {
    expect(resolve(name)).toEqual(EXPECTED[name]);
  });

  it('covers exactly the nine events docs/04 § 4.8 lists', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...NAMES].sort());
    expect(Object.keys(PARTITION_KEY_POLICY).sort()).toEqual([...NAMES].sort());
    expect(NAMES).toHaveLength(9);
  });
});

describe('an order is one ordered stream', () => {
  it('gives every order-lifecycle event of one order the same key', () => {
    const lifecycle = [
      'ORDER_CREATED',
      'ORDER_CONFIRMED',
      'ORDER_FULFILLED',
      'ORDER_RECEIPT_CONFIRMED',
      'ORDER_COMPLETED',
      'ORDER_CANCELLED',
      'ORDER_DISPUTED',
    ] as const;

    expect(new Set(lifecycle.map((name) => resolve(name).key))).toEqual(new Set([ORDER]));
  });

  it('keys a review by its order, not by the review', () => {
    // A review can only exist for a completed order, so it belongs in that
    // order's stream — and it has no lifecycle of its own to be ordered by.
    expect(AGGREGATE_OF.REVIEW_SUBMITTED).toBe('Review');
    expect(resolve('REVIEW_SUBMITTED').key).toBe(ORDER);
    expect(resolve('REVIEW_SUBMITTED').key).not.toBe(PAYLOADS.REVIEW_SUBMITTED.reviewId);
  });

  it('lets two orders partition independently', () => {
    const first = resolvePartitionKey('ORDER_CREATED', PAYLOADS.ORDER_CREATED);
    const second = resolvePartitionKey('ORDER_CREATED', {
      ...PAYLOADS.ORDER_CREATED,
      orderId: OTHER_ORDER,
    });

    expect(first.key).not.toBe(second.key);
    expect(second.key).toBe(OTHER_ORDER);
  });
});

describe('the catalogue is its own stream', () => {
  it('keys an offer by the offer, because repricings must apply in order', () => {
    expect(resolve('OFFER_PUBLISHED')).toEqual({ scope: 'OFFER', key: 'OFR_1' });
  });

  it('does not put an offer on any order’s partition', () => {
    expect(resolve('OFFER_PUBLISHED').scope).not.toBe('ORDER');
  });
});

describe('the policy refuses to publish an unkeyed message', () => {
  it('throws rather than letting Kafka round-robin the event', () => {
    expect(() =>
      resolvePartitionKey('ORDER_CREATED', { ...PAYLOADS.ORDER_CREATED, orderId: '' }),
    ).toThrow(/empty ORDER partition key/);
  });

  it('names the event so an operator can find it', () => {
    expect(() =>
      resolvePartitionKey('OFFER_PUBLISHED', { ...PAYLOADS.OFFER_PUBLISHED, offerId: '' }),
    ).toThrow(/^OFFER_PUBLISHED /);
  });
});

describe('aggregate identity is separate from partition ordering', () => {
  it('names the entity each event is about', () => {
    expect(AGGREGATE_OF).toEqual({
      OFFER_PUBLISHED: 'Offer',
      ORDER_CREATED: 'Order',
      ORDER_CONFIRMED: 'Order',
      ORDER_FULFILLED: 'Order',
      ORDER_RECEIPT_CONFIRMED: 'Order',
      ORDER_COMPLETED: 'Order',
      ORDER_CANCELLED: 'Order',
      ORDER_DISPUTED: 'Order',
      REVIEW_SUBMITTED: 'Review',
    });
  });

  it('gives every event an aggregate type', () => {
    for (const name of NAMES) {
      expect(AGGREGATE_OF[name]).toBeTruthy();
    }
  });
});
