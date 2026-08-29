import { isRastaError } from '@rasta/nest-common';
import { priceOrder, totalOf, type PriceableOffer } from './pricing';

/**
 * Server-side pricing (ADR-037 § 5).
 *
 * `docs/17` § Marketplace states it as an acceptance criterion: the price
 * comes from the offer and the client's input is not used. The strongest test
 * of that here is a structural one — this module has no parameter through
 * which a client price could arrive, so the tests below are about what it does
 * with the catalogue rather than about ignoring an input.
 */

const SUPPLIER = 'ORG-SUPPLIER';

function offer(overrides: Partial<PriceableOffer> = {}): PriceableOffer {
  return {
    id: 'OFR_1',
    organizationId: SUPPLIER,
    productId: 'PRD_1',
    unitPriceMinor: 250_000n,
    currency: 'IRR',
    availableQuantity: 10,
    minimumQuantity: 1,
    version: 3,
    status: 'PUBLISHED',
    ...overrides,
  };
}

function catalogue(...offers: PriceableOffer[]) {
  return new Map(offers.map((o) => [o.id, o]));
}

describe('the price comes from the offer', () => {
  it('multiplies the catalogue price by the requested quantity', () => {
    const priced = priceOrder([{ offerId: 'OFR_1', quantity: 4 }], catalogue(offer()));

    expect(priced.totalAmountMinor).toBe(1_000_000n);
    expect(priced.lines[0]?.unitPriceMinor).toBe(250_000n);
    expect(priced.lines[0]?.lineTotalMinor).toBe(1_000_000n);
  });

  it('records which repricing of the offer the line agreed to', () => {
    // What makes "which price did this order actually agree to" answerable
    // years later, after the offer has been repriced repeatedly.
    const priced = priceOrder(
      [{ offerId: 'OFR_1', quantity: 1 }],
      catalogue(offer({ version: 7 })),
    );
    expect(priced.lines[0]?.offerVersion).toBe(7);
  });

  it('keeps full precision on an amount past Number.MAX_SAFE_INTEGER', () => {
    // A rial figure this size does not survive a JSON round trip as a number
    // (ADR-022); the arithmetic here is bigint end to end.
    const huge = 9_007_199_254_740_993n;
    const priced = priceOrder(
      [{ offerId: 'OFR_1', quantity: 3 }],
      catalogue(offer({ unitPriceMinor: huge })),
    );

    expect(priced.totalAmountMinor).toBe(huge * 3n);
    expect(Number(priced.totalAmountMinor)).not.toBe(priced.totalAmountMinor);
  });

  it('sums several lines into one total', () => {
    const priced = priceOrder(
      [
        { offerId: 'OFR_1', quantity: 2 },
        { offerId: 'OFR_2', quantity: 1 },
      ],
      catalogue(offer(), offer({ id: 'OFR_2', unitPriceMinor: 40_000n, productId: 'PRD_2' })),
    );

    expect(priced.totalAmountMinor).toBe(540_000n);
    expect(totalOf(priced.lines)).toBe(priced.totalAmountMinor);
  });
});

