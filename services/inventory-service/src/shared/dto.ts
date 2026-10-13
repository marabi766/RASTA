import { z } from 'zod';

/**
 * The shapes several resources share. The same Zod schemas validate input, type the code and —
 * through `zod-schema.ts` — become the OpenAPI document, so the three cannot disagree.
 */

/** The ULID alphabet (Crockford base32), as every id here is `<PREFIX>_<ULID>`. */
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';

export const warehouseIdSchema = z
  .string()
  .regex(new RegExp(`^WHS_${ULID}$`))
  .describe('A warehouse of the organization the request acts for.');

export const stockItemIdSchema = z
  .string()
  .regex(new RegExp(`^SKI_${ULID}$`))
  .describe('A stock item of the organization the request acts for.');

/** Marketplace's product, referenced opaquely and never resolved here (ADR-056 § 1, Q-105). */
export const productIdSchema = z
  .string()
  .regex(new RegExp(`^PRD_${ULID}$`))
  .describe(
    'The marketplace product, `PRD_<ULID>`: an opaque reference this service never resolves ' +
      '(Q-105). Quantities are counted in its base unit; there is no unit-of-measure field.',
  );

/** An opaque reference to another service's order, purchase order or adjustment document. */
export const sourceReferenceSchema = z
  .string()
  .regex(new RegExp(`^(ORD|PO|ADJ)_${ULID}$`))
  .describe(
    'Optional opaque reference — `ORD_`, `PO_` or `ADJ_` followed by a ULID — to the document ' +
      'this movement comes from. Never resolved here; carried on the movement and its event.',
  );

/** The largest quantity the database stores (`integer`). */
export const MAX_QUANTITY = 2_147_483_647;

export const quantitySchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_QUANTITY)
  .describe('A positive whole number of the product’s base unit (Q-105).');

export const expectedVersionSchema = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(
    'The `version` the caller read. When given, the command applies only to that version ' +
      '(409 OPTIMISTIC_LOCK_FAILED otherwise).',
  );

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** A page from `limit + 1` rows ordered by id, newest first: the cursor is the last id shown. */
export function pageOf<R extends { id: string }, V>(
  rows: R[],
  limit: number,
  view: (row: R) => V,
): CursorPage<V> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(view),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    hasMore,
  };
}
