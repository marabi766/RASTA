import { z } from 'zod';
import { toJsonSchema } from './zod-schema';
import {
  createAssignmentSchema,
  createDriverSchema,
  listUsageQuerySchema,
  recordUsageSchema,
} from '../fleet/dto';

/**
 * The converter publishes the contract clients generate against, so a wrong
 * shape here is worse than no shape at all: it sends someone to write code
 * against a contract the service does not honour.
 *
 * These tests run it over the real DTOs rather than toy schemas, because the
 * combinations that actually occur — a `.strict()` object wrapped in two
 * `.refine()` calls, a coerced number with bounds, a nullable-with-default —
 * are exactly where a naive walk goes wrong.
 */
describe('zod to JSON Schema', () => {
  describe('objects', () => {
    it('separates required fields from optional ones', () => {
      const s = toJsonSchema(createDriverSchema);
      expect(s.type).toBe('object');
      // `userId` is required precisely because object-level authorization
      // resolves through it; publishing it as optional would invite a client
      // to omit it.
      expect(s.required).toEqual(['userId']);
      expect(Object.keys(s.properties as object)).toEqual(
        expect.arrayContaining(['userId', 'employeeNo', 'licenceNumber', 'notes']),
      );
    });

    it('publishes strictness, so a misspelled key is known to be rejected', () => {
      // Every input schema here is `.strict()`. A client that cannot see that
      // will assume unknown fields are ignored and be surprised by a 400.
      expect(toJsonSchema(createDriverSchema).additionalProperties).toBe(false);
    });
  });

  describe('strings', () => {
    it('carries length bounds and formats', () => {
      const props = toJsonSchema(createDriverSchema).properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.employeeNo).toMatchObject({ type: 'string', minLength: 1, maxLength: 64 });
      expect(props.licenceValidTo).toMatchObject({ type: 'string', format: 'date-time' });
    });

    it('carries the pattern actually enforced, not a re-spelling of it', () => {
      // Taken from the source regex, so the published pattern cannot drift
      // from the one that runs.
      const s = toJsonSchema(z.object({ q: z.string().regex(/^\d+(\.\d{1,2})?$/) }));
      const props = s.properties as Record<string, Record<string, unknown>>;
      expect(props.q.pattern).toBe('^\\d+(\\.\\d{1,2})?$');
    });
  });

  describe('numbers', () => {
    it('distinguishes integers and carries bounds', () => {
      const props = toJsonSchema(listUsageQuerySchema).properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 200 });
    });

    it('records a default rather than hiding it', () => {
      const props = toJsonSchema(listUsageQuerySchema).properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.limit.default).toBe(25);
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
      // `recordUsageSchema` is `.strict()` then refined twice. A walk that
      // stopped at the effect would publish an empty object for the busiest
      // write endpoint on the service.
      const s = toJsonSchema(recordUsageSchema);
      expect(s.type).toBe('object');
      expect(Object.keys(s.properties as object)).toEqual(
        expect.arrayContaining(['assetId', 'hours', 'kilometres', 'clientReference']),
      );
    });
  });

  describe('enums', () => {
    it('publishes the allowed values', () => {
      const props = toJsonSchema(recordUsageSchema).properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.source).toMatchObject({
        type: 'string',
        enum: ['MANUAL', 'TELEMATICS', 'IMPORTED'],
      });
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
      // "at least one of hours or kilometres" lives in a refine() and has no
      // JSON Schema equivalent, so it stays in the endpoint description where
      // a human reads it. What must not happen is the shape being lost.
      const s = toJsonSchema(recordUsageSchema);
      const props = s.properties as Record<string, unknown>;
      expect(props.hours).toBeDefined();
      expect(props.kilometres).toBeDefined();
      expect(s.required).not.toContain('hours');
    });
  });

  describe('over every DTO the document publishes', () => {
    it('produces an object schema with properties for each', () => {
      for (const schema of [createDriverSchema, createAssignmentSchema, recordUsageSchema]) {
        const s = toJsonSchema(schema);
        expect(s.type).toBe('object');
        expect(Object.keys(s.properties as object).length).toBeGreaterThan(0);
      }
    });
  });
});
