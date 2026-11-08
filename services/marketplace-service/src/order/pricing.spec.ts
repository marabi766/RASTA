import { isRastaError } from '@rasta/nest-common';
import { priceOrder, totalOf, type PriceableOffer, type RequestedLine } from './pricing';

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
    leadTimeDays: 3,
    ...overrides,
  };
}

function catalogue(...offers: PriceableOffer[]) {
  return new Map(offers.map((o) => [o.id, o]));
}

describe('the price comes from the offer', () => {
  it('multiplies the catalogue price by the requested quantity', () => {
    const priced = priceOrder(
      [{ offerId: 'OFR_1', offerVersion: 3, quantity: 4 }],
      catalogue(offer()),
    );

    expect(priced.totalAmountMinor).toBe(1_000_000n);
    expect(priced.lines[0]?.unitPriceMinor).toBe(250_000n);
    expect(priced.lines[0]?.lineTotalMinor).toBe(1_000_000n);
  });

  it('records which repricing of the offer the line agreed to', () => {
    // What makes "which price did this order actually agree to" answerable
    // years later, after the offer has been repriced repeatedly.
    const priced = priceOrder(
      [{ offerId: 'OFR_1', offerVersion: 7, quantity: 1 }],
      catalogue(offer({ version: 7 })),
    );
    expect(priced.lines[0]?.offerVersion).toBe(7);
  });

  it('keeps full precision on an amount past Number.MAX_SAFE_INTEGER', () => {
    // A rial figure this size does not survive a JSON round trip as a number
    // (ADR-022); the arithmetic here is bigint end to end.
    const huge = 9_007_199_254_740_993n;
    const priced = priceOrder(
      [{ offerId: 'OFR_1', offerVersion: 3, quantity: 3 }],
      catalogue(offer({ unitPriceMinor: huge })),
    );

    expect(priced.totalAmountMinor).toBe(huge * 3n);
    expect(Number(priced.totalAmountMinor)).not.toBe(priced.totalAmountMinor);
  });

  it('sums several lines into one total', () => {
    const priced = priceOrder(
      [
        { offerId: 'OFR_1', offerVersion: 3, quantity: 2 },
        { offerId: 'OFR_2', offerVersion: 3, quantity: 1 },
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
      priceOrder(
        [{ offerId: 'OFR_1', offerVersion: 3, quantity: 1 }],
        catalogue(offer({ status })),
      );
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isRastaError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('NOT_FOUND');
    }
  });

  it('reports 404 for an offer that was never loaded', () => {
    expect(() =>
      priceOrder([{ offerId: 'OFR_MISSING', offerVersion: 3, quantity: 1 }], catalogue()),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it.each([
    ['never loaded', catalogue(), [{ offerId: 'token=secret123', offerVersion: 3, quantity: 1 }]],
    [
      'not published',
      catalogue(offer({ id: 'token=secret123', status: 'DRAFT' })),
      [{ offerId: 'token=secret123', offerVersion: 3, quantity: 1 }],
    ],
    [
      'repeated',
      catalogue(),
      [
        { offerId: 'token=secret123', offerVersion: 3, quantity: 1 },
        { offerId: 'token=secret123', offerVersion: 3, quantity: 1 },
      ],
    ],
  ])(
    'an offer id %s is the client’s text: not in the refusal’s context (S-09)',
    (_, offers, lines) => {
      let error: unknown;
      try {
        priceOrder(lines, offers);
      } catch (thrown) {
        error = thrown;
      }
      expect(isRastaError(error)).toBe(true);
      const { message, internalContext } = error as { message: string; internalContext?: unknown };
      expect(JSON.stringify([message, internalContext ?? null])).not.toContain('secret123');
    },
  );
});

describe('the request has to match what the catalogue offers', () => {
  it('refuses more than is available rather than silently reducing it', () => {
    // Quietly shipping fewer would mean the buyer committed to something they
    // did not get, and found out after the money moved.
    expect(() =>
      priceOrder(
        [{ offerId: 'OFR_1', offerVersion: 3, quantity: 11 }],
        catalogue(offer({ availableQuantity: 10 })),
      ),
    ).toThrow(expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }));
  });

  it('allows exactly the available quantity', () => {
    const priced = priceOrder(
      [{ offerId: 'OFR_1', offerVersion: 3, quantity: 10 }],
      catalogue(offer({ availableQuantity: 10 })),
    );
    expect(priced.lines[0]?.quantity).toBe(10);
  });

  it('refuses less than the minimum', () => {
    expect(() =>
      priceOrder(
        [{ offerId: 'OFR_1', offerVersion: 3, quantity: 2 }],
        catalogue(offer({ minimumQuantity: 5 })),
      ),
    ).toThrow(expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }));
  });

  it('refuses the same offer twice on one order', () => {
    // Merging them would change the quantity the buyer sees confirmed, and the
    // unique index would refuse the write anyway.
    expect(() =>
      priceOrder(
        [
          { offerId: 'OFR_1', offerVersion: 3, quantity: 1 },
          { offerId: 'OFR_1', offerVersion: 3, quantity: 2 },
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
          { offerId: 'OFR_1', offerVersion: 3, quantity: 1 },
          { offerId: 'OFR_2', offerVersion: 3, quantity: 1 },
        ],
        catalogue(offer(), offer({ id: 'OFR_2', organizationId: 'ORG-OTHER' })),
      ),
    ).toThrow(/only one supplier/);
  });

  it('refuses a mixed-currency order', () => {
    expect(() =>
      priceOrder(
        [
          { offerId: 'OFR_1', offerVersion: 3, quantity: 1 },
          { offerId: 'OFR_2', offerVersion: 3, quantity: 1 },
        ],
        catalogue(offer(), offer({ id: 'OFR_2', currency: 'USD' })),
      ),
    ).toThrow(/only one currency/);
  });

  it('reports the supplier the order belongs to', () => {
    const priced = priceOrder(
      [{ offerId: 'OFR_1', offerVersion: 3, quantity: 1 }],
      catalogue(offer()),
    );
    expect(priced.supplierOrganizationId).toBe(SUPPLIER);
    expect(priced.currency).toBe('IRR');
  });
});

