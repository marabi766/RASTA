import {
  MARKETPLACE_EVENTS,
  MARKETPLACE_EVENT_SCHEMAS,
  orderCompletedPayload,
  orderCreatedPayload,
  orderReceiptConfirmedPayload,
  validateMarketplacePayload,
} from './events';

/**
 * The event contracts this service owns.
 *
 * ADR-032 deferred these precisely because economic-service could not define
 * them: the catalogue had key-field sketches, and filling them in from the
 * consumer's side would be inventing a fact the consumer does not own. These
 * tests assert the properties that made the sketches unusable are now fixed.
 */

const NAMES = Object.values(MARKETPLACE_EVENTS);

describe('the catalogue', () => {
  it('publishes exactly the nine events docs/04 § 4.8 lists', () => {
    expect([...NAMES].sort()).toEqual(
      [
        'OFFER_PUBLISHED',
        'ORDER_CANCELLED',
        'ORDER_COMPLETED',
        'ORDER_CONFIRMED',
        'ORDER_CREATED',
        'ORDER_DISPUTED',
        'ORDER_FULFILLED',
        'ORDER_RECEIPT_CONFIRMED',
        'REVIEW_SUBMITTED',
      ].sort(),
    );
  });

  it('gives every event a schema', () => {
    for (const name of NAMES) {
      expect(MARKETPLACE_EVENT_SCHEMAS[name]).toBeDefined();
    }
    expect(Object.keys(MARKETPLACE_EVENT_SCHEMAS).sort()).toEqual([...NAMES].sort());
  });
});

describe('money on the wire', () => {
  const base = {
    orderId: 'ORD_1',
    buyerOrganizationId: 'ORG-A',
    supplierOrganizationId: 'ORG-B',
    currency: 'IRR',
    lines: [
      {
        offerId: 'OFR_1',
        productId: 'PRD_1',
        quantity: 1,
        unitPriceMinor: '250000',
        lineTotalMinor: '250000',
        offerVersion: 1,
      },
    ],
    createdAt: '2026-08-29T00:00:00.000Z',
  };

  it('accepts an amount as a string and refuses it as a number', () => {
    expect(orderCreatedPayload.safeParse({ ...base, totalAmountMinor: '250000' }).success).toBe(
      true,
    );
    // A JSON number would silently truncate a rial figure past
    // Number.MAX_SAFE_INTEGER, in the client's parser where no validation can
    // see it (ADR-022).
    expect(orderCreatedPayload.safeParse({ ...base, totalAmountMinor: 250000 }).success).toBe(
      false,
    );
  });

  it('refuses a decimal amount', () => {
    expect(orderCreatedPayload.safeParse({ ...base, totalAmountMinor: '2500.50' }).success).toBe(
      false,
    );
  });

  it('carries an amount beyond Number.MAX_SAFE_INTEGER intact', () => {
    const huge = '9007199254740993';
    const parsed = orderCreatedPayload.parse({ ...base, totalAmountMinor: huge });
    expect(parsed.totalAmountMinor).toBe(huge);
  });
});

describe('ORDER_RECEIPT_CONFIRMED carries what the sketch omitted', () => {
  const payload = {
    orderId: 'ORD_1',
    buyerOrganizationId: 'ORG-A',
    supplierOrganizationId: 'ORG-B',
    totalAmountMinor: '500000',
    currency: 'IRR',
    confirmedBy: 'USR-1',
    confirmedAt: '2026-08-29T00:00:00.000Z',
  };

  it('names an amount, which the catalogue sketch did not', () => {
    // ADR-032: "`ORDER_RECEIPT_CONFIRMED` in the catalogue has only
    // `orderId, confirmedBy`. It has no amount. Which means a consumer must
    // already know what to settle."
    expect(orderReceiptConfirmedPayload.parse(payload).totalAmountMinor).toBe('500000');
  });

  it('refuses a payload with only the sketch’s two fields', () => {
    expect(
      orderReceiptConfirmedPayload.safeParse({ orderId: 'ORD_1', confirmedBy: 'USR-1' }).success,
    ).toBe(false);
  });

  it('names both organizations, so a consumer need not resolve the wallet itself', () => {
    // The other gap ADR-032 recorded: "`walletId` is nowhere. The buyer's
    // wallet is derived from `buyerOrganizationId`" — which is a decision the
    // producer and consumer had to make together, and this is the producer's
    // half of it.
    const parsed = orderReceiptConfirmedPayload.parse(payload);
    expect(parsed.buyerOrganizationId).toBe('ORG-A');
    expect(parsed.supplierOrganizationId).toBe('ORG-B');
  });
});