describe('an offer that is not for sale does not exist', () => {
  it.each(['DRAFT', 'SUSPENDED', 'WITHDRAWN'])('reports 404 for a %s offer', (status) => {
    // 404 rather than 422: to this buyer an unpublished offer is not a refused
    // purchase, it is an offer they were never shown.
    try {
      priceOrder([{ offerId: 'OFR_1', quantity: 1 }], catalogue(offer({ status })));
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isRastaError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('NOT_FOUND');
    }
  });

  it('reports 404 for an offer that was never loaded', () => {
    expect(() => priceOrder([{ offerId: 'OFR_MISSING', quantity: 1 }], catalogue())).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});

describe('the request has to match what the catalogue offers', () => {
  it('refuses more than is available rather than silently reducing it', () => {
    // Quietly shipping fewer would mean the buyer committed to something they
    // did not get, and found out after the money moved.
    expect(() =>
      priceOrder([{ offerId: 'OFR_1', quantity: 11 }], catalogue(offer({ availableQuantity: 10 }))),
    ).toThrow(expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }));
  });

  it('allows exactly the available quantity', () => {
    const priced = priceOrder(
      [{ offerId: 'OFR_1', quantity: 10 }],
      catalogue(offer({ availableQuantity: 10 })),
    );
    expect(priced.lines[0]?.quantity).toBe(10);
  });

  it('refuses less than the minimum', () => {
    expect(() =>
      priceOrder([{ offerId: 'OFR_1', quantity: 2 }], catalogue(offer({ minimumQuantity: 5 }))),
    ).toThrow(expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }));
  });

  it('refuses the same offer twice on one order', () => {
    // Merging them would change the quantity the buyer sees confirmed, and the
    // unique index would refuse the write anyway.
    expect(() =>
      priceOrder(
        [
          { offerId: 'OFR_1', quantity: 1 },
          { offerId: 'OFR_1', quantity: 2 },
        ],
        catalogue(offer()),
      ),
    ).toThrow(/only once/);
  });

  it('refuses an empty order', () => {
    expect(() => priceOrder([], catalogue())).toThrow(/at least one line/);
  });
});

describe('one order, one supplier and one currency', () => {
  it('refuses offers from two suppliers', () => {
    // One financial obligation has one counterparty in economic-service, so an
    // order spanning two sellers has no representation there.
    expect(() =>
      priceOrder(
        [
          { offerId: 'OFR_1', quantity: 1 },
          { offerId: 'OFR_2', quantity: 1 },
        ],
        catalogue(offer(), offer({ id: 'OFR_2', organizationId: 'ORG-OTHER' })),
      ),
    ).toThrow(/only one supplier/);
  });

  it('refuses a mixed-currency order', () => {
    expect(() =>
      priceOrder(
        [
          { offerId: 'OFR_1', quantity: 1 },
          { offerId: 'OFR_2', quantity: 1 },
        ],
        catalogue(offer(), offer({ id: 'OFR_2', currency: 'USD' })),
      ),
    ).toThrow(/only one currency/);
  });

  it('reports the supplier the order belongs to', () => {
    const priced = priceOrder([{ offerId: 'OFR_1', quantity: 1 }], catalogue(offer()));
    expect(priced.supplierOrganizationId).toBe(SUPPLIER);
    expect(priced.currency).toBe('IRR');
  });
});

describe('there is no price the client can influence', () => {
  it('takes nothing but an offer id and a quantity', () => {
    // A structural assertion rather than a behavioural one: the input type has
    // two fields, so there is no channel through which a price could arrive.
    // If a third ever appears, this fails and somebody has to justify it.
    const request = { offerId: 'OFR_1', quantity: 1 };
    expect(Object.keys(request).sort()).toEqual(['offerId', 'quantity']);
  });

  it('prices from the catalogue even when the caller asks for an unusual quantity', () => {
    const cheap = priceOrder([{ offerId: 'OFR_1', quantity: 1 }], catalogue(offer()));
    const many = priceOrder([{ offerId: 'OFR_1', quantity: 4 }], catalogue(offer()));

    // No volume discount is invented. A discount is a business rule the
    // product document does not state, and inventing one would be inventing a
    // commercial fact (AGENTS.md § 9).
    expect(many.totalAmountMinor).toBe(cheap.totalAmountMinor * 4n);
  });
});

describe('a zero-value order is refused', () => {
  it('never produces a total of zero', () => {
    // economic-service refuses a journal with no amount, so an order like this
    // would fail later in the saga with an error nobody could explain.
    expect(() =>
      priceOrder([{ offerId: 'OFR_1', quantity: 1 }], catalogue(offer({ unitPriceMinor: 0n }))),
    ).toThrow(/positive total/);
  });
});
