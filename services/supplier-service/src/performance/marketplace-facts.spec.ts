import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError } from '@rasta/nest-common';
import { CONSUMED_EVENT_NAMES, marketplaceContribution } from './marketplace-facts';
import { performanceEventProblems } from './performance-event';

/**
 * ADR-052 step 5 — what each marketplace event contributes, decided without a
 * database. The integration suite drives the same function through the
 * consumer and a real PostgreSQL.
 */

const BUYER = 'ORG_BUYER';
const SUPPLIER = 'ORG_SUPPLIER';
const OCCURRED_AT = '2026-09-26T08:00:00.000Z';

function envelope(eventName: string, payload: Record<string, unknown>, overrides = {}) {
  return {
    eventId: 'EVT_1',
    eventName,
    eventVersion: 1,
    occurredAt: OCCURRED_AT,
    producer: 'marketplace-service',
    producerVersion: '1.0.0',
    aggregateType: 'Order',
    aggregateId: 'ORD_1',
    tenantId: BUYER,
    correlationId: 'COR_1',
    payload: {
      orderId: 'ORD_1',
      buyerOrganizationId: BUYER,
      supplierOrganizationId: SUPPLIER,
      ...payload,
    },
    ...overrides,
  } as EventEnvelope;
}

/** A valid payload of each consumed event, as marketplace publishes it. */
const PAYLOADS: Record<string, Record<string, unknown>> = {
  ORDER_CREATED: {
    totalAmountMinor: '1000',
    currency: 'IRR',
    lines: [],
    createdAt: OCCURRED_AT,
    promisedDeliveryAt: '2026-10-03T08:00:00.000Z',
  },
  ORDER_FULFILLED: {
    fulfillmentId: 'FUL_1',
    trackingReference: null,
    fulfilledAt: '2026-10-02T08:00:00.000Z',
    receiptDueAt: '2026-10-09T08:00:00.000Z',
  },
  REVIEW_SUBMITTED: { reviewId: 'REV_1', rating: 4, submittedAt: OCCURRED_AT },
  ORDER_DISPUTE_RESOLVED: {
    disputeId: 'DSP_1',
    outcome: 'REFUND',
    responsibility: 'SUPPLIER',
    resolvedBy: 'USR_OP',
    resolvedAt: OCCURRED_AT,
  },
  ORDER_CANCELLED: {
    totalAmountMinor: '1000',
    currency: 'IRR',
    reason: 'the supplier ran out of stock',
    cancelledBy: 'USR_1',
    cancelledAt: OCCURRED_AT,
    cancellationCause: 'BUYER',
  },
  ORDER_COMPLETED: {
    totalAmountMinor: '1000',
    commissionAmountMinor: '10',
    netAmountMinor: '990',
    currency: 'IRR',
    settlementId: 'STL_1',
    completedAt: OCCURRED_AT,
  },
};

