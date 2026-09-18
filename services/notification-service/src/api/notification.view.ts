import { z } from 'zod';
import type { InAppNotification } from '../generated/prisma';
import { IN_APP_STATES, type InAppState } from './notification.dto';

/**
 * What a caller sees of their own in-app notification — the published shape
 * and the single serialiser that produces it.
 *
 * ## What is deliberately absent
 *
 *   userId, organizationId   the caller's own; repeating them would say
 *                            nothing and would be the first thing to leak if
 *                            a query ever widened.
 *   deliveryId, intentId     delivery telemetry (ADR-054 § 14). A person is
 *                            told *what*, not how the platform got it to them.
 *   any address, any name    never stored in this service; nothing to omit.
 *
 * `state` is derived from the timestamps every time (ADR-054 § 4): a stored
 * copy could disagree with the facts it summarises.
 */

export const inAppStateSchema = z.enum(IN_APP_STATES);

export const notificationViewSchema = z
  .object({
    id: z.string(),
    state: inAppStateSchema,
    ruleKey: z.string(),
    severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
    classification: z.enum(['ROUTINE', 'MANDATORY']),
    subjectType: z.string(),
    subjectId: z.string(),
    title: z.string(),
    body: z.string(),
    /** Origin-relative path the web app resolves, or null. Never an absolute URL. */
    actionPath: z.string().nullable(),
    /** Domain time of the event that caused this notification. */
    occurredAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    readAt: z.string().datetime().nullable(),
    dismissedAt: z.string().datetime().nullable(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type NotificationView = z.infer<typeof notificationViewSchema>;

export const notificationPageSchema = z
  .object({
    items: z.array(notificationViewSchema),
    /** Echo back as `cursor` for the next page; null when this is the last. */
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();

export type NotificationPage = z.infer<typeof notificationPageSchema>;

export const unreadCountSchema = z
  .object({
    /** Unread, undismissed, unexpired rows — capped, never a full COUNT(*). */
    count: z.number().int().min(0),
    /** True when the real number is at least the cap and `count` is the cap. */
    capped: z.boolean(),
  })
  .strict();

export type UnreadCount = z.infer<typeof unreadCountSchema>;

export const readAllResultSchema = z
  .object({
    /** How many rows this call moved from UNREAD to READ. */
    updated: z.number().int().min(0),
  })
  .strict();

export type ReadAllResult = z.infer<typeof readAllResultSchema>;

export function stateOf(row: Pick<InAppNotification, 'readAt' | 'dismissedAt'>): InAppState {
  if (row.dismissedAt !== null) return 'DISMISSED';
  if (row.readAt !== null) return 'READ';
  return 'UNREAD';
}

export function toNotificationView(row: InAppNotification): NotificationView {
  return {
    id: row.id,
    state: stateOf(row),
    ruleKey: row.ruleKey,
    severity: row.severity,
    classification: row.classification,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    title: row.title,
    body: row.body,
    actionPath: row.actionPath,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}