describe('there is no price the client can influence', () => {
  it('takes nothing but an offer id and a quantity', () => {
    // A structural assertion rather than a behavioural one: the input type has
    // three fields, none of them a price, so there is no channel through which
    // a price could arrive. The version names which price, and is only ever
    // compared (D-156). If a fourth ever appears, this fails and somebody has
    // to justify it.
    const request: Required<RequestedLine> = { offerId: 'OFR_1', offerVersion: 3, quantity: 1 };
    expect(Object.keys(request).sort()).toEqual(['offerId', 'offerVersion', 'quantity']);
  });

  it('prices from the catalogue even when the caller asks for an unusual quantity', () => {
    const cheap = priceOrder(
      [{ offerId: 'OFR_1', offerVersion: 3, quantity: 1 }],
      catalogue(offer()),
    );
    const many = priceOrder(
      [{ offerId: 'OFR_1', offerVersion: 3, quantity: 4 }],
      catalogue(offer()),
    );

    // No volume discount is invented. A discount is a business rule the
    // product document does not state, and inventing one would be inventing a
    // commercial fact (AGENTS.md § 9).
    expect(many.totalAmountMinor).toBe(cheap.totalAmountMinor * 4n);
  });
});

describe('the promised delivery date takes the slowest line (ADR-052 § 1-a)', () => {
  it('reports a single line’s lead time', () => {
    const priced = priceOrder(
      [{ offerId: 'OFR_1', offerVersion: 3, quantity: 1 }],
      catalogue(offer({ leadTimeDays: 5 })),
    );
    expect(priced.maxLeadTimeDays).toBe(5);
  });

  it('takes the slowest of several lines, not the average', () => {
    // A supplier promising a fast part and a slow one has committed to the
    // slow one arriving. Averaging would understate the promise.
    const priced = priceOrder(
      [
        { offerId: 'OFR_1', offerVersion: 3, quantity: 1 },
        { offerId: 'OFR_2', offerVersion: 3, quantity: 1 },
      ],
      catalogue(
        offer({ leadTimeDays: 2 }),
        offer({ id: 'OFR_2', productId: 'PRD_2', leadTimeDays: 9 }),
      ),
    );
    expect(priced.maxLeadTimeDays).toBe(9);
  });

  it('is zero for a same-day offer', () => {
    const priced = priceOrder(
      [{ offerId: 'OFR_1', offerVersion: 3, quantity: 1 }],
      catalogue(offer({ leadTimeDays: 0 })),
    );
    expect(priced.maxLeadTimeDays).toBe(0);
  });
});

