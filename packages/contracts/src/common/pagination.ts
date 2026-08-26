import { z } from 'zod';

/**
 * Uniform list semantics for every collection endpoint on the platform.
 *
 * Rasta uses **cursor pagination** for anything that can grow without bound
 * (assets, orders, ledger entries, audit events) because offset pagination
 * silently skips or duplicates rows when the underlying set changes between
 * pages — unacceptable for a ledger. Page/offset is offered only where the
 * total count is itself the point (admin tables, dashboards).
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

export const cursorPaginationSchema = z.object({
  /** Opaque, server-issued. Clients must not construct or parse it. */
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type CursorPagination = z.infer<typeof cursorPaginationSchema>;

export const offsetPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type OffsetPagination = z.infer<typeof offsetPaginationSchema>;

export const sortDirectionSchema = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

/**
 * Builds a `sort` query schema restricted to the fields a given endpoint
 * actually indexes. Free-form sorting is not offered: an unindexed sort on a
 * multi-million-row table is a denial-of-service vector.
 */
export function sortSchema<const T extends readonly [string, ...string[]]>(sortableFields: T) {
  return z.object({
    sortBy: z.enum(sortableFields).optional(),
    sortDir: sortDirectionSchema.default('desc'),
  });
}

export interface CursorPage<T> {
  items: T[];
  /** Cursor to pass as `cursor` for the next page; null when exhausted. */
  nextCursor: string | null;
  hasMore: boolean;
}

export interface OffsetPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export function emptyCursorPage<T>(): CursorPage<T> {
  return { items: [], nextCursor: null, hasMore: false };
}