function refusal(run: () => unknown): UnprocessableEventError {
  try {
    run();
  } catch (error) {
    if (error instanceof UnprocessableEventError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const common = {
  organizationId: SUPPLIER,
  sourceEventId: 'EVT_1',
  outcomeKind: 'ORDER',
  outcomeKey: 'ORD_1',
  occurredAt: new Date(OCCURRED_AT),
  correlationId: 'COR_1',
};

describe('marketplaceContribution', () => {
  it('reads exactly the six events with something to say about a supplier', () => {
    expect([...CONSUMED_EVENT_NAMES].sort()).toEqual(Object.keys(PAYLOADS).sort());
  });

  it.each([
    'OFFER_PUBLISHED',
    'ORDER_CONFIRMED',
    'ORDER_RECEIPT_CONFIRMED',
    'ORDER_DISPUTED',
    'ORDER_FUNDS_HELD',
    'toString',
  ])('contributes nothing for %s', (eventName) => {
    expect(marketplaceContribution(envelope(eventName, {}))).toBeNull();
  });

  describe('each fact, under the supplier, keyed by the order', () => {
    it('ORDER_CREATED is the promise side of ON_TIME', () => {
      expect(marketplaceContribution(envelope('ORDER_CREATED', PAYLOADS.ORDER_CREATED!))).toEqual({
        kind: 'FACT',
        fact: expect.objectContaining({
          ...common,
          sourceEventName: 'ORDER_CREATED',
          component: 'ON_TIME',
          promisedAt: new Date('2026-10-03T08:00:00.000Z'),
          deliveredAt: null,
        }),
      });
    });

    it('ORDER_FULFILLED is the delivery side of ON_TIME', () => {
      expect(
        marketplaceContribution(envelope('ORDER_FULFILLED', PAYLOADS.ORDER_FULFILLED!)),
      ).toEqual({
        kind: 'FACT',
        fact: expect.objectContaining({
          ...common,
          component: 'ON_TIME',
          promisedAt: null,
          deliveredAt: new Date('2026-10-02T08:00:00.000Z'),
        }),
      });
    });

    it('REVIEW_SUBMITTED is the raw rating, never a score', () => {
      expect(
        marketplaceContribution(envelope('REVIEW_SUBMITTED', PAYLOADS.REVIEW_SUBMITTED!)),
      ).toEqual({
        kind: 'FACT',
        fact: expect.objectContaining({ ...common, component: 'CUSTOMER_SATISFACTION', rating: 4 }),
      });
    });

    it('ORDER_DISPUTE_RESOLVED carries the attribution and the dispute it resolves', () => {
      expect(
        marketplaceContribution(
          envelope('ORDER_DISPUTE_RESOLVED', PAYLOADS.ORDER_DISPUTE_RESOLVED!),
        ),
      ).toEqual({
        kind: 'FACT',
        fact: expect.objectContaining({
          ...common,
          component: 'DISPUTE_ABSENCE',
          responsibility: 'SUPPLIER',
          disputeId: 'DSP_1',
        }),
      });
    });

    it('ORDER_CANCELLED carries the structured cause, never the free-text reason', () => {
      const contribution = marketplaceContribution(
        envelope('ORDER_CANCELLED', PAYLOADS.ORDER_CANCELLED!),
      );
      expect(contribution).toEqual({
        kind: 'FACT',
        fact: expect.objectContaining({
          ...common,
          component: 'CANCELLATION_ABSENCE',
          responsibility: 'BUYER',
        }),
      });
      expect(JSON.stringify(contribution)).not.toContain('ran out of stock');
    });

    it('ORDER_COMPLETED is a concluded outcome, with no component', () => {
      expect(
        marketplaceContribution(envelope('ORDER_COMPLETED', PAYLOADS.ORDER_COMPLETED!)),
      ).toEqual({
        kind: 'CONCLUDED_OUTCOME',
        outcome: { ...common, sourceEventName: 'ORDER_COMPLETED' },
      });
    });

    it.each(Object.keys(PAYLOADS).filter((name) => name !== 'ORDER_COMPLETED'))(
      '%s builds a fact the domain rules accept',
      (eventName) => {
        const contribution = marketplaceContribution(envelope(eventName, PAYLOADS[eventName]!));
        if (contribution?.kind !== 'FACT') throw new Error('expected a fact');
        expect(performanceEventProblems(contribution.fact)).toEqual([]);
      },
    );
  });

  describe('a consumed event that measures nothing is not a fact, and nothing is inferred', () => {
    it('an ORDER_CREATED from before ADR-052 § 1-a has no promise', () => {
      const { promisedDeliveryAt: _omitted, ...payload } = PAYLOADS.ORDER_CREATED!;
      expect(marketplaceContribution(envelope('ORDER_CREATED', payload))).toEqual({
        kind: 'NOT_A_FACT',
        supplierOrganizationId: SUPPLIER,
        reason: 'promise_absent',
      });
    });

    it('an ORDER_CANCELLED from before ADR-052 § 1-c has no attribution', () => {
      const { cancellationCause: _omitted, ...payload } = PAYLOADS.ORDER_CANCELLED!;
      expect(marketplaceContribution(envelope('ORDER_CANCELLED', payload))).toEqual({
        kind: 'NOT_A_FACT',
        supplierOrganizationId: SUPPLIER,
        reason: 'attribution_absent',
      });
    });
  });

  describe('ADR-061 § 5 — the envelope’s tenant must be the payload’s buyer', () => {
    it.each(Object.keys(PAYLOADS))('accepts %s when they agree', (eventName) => {
      expect(() =>
        marketplaceContribution(envelope(eventName, PAYLOADS[eventName]!)),
      ).not.toThrow();
    });

    it.each(Object.keys(PAYLOADS))(
      'refuses %s stamped with another tenant, SOURCE_UNCONFIRMED',
      (eventName) => {
        const error = refusal(() =>
          marketplaceContribution(
            envelope(eventName, PAYLOADS[eventName]!, { tenantId: 'ORG_SOMEONE_ELSE' }),
          ),
        );
        expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
      },
    );

    it('refuses an event stamped with the supplier’s tenant instead of the buyer’s', () => {
      // The supplier writing about itself, in its own name: exactly the claim
      // this check exists to stop.
      const error = refusal(() =>
        marketplaceContribution(
          envelope(
            'REVIEW_SUBMITTED',
            { ...PAYLOADS.REVIEW_SUBMITTED, rating: 5 },
            {
              tenantId: SUPPLIER,
            },
          ),
        ),
      );
      expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
    });

    it('refuses an event with no tenant at all', () => {
      const error = refusal(() =>
        marketplaceContribution(
          envelope('REVIEW_SUBMITTED', PAYLOADS.REVIEW_SUBMITTED!, { tenantId: undefined }),
        ),
      );
      expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
    });

    it('does not judge the tenant of an event it does not read', () => {
      expect(
        marketplaceContribution(envelope('ORDER_CONFIRMED', {}, { tenantId: 'ORG_X' })),
      ).toBeNull();
    });
  });

  describe('refusals are verdicts, dead-lettered once', () => {
    it('refuses a version it does not know', () => {
      const error = refusal(() =>
        marketplaceContribution(
          envelope('REVIEW_SUBMITTED', PAYLOADS.REVIEW_SUBMITTED!, { eventVersion: 2 }),
        ),
      );
      expect(error.reason).toBe(DLQ_REASONS.SCHEMA_VERSION_UNSUPPORTED);
    });

    it.each([
      ['a rating outside 1..5', 'REVIEW_SUBMITTED', { rating: 6 }, 'rating'],
      ['a fractional rating', 'REVIEW_SUBMITTED', { rating: 3.5 }, 'rating'],
      [
        'a responsibility outside rule 13',
        'ORDER_DISPUTE_RESOLVED',
        { responsibility: 'VENDOR' },
        'responsibility',
      ],
      ['a dispute with no id', 'ORDER_DISPUTE_RESOLVED', { disputeId: '' }, 'disputeId'],
      ['a delivery with no time', 'ORDER_FULFILLED', { fulfilledAt: 'yesterday' }, 'fulfilledAt'],
      [
        'an order with no supplier',
        'ORDER_COMPLETED',
        { supplierOrganizationId: undefined },
        'supplierOrganizationId',
      ],
    ])(
      'refuses %s, VALIDATION_FAILED, naming the path and not the value',
      (_label, eventName, change, path) => {
        const error = refusal(() =>
          marketplaceContribution(envelope(eventName, { ...PAYLOADS[eventName], ...change })),
        );
        expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
        expect(error.message).toContain(path);
        expect(error.message).not.toContain('VENDOR');
        expect(error.message).not.toContain('yesterday');
      },
    );
  });
});
