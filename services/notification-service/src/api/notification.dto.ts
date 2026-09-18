import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@rasta/contracts';

/**
 * The request shapes of the notification read API (ADR-054 § 11).
 *
 * Every schema is `.strict()`: an unknown parameter is refused rather than
 * ignored, so a misspelled filter is a 400 and never a silently wider — or
 * narrower — answer. `organizationId` is deliberately not a parameter
 * anywhere; scope comes from the verified token (ADR-054 § 11: "a caller who
 * names the tenant is defect D-2").
 */

/**
 * The visible states of an in-app row, derived from its timestamps and never
 * stored (ADR-054 § 4).
 */
export const IN_APP_STATES = ['UNREAD', 'READ', 'DISMISSED'] as const;
export type InAppState = (typeof IN_APP_STATES)[number];

/**
 * Which rows a listing returns.
 *
 *   omitted     everything that is not dismissed — the inbox.
 *   UNREAD      not read and not dismissed.
 *   READ        read and not dismissed.
 *   DISMISSED   dismissed (which implies read), the "archive".
 *
 * Expired rows are never returned by any filter: `EXPIRED` is hidden by
 * default and removed by the retention sweep (NTF-005), never shown.
 */
export const listNotificationsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE)
      .describe(`Page size. Defaults to ${DEFAULT_PAGE_SIZE}; above ${MAX_PAGE_SIZE} is refused.`),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Opaque position from the previous page’s `nextCursor`.'),
    state: z
      .enum(IN_APP_STATES)
      .optional()
      .describe('UNREAD, READ or DISMISSED. Omitted: every non-dismissed row.'),
  })
  .strict();

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

/** The in-app row identifier — a prefixed ULID this service minted. */
export const notificationIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z_-]+$/, 'A notification id is a prefixed ULID');

/** `/read-all` takes no parameters; the schema exists so an unknown one is refused. */
export const readAllQuerySchema = z.object({}).strict();

/** The hard ceiling the unread badge reports (ADR-054 § 4). */
export const UNREAD_COUNT_CAP = 99;
