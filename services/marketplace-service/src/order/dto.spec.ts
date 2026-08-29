import {
  createOrderSchema,
  listOrdersQuerySchema,
  raiseDisputeSchema,
  submitReviewSchema,
} from './dto';
import { createOfferSchema, searchProductsQuerySchema, updateOfferSchema } from '../offer/dto';

/**
 * The request schemas, tested as the security boundary they are.
 *
 * `createOrderSchema` is the one that matters most: it is `.strict()` and has
 * no price field, so a client that sends one is **refused** rather than having
 * it silently ignored (ADR-037 § 5). That is a structural property — there is
 * no code path that could use a client price, because the parsed object has
 * nowhere to put one — and these tests are what keep it structural.
 */

describe('an order request cannot carry a price', () => {
  const valid = { lines: [{ offerId: 'OFR_1', quantity: 2 }] };

  it('accepts an offer id and a quantity', () => {
    const parsed = createOrderSchema.parse(valid);
    expect(parsed.lines[0]).toEqual({ offerId: 'OFR_1', quantity: 2 });
  });

  it.each([
    ['unitPriceMinor', { unitPriceMinor: '1' }],
    ['lineTotalMinor', { lineTotalMinor: '1' }],
    ['price', { price: 1 }],
  ])('refuses a line carrying %s', (_name, extra) => {
    // Refused, not stripped. Stripping is quiet, and a client that believes it
    // sets the price would go on believing it.
    const result = createOrderSchema.safeParse({
      lines: [{ offerId: 'OFR_1', quantity: 1, ...extra }],
    });
    expect(result.success).toBe(false);
  });

  it('refuses a total at the top level too', () => {
    expect(createOrderSchema.safeParse({ ...valid, totalAmountMinor: '1' }).success).toBe(false);
  });

  it('refuses a supplier chosen by the client', () => {
    // Which supplier an order belongs to is derived from the offers, not
    // asserted by the buyer.
    expect(createOrderSchema.safeParse({ ...valid, supplierOrganizationId: 'ORG-X' }).success).toBe(
      false,
    );
  });

  it('refuses a status the client would like the order to be in', () => {
    expect(createOrderSchema.safeParse({ ...valid, status: 'COMPLETED' }).success).toBe(false);
  });
});

describe('order quantities', () => {
  it('refuses zero, a negative, and a fraction', () => {
    for (const quantity of [0, -1, 1.5]) {
      expect(createOrderSchema.safeParse({ lines: [{ offerId: 'OFR_1', quantity }] }).success).toBe(
        false,
      );
    }
  });

  it('refuses an order with no lines', () => {
    expect(createOrderSchema.safeParse({ lines: [] }).success).toBe(false);
  });

  it('caps the number of lines, so one request cannot lock a thousand offers', () => {
    const lines = Array.from({ length: 51 }, (_, i) => ({ offerId: `OFR_${i}`, quantity: 1 }));
    expect(createOrderSchema.safeParse({ lines }).success).toBe(false);
  });
});

describe('a dispute needs a reason somebody can act on', () => {
  it('refuses a one-word complaint', () => {
    // A dispute stops settlement indefinitely. Whoever resolves it needs to
    // know what it is about, and a one-word reason is how a dispute becomes
    // permanent by neglect.
    expect(raiseDisputeSchema.safeParse({ reason: 'bad' }).success).toBe(false);
  });

  it('accepts a sentence', () => {
    expect(
      raiseDisputeSchema.safeParse({ reason: 'the delivered part does not match the offer' })
        .success,
    ).toBe(true);
  });
});

describe('a review is a score out of five', () => {
  it.each([0, 6, 2.5, -1])('refuses %s', (rating) => {
    expect(submitReviewSchema.safeParse({ rating }).success).toBe(false);
  });

  it('accepts one through five', () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      expect(submitReviewSchema.safeParse({ rating }).success).toBe(true);
    }
  });
});

describe('listing orders names which side the caller is asking about', () => {
  it('defaults to the buyer’s own orders', () => {
    expect(listOrdersQuerySchema.parse({}).role).toBe('BUYER');
  });

  it('accepts the supplier side explicitly', () => {
    // Explicit rather than inferred from the role: an organization can be both,
    // and guessing would silently return the wrong list.
    expect(listOrdersQuerySchema.parse({ role: 'SUPPLIER' }).role).toBe('SUPPLIER');
  });

  it('refuses a third side', () => {
    expect(listOrdersQuerySchema.safeParse({ role: 'PLATFORM' }).success).toBe(false);
  });

  it('caps the page size', () => {
    expect(listOrdersQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
    expect(listOrdersQuerySchema.parse({ limit: 100 }).limit).toBe(100);
  });
});

describe('search refuses a sort it cannot honestly perform', () => {
  it('accepts price and lead time', () => {
    for (const sort of ['PRICE_ASC', 'PRICE_DESC', 'LEAD_TIME_ASC']) {
      expect(searchProductsQuerySchema.safeParse({ sort }).success).toBe(true);
    }
  });

  it('refuses RATING, because supplier-service does not exist', () => {
    // Accepting it and ordering by price instead would tell the client its
    // ordering had been applied (ADR-042 § 2).
    expect(searchProductsQuerySchema.safeParse({ sort: 'RATING' }).success).toBe(false);
  });

  it('defaults to cheapest first', () => {
    expect(searchProductsQuerySchema.parse({}).sort).toBe('PRICE_ASC');
  });
});

describe('an offer price is a minor-unit string', () => {
  const valid = {
    productId: 'PRD_1',
    unitPriceMinor: '250000',
    availableQuantity: 10,
    leadTimeDays: 3,
  };

  it('accepts a string', () => {
    expect(createOfferSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses a JSON number', () => {
    // A rial figure past Number.MAX_SAFE_INTEGER does not survive the round
    // trip, and the truncation happens in the client's parser (ADR-022).
    expect(createOfferSchema.safeParse({ ...valid, unitPriceMinor: 250000 }).success).toBe(false);
  });

  it('refuses a decimal', () => {
    expect(createOfferSchema.safeParse({ ...valid, unitPriceMinor: '2500.5' }).success).toBe(false);
  });

  it('defaults to a draft, so publishing is a decision', () => {
    expect(createOfferSchema.parse(valid).publish).toBe(false);
  });
});

describe('an offer update must change something', () => {
  it('refuses an empty patch', () => {
    expect(updateOfferSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a repricing alone', () => {
    expect(updateOfferSchema.safeParse({ unitPriceMinor: '9000' }).success).toBe(true);
  });

  it('refuses a version the client picked', () => {
    // The version is incremented by the service on a repricing; letting a
    // client set it would break the link an OrderLine records.
    expect(updateOfferSchema.safeParse({ unitPriceMinor: '1', version: 9 }).success).toBe(false);
  });
});