describe('a zero-value order is refused', () => {
  it('never produces a total of zero', () => {
    // economic-service refuses a journal with no amount, so an order like this
    // would fail later in the saga with an error nobody could explain.
    expect(() =>
      priceOrder(
        [{ offerId: 'OFR_1', offerVersion: 3, quantity: 1 }],
        catalogue(offer({ unitPriceMinor: 0n })),
      ),
    ).toThrow(/positive total/);
  });
});

describe('derived totals stay within what can be stored (marketplace audit F4)', () => {
  const MAX = 9_223_372_036_854_775_807n;

  function refusal(run: () => unknown) {
    try {
      run();
    } catch (error) {
      if (!isRastaError(error)) throw error;
      return {
        code: error.code,
        status: error.status,
        message: error.message,
        details: error.details,
        internalContext: error.internalContext,
      };
    }
    throw new Error('expected a refusal');
  }

  it('prices a line whose total is exactly the largest storable amount', () => {
    const priced = priceOrder(
      [{ offerId: 'OFR_1', offerVersion: 3, quantity: 1 }],
      catalogue(offer({ unitPriceMinor: MAX })),
    );
    expect(priced.lines[0]?.lineTotalMinor).toBe(MAX);
    expect(priced.totalAmountMinor).toBe(MAX);
  });

  it('prices two lines that add up to exactly the largest storable amount', () => {
    const priced = priceOrder(
      [
        { offerId: 'OFR_1', offerVersion: 3, quantity: 1 },
        { offerId: 'OFR_2', offerVersion: 3, quantity: 1 },
      ],
      catalogue(
        offer({ id: 'OFR_1', unitPriceMinor: MAX - 1n }),
        offer({ id: 'OFR_2', productId: 'PRD_2', unitPriceMinor: 1n }),
      ),
    );
    expect(priced.totalAmountMinor).toBe(MAX);
  });

  it('refuses a line total one past the bound, naming the quantity and no figure', () => {
    // MAX + 1 = 2^63 is even: two units of half of it are exactly one past.
    const unit = (MAX + 1n) / 2n;
    const found = refusal(() =>
      priceOrder(
        [{ offerId: 'OFR_1', offerVersion: 3, quantity: 2 }],
        catalogue(offer({ unitPriceMinor: unit })),
      ),
    );
    expect(unit * 2n).toBe(MAX + 1n);
    expect(found).toEqual({
      code: 'BUSINESS_RULE_VIOLATION',
      status: 422,
      message: 'The order total exceeds the largest amount the platform can record',
      details: [
        {
          path: 'lines[0].quantity',
          code: 'ORDER_AMOUNT_EXCEEDS_LIMIT',
          message: 'The order total exceeds the largest amount the platform can record',
        },
      ],
      internalContext: undefined,
    });
  });

  it('refuses the audit trigger: the largest price times two', () => {
    const found = refusal(() =>
      priceOrder(
        [{ offerId: 'OFR_1', offerVersion: 3, quantity: 2 }],
        catalogue(offer({ unitPriceMinor: MAX })),
      ),
    );
    expect(found.details?.[0]).toMatchObject({
      path: 'lines[0].quantity',
      code: 'ORDER_AMOUNT_EXCEEDS_LIMIT',
    });
  });

  it('refuses lines that are each storable but sum one past the bound', () => {
    const found = refusal(() =>
      priceOrder(
        [
          { offerId: 'OFR_1', offerVersion: 3, quantity: 1 },
          { offerId: 'OFR_2', offerVersion: 3, quantity: 1 },
        ],
        catalogue(
          offer({ id: 'OFR_1', unitPriceMinor: MAX }),
          offer({ id: 'OFR_2', productId: 'PRD_2', unitPriceMinor: 1n }),
        ),
      ),
    );
    expect(found.details).toEqual([
      expect.objectContaining({ path: 'lines', code: 'ORDER_AMOUNT_EXCEEDS_LIMIT' }),
    ]);
    // No figure in any part of the refusal.
    expect(JSON.stringify(found)).not.toMatch(/\d{6,}/);
  });

  it('refuses a sum that passes the bound only on the third line', () => {
    const third = MAX / 3n + 1n;
    const found = refusal(() =>
      priceOrder(
        [
          { offerId: 'OFR_1', offerVersion: 3, quantity: 1 },
          { offerId: 'OFR_2', offerVersion: 3, quantity: 1 },
          { offerId: 'OFR_3', offerVersion: 3, quantity: 1 },
        ],
        catalogue(
          offer({ id: 'OFR_1', unitPriceMinor: third }),
          offer({ id: 'OFR_2', productId: 'PRD_2', unitPriceMinor: third }),
          offer({ id: 'OFR_3', productId: 'PRD_3', unitPriceMinor: third }),
        ),
      ),
    );
    expect(found.details?.[0]?.path).toBe('lines');
  });
});

