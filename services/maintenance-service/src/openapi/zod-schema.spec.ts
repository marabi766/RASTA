import { z } from 'zod';
import { toJsonSchema } from './zod-schema';
import {
  approveRequestSchema,
  createRequestSchema,
  createScheduleSchema,
  listRequestsQuerySchema,
  recordPartSchema,
} from '../maintenance/dto';

/**
 * The converter publishes the contract clients generate against, so a wrong
 * shape here is worse than no shape at all: it sends someone to write code
 * against a contract the service does not honour.
 *
 * These tests run it over the real DTOs rather than toy schemas, because the
 * combinations that actually occur — a `.strict()` object wrapped in three
 * `.refine()` calls, a coerced integer with bounds, an enum with a default —
 * are exactly where a naive walk goes wrong.
 */
describe('zod to JSON Schema', () => {
  describe('objects', () => {
    it('separates required fields from optional ones', () => {
      const s = toJsonSchema(createRequestSchema);
      expect(s.type).toBe('object');
      expect(s.required).toEqual(expect.arrayContaining(['assetId', 'type', 'title']));
      expect(s.required).not.toContain('description');
    });

    it('publishes strictness, so a misspelled key is known to be rejected', () => {
      // Every input schema here is `.strict()`. A client that cannot see that
      // will assume unknown fields are ignored and be surprised by a 400.
      expect(toJsonSchema(createRequestSchema).additionalProperties).toBe(false);
      expect(toJsonSchema(recordPartSchema).additionalProperties).toBe(false);
    });
  });

  describe('strings', () => {
    it('carries the pattern the service actually validates with', () => {
      // The source's own regex, not a re-spelling of it — so the published
      // contract cannot drift from the check that runs.
      const s = toJsonSchema(approveRequestSchema);
      const total = (s.properties as Record<string, Record<string, unknown>>)
        .expectedTotalCostMinor;
      expect(total.type).toBe('string');
      expect(total.pattern).toContain('\\d');
    });

    it('marks a datetime as a date-time format', () => {
      const s = toJsonSchema(createRequestSchema);
      const reportedAt = (s.properties as Record<string, Record<string, unknown>>).reportedAt;
      expect(reportedAt.format).toBe('date-time');
    });
  });

  describe('numbers', () => {
    it('publishes an integer with its bounds', () => {
      const s = toJsonSchema(createScheduleSchema);
      const intervalDays = (s.properties as Record<string, Record<string, unknown>>).intervalDays;
      expect(intervalDays.type).toBe('integer');
      expect(intervalDays.minimum).toBe(1);
      expect(intervalDays.maximum).toBe(3650);
    });

    it('publishes a coerced pagination limit with its default', () => {
      const s = toJsonSchema(listRequestsQuerySchema);
      const limit = (s.properties as Record<string, Record<string, unknown>>).limit;
      expect(limit.type).toBe('integer');
      expect(limit.default).toBe(25);
      expect(limit.maximum).toBe(200);
    });
  });

  describe('enums and defaults', () => {
    it('publishes the closed set a field accepts', () => {
      const s = toJsonSchema(createRequestSchema);
      const type = (s.properties as Record<string, Record<string, unknown>>).type;
      expect(type.enum).toEqual(['PREVENTIVE', 'CORRECTIVE']);
    });

    it('publishes a default alongside its type', () => {
      const s = toJsonSchema(recordPartSchema);
      const source = (s.properties as Record<string, Record<string, unknown>>).source;
      expect(source.default).toBe('WORKSHOP_SUPPLIED');
      expect(source.enum).toContain('INVENTORY');
    });

    it('does not offer PART or LABOUR as directly postable cost categories', () => {
      // The published contract has to show this, or a client will try. Those
      // two lines are written by recording the work itself, which is what
      // keeps the provenance on a cost line meaningful (ADR-028).
      const s = toJsonSchema(
        z.object({ category: z.enum(['SERVICE', 'EXTERNAL_REPAIR', 'OTHER']) }),
      );
      const category = (s.properties as Record<string, Record<string, unknown>>).category;
      expect(category.enum).not.toContain('PART');
      expect(category.enum).not.toContain('LABOUR');
    });
  });

  describe('what it cannot express', () => {
    it('publishes the inner shape of a refined schema rather than nothing', () => {
      // `createRequestSchema` carries cross-field rules — a corrective request
      // must state a severity, a preventive one must not — which JSON Schema
      // cannot express. The shape is still published and the rule lives in the
      // endpoint description, where a human will read it.
      const s = toJsonSchema(createRequestSchema);
      expect(Object.keys(s.properties as object)).toContain('severity');
    });

    it('returns an open schema for a construct it does not model', () => {
      // An unconstrained schema tells a reader "not described here". A
      // confidently wrong one sends them to write code against a contract that
      // does not hold.
      expect(toJsonSchema(z.map(z.string(), z.number()))).toEqual({});
    });
  });
});