describe('ORDER_COMPLETED echoes economic-service rather than computing', () => {
  it('carries the commission and net that settlement reported', () => {
    // This service does not know a commission rate and must not appear to
    // (ADR-040 § 6). Both figures come from the settlement response.
    const parsed = orderCompletedPayload.parse({
      orderId: 'ORD_1',
      buyerOrganizationId: 'ORG-A',
      supplierOrganizationId: 'ORG-B',
      totalAmountMinor: '500000',
      commissionAmountMinor: '12500',
      netAmountMinor: '487500',
      currency: 'IRR',
      settlementId: 'STL_1',
      completedAt: '2026-08-29T00:00:00.000Z',
    });

    expect(parsed.settlementId).toBe('STL_1');
    expect(BigInt(parsed.commissionAmountMinor) + BigInt(parsed.netAmountMinor)).toBe(
      BigInt(parsed.totalAmountMinor),
    );
  });

  it('requires a settlement id, so a completion is always reconcilable', () => {
    expect(
      orderCompletedPayload.safeParse({
        orderId: 'ORD_1',
        buyerOrganizationId: 'ORG-A',
        supplierOrganizationId: 'ORG-B',
        totalAmountMinor: '500000',
        commissionAmountMinor: '0',
        netAmountMinor: '500000',
        currency: 'IRR',
        completedAt: '2026-08-29T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

describe('ORDER_CREATED', () => {
  it('refuses an order with no lines', () => {
    expect(
      orderCreatedPayload.safeParse({
        orderId: 'ORD_1',
        buyerOrganizationId: 'ORG-A',
        supplierOrganizationId: 'ORG-B',
        totalAmountMinor: '0',
        currency: 'IRR',
        lines: [],
        createdAt: '2026-08-29T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('carries the price each line agreed to and the version it came from', () => {
    const parsed = orderCreatedPayload.parse({
      orderId: 'ORD_1',
      buyerOrganizationId: 'ORG-A',
      supplierOrganizationId: 'ORG-B',
      totalAmountMinor: '500000',
      currency: 'IRR',
      lines: [
        {
          offerId: 'OFR_1',
          productId: 'PRD_1',
          quantity: 2,
          unitPriceMinor: '250000',
          lineTotalMinor: '500000',
          offerVersion: 4,
        },
      ],
      createdAt: '2026-08-29T00:00:00.000Z',
    });

    expect(parsed.lines[0]?.offerVersion).toBe(4);
  });
});

describe('validateMarketplacePayload', () => {
  it('refuses a payload that does not match its own event', () => {
    expect(() => validateMarketplacePayload('ORDER_CONFIRMED', { orderId: 'ORD_1' })).toThrow();
  });

  it('returns the parsed payload for the caller to key on', () => {
    const parsed = validateMarketplacePayload('ORDER_CONFIRMED', {
      orderId: 'ORD_1',
      buyerOrganizationId: 'ORG-A',
      supplierOrganizationId: 'ORG-B',
      confirmedAt: '2026-08-29T00:00:00.000Z',
    });
    expect(parsed.orderId).toBe('ORD_1');
  });

  it('strips a field the caller added that the contract does not declare', () => {
    // Zod's default strip. What reaches the log is exactly the contract, so a
    // stray internal field cannot leak into a topic every service reads (S-09).
    const parsed = validateMarketplacePayload('ORDER_CONFIRMED', {
      orderId: 'ORD_1',
      buyerOrganizationId: 'ORG-A',
      supplierOrganizationId: 'ORG-B',
      confirmedAt: '2026-08-29T00:00:00.000Z',
      internalNote: 'should not travel',
    });
    expect(parsed).not.toHaveProperty('internalNote');
  });
});

describe('no payload carries personal or financial detail it should not', () => {
  it('never names a wallet, an account or a payment instrument', () => {
    const serialised = JSON.stringify(
      Object.values(MARKETPLACE_EVENT_SCHEMAS).map((schema) => schema.description ?? ''),
    );
    // A shape assertion over the declared keys, not the descriptions.
    const keys = Object.values(MARKETPLACE_EVENT_SCHEMAS).flatMap((schema) =>
      Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape),
    );

    for (const forbidden of ['walletId', 'accountId', 'cardNumber', 'iban', 'nationalId']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(serialised).toBeDefined();
  });
});