describe('only at the offer version the buyer read (D-156)', () => {
  function refusal(run: () => unknown) {
    try {
      run();
    } catch (error) {
      if (!isRastaError(error)) throw error;
      return {
        code: error.code,
        status: error.status,
        message: error.message,
        details: error.details,
      };
    }
    throw new Error('expected a refusal');
  }

  it('prices a line that names the version the offer is at', () => {
    const priced = priceOrder(
      [{ offerId: 'OFR_1', offerVersion: 3, quantity: 2 }],
      catalogue(offer({ version: 3 })),
    );
    expect(priced.lines[0]).toMatchObject({ offerVersion: 3, unitPriceMinor: 250_000n });
  });

  it.each([
    ['older: the offer was repriced after the buyer read it', 2],
    ['newer: a version the offer has not reached', 4],
    ['far older', 1],
  ])('refuses a line naming a %s, with 409 and no figure', (_label, stale) => {
    const found = refusal(() =>
      priceOrder(
        [{ offerId: 'OFR_1', offerVersion: stale, quantity: 2 }],
        catalogue(offer({ version: 3, unitPriceMinor: 987_654_321n })),
      ),
    );
    expect(found.code).toBe('OPTIMISTIC_LOCK_FAILED');
    expect(found.status).toBe(409);
    expect(found.details).toEqual([
      {
        path: 'lines[0].offerVersion',
        code: 'OFFER_VERSION_CHANGED',
        message: 'The offer has changed since it was read; read it again before ordering',
      },
    ]);
    // Neither the price nor the version the offer is at now, anywhere (S-09).
    // The path is the caller's own index; every sentence is digit-free.
    expect(JSON.stringify(found)).not.toMatch(/987654321|987_654_321/);
    for (const text of [found.message, ...(found.details ?? []).map((d) => d.message)]) {
      expect(text).not.toMatch(/\d/);
    }
  });

  it('names the stale line by its index, and refuses even when only one line is stale', () => {
    const found = refusal(() =>
      priceOrder(
        [
          { offerId: 'OFR_1', offerVersion: 3, quantity: 1 },
          { offerId: 'OFR_2', offerVersion: 1, quantity: 1 },
        ],
        catalogue(offer(), offer({ id: 'OFR_2', productId: 'PRD_2', version: 2 })),
      ),
    );
    expect(found.details?.[0]?.path).toBe('lines[1].offerVersion');
  });

  it('answers 404 before the version for an offer the buyer may not read', () => {
    // The version check runs only on a published offer: a draft's or a
    // withdrawn offer's version is not the caller's to learn by probing.
    const found = refusal(() =>
      priceOrder(
        [{ offerId: 'OFR_1', offerVersion: 1, quantity: 1 }],
        catalogue(offer({ status: 'DRAFT', version: 5 })),
      ),
    );
    expect(found.code).toBe('NOT_FOUND');
  });
});
