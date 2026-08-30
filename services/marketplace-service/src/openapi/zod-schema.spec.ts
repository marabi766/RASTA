import { z } from 'zod';
import { toJsonSchema } from './zod-schema';
import { createOrderSchema, listOrdersQuerySchema, submitReviewSchema } from '../order/dto';
import { createOfferSchema, searchProductsQuerySchema, updateOfferSchema } from '../offer/dto';

/**
 * The converter publishes the contract clients generate against, so a wrong
 * shape here is worse than no shape at all: it sends someone to write code
 * against a contract the service does not honour.
 *
 * Run over the real DTOs rather than toy schemas, because the combinations
 * that actually occur — a `.strict()` object wrapped in a `.refine()`, a
 * coerced number with bounds, an array of nested objects with a minimum length
 * — are exactly where a naive walk goes wrong.
 */
describe('zod to JSON Schema', () => {
  describe('objects', () => {
    it('separates required fields from optional ones', () => {
      const s = toJsonSchema(createOrderSchema);
      expect(s.type).toBe('object');
      // `lines` is required: an order without them has nothing to price.
      expect(s.required).toEqual(['lines']);
      expect(Object.keys(s.properties as object)).toEqual(
        expect.arrayContaining(['lines', 'note']),
      );
    });

    it('publishes strictness, so a misspelled key is known to be rejected', () => {
      // Every input schema here is `.strict()`, and on `createOrderSchema` that
      // is a security property rather than tidiness: a client sending a price
      // is refused, not ignored (ADR-037 § 5). A client that cannot see the
      // strictness will assume unknown fields are dropped.
      expect(toJsonSchema(createOrderSchema).additionalProperties).toBe(false);
      expect(toJsonSchema(createOfferSchema).additionalProperties).toBe(false);
    });

    it('publishes no price field on an order, because none is accepted', () => {
      const props = toJsonSchema(createOrderSchema).properties as Record<string, unknown>;
      expect(props).not.toHaveProperty('unitPriceMinor');
      expect(props).not.toHaveProperty('totalAmountMinor');
    });
  });

  describe('strings', () => {
    it('carries length bounds', () => {
      const props = toJsonSchema(createOfferSchema).properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.productId).toMatchObject({ type: 'string', minLength: 1, maxLength: 64 });
    });

    it('carries the pattern actually enforced, not a re-spelling of it', () => {
      // Taken from the source regex, so the published pattern cannot drift
      // from the one that runs.
      const s = toJsonSchema(z.object({ q: z.string().regex(/^\d+(\.\d{1,2})?$/) }));
      const props = s.properties as Record<string, Record<string, unknown>>;
      expect(props.q.pattern).toBe('^\\d+(\\.\\d{1,2})?$');
    });

    it('carries a date-time format', () => {
      const s = toJsonSchema(z.object({ at: z.string().datetime() }));
      const props = s.properties as Record<string, Record<string, unknown>>;
      expect(props.at).toMatchObject({ type: 'string', format: 'date-time' });
    });
  });

  describe('numbers', () => {
    it('distinguishes integers and carries bounds', () => {
      const props = toJsonSchema(listOrdersQuerySchema).properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
    });

    it('records a default rather than hiding it', () => {
      const props = toJsonSchema(listOrdersQuerySchema).properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.limit.default).toBe(25);
      expect(props.role.default).toBe('BUYER');
    });

    it('publishes the rating bounds a review is checked against', () => {
      const props = toJsonSchema(submitReviewSchema).properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.rating).toMatchObject({ type: 'integer', minimum: 1, maximum: 5 });
    });
  });

  describe('wrappers', () => {
    it('unwraps optional without losing the inner shape', () => {
      const s = toJsonSchema(z.object({ a: z.string().max(5).optional() }));
      const props = s.properties as Record<string, Record<string, unknown>>;
      expect(props.a).toMatchObject({ type: 'string', maxLength: 5 });
      expect(s.required).toBeUndefined();
    });

    it('marks nullable and keeps the inner type', () => {
      const s = toJsonSchema(z.object({ a: z.string().nullable() }));
      const props = s.properties as Record<string, Record<string, unknown>>;
      expect(props.a).toMatchObject({ type: 'string', nullable: true });
    });

    it('sees through refine() to the shape underneath', () => {
      // `updateOfferSchema` is `.strict()` then refined to require at least one
      // field. A walk that stopped at the effect would publish an empty object
      // for the repricing endpoint.
      const s = toJsonSchema(updateOfferSchema);
      expect(s.type).toBe('object');
      expect(Object.keys(s.properties as object)).toEqual(
        expect.arrayContaining(['unitPriceMinor', 'availableQuantity', 'leadTimeDays', 'status']),
      );
    });

    it('describes an array and the objects inside it', () => {
      const props = toJsonSchema(createOrderSchema).properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.lines).toMatchObject({ type: 'array', minItems: 1, maxItems: 50 });

      const items = props.lines.items as Record<string, unknown>;
      expect(items.type).toBe('object');
      expect(Object.keys(items.properties as object)).toEqual(['offerId', 'quantity']);
    });
  });

  describe('enums', () => {
    it('publishes the allowed values', () => {
      const props = toJsonSchema(searchProductsQuerySchema).properties as Record<
        string,
        Record<string, unknown>
      >;
      // `RATING` is deliberately absent — supplier-service does not exist, and
      // publishing a sort the service refuses would send a client to build
      // against it (ADR-042 § 2).
      expect(props.sort).toMatchObject({
        type: 'string',
        enum: ['PRICE_ASC', 'PRICE_DESC', 'LEAD_TIME_ASC'],
      });
      expect(props.sort.enum as string[]).not.toContain('RATING');
    });

    it('publishes a boolean', () => {
      const props = toJsonSchema(createOfferSchema).properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.publish).toMatchObject({ type: 'boolean', default: false });
    });
  });

  describe('what it cannot express', () => {
    it('returns an open schema rather than a wrong one', () => {
      // An unconstrained schema reads as "not described here". A confidently
      // wrong one sends a client to build against a contract that does not
      // hold, which is the failure worth avoiding.
      expect(toJsonSchema(z.date())).toEqual({});
      expect(toJsonSchema(z.unknown())).toEqual({});
    });

    it('does not pretend to carry cross-field rules', () => {
      // "at least one field must change" lives in a refine() and has no JSON
      // Schema equivalent, so it stays in the endpoint description where a
      // human reads it. What must not happen is the shape being lost.
      const s = toJsonSchema(updateOfferSchema);
      expect(s.required).toBeUndefined();
      expect(Object.keys(s.properties as object).length).toBeGreaterThan(0);
    });
  });

  describe('over every DTO the document publishes', () => {
    it('produces an object schema with properties for each', () => {
      for (const schema of [
        createOrderSchema,
        createOfferSchema,
        updateOfferSchema,
        submitReviewSchema,
        listOrdersQuerySchema,
        searchProductsQuerySchema,
      ]) {
        const s = toJsonSchema(schema);
        expect(s.type).toBe('object');
        expect(Object.keys(s.properties as object).length).toBeGreaterThan(0);
      }
    });
  });
});
