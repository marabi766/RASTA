import { z } from 'zod';

/**
 * The events this service publishes.
 *
 * It published none for its whole life: it consumed `INSURANCE_EXPIRING`,
 * `INSPECTION_EXPIRING` and `MAINTENANCE_DUE`, turned them into notifications,
 * and that was the end of the story. `ADR-054 § 3` recorded why that became a
 * problem and refused to accept `NTF-002` until it was fixed:
 *
 *   > **این یک انحراف از قاعدهٔ الزام‌آور است، نه یک انتخاب دامنه.**
 *
 * Reading a notification, dismissing one and marking everything read are state
 * changes. `AGENTS.md` S-06 says every state-changing action produces an audit
 * record, and `audit-service` has exactly one input — the event log. A
 * structured log line, a metric and a write-once column are each useful and
 * none of them is an audit record in the sense that rule means. These three
 * events are.
 *
 * ## Why a person's own reading is worth recording at all
 *
 * Because the read state is evidence. An insurance policy expiring, an
 * inspection coming due, a machine overdue for service — the platform's
 * notifications are the record that somebody was told. "The operator was
 * notified on the 12th and opened it on the 14th" is a fact a dispute turns on,
 * and a fact the notification service alone should not be the sole keeper of.
 */

export const NOTIFICATION_EVENTS = {
  NOTIFICATION_READ: 'NOTIFICATION_READ',
  NOTIFICATION_DISMISSED: 'NOTIFICATION_DISMISSED',
  NOTIFICATION_ALL_READ: 'NOTIFICATION_ALL_READ',
} as const;

export type NotificationEventName = (typeof NOTIFICATION_EVENTS)[keyof typeof NOTIFICATION_EVENTS];

/**
 * Fields every one of these events carries.
 *
 * `userId` is the partition key as well as a payload field: one person's
 * transitions have to arrive in the order they happened, and Kafka orders
 * within a partition and nowhere else. A read that arrived after its own
 * dismissal would read as a rewind that never occurred.
 */
const actorFields = {
  organizationId: z.string(),
  /** Whose notification this is, and whose action this was — the same person.
   *  These endpoints act only on the caller's own rows (S-03). */
  userId: z.string(),
  /** When the transition was persisted, from the same clock as the row. */
  occurredAt: z.string(),
};

/**
 * Somebody opened a notification.
 *
 * Carries no title and no body. The notification's content is already in this
 * service's own table and, for the source fact, in the event that produced it;
 * copying it into a second durable log that every service reads would spread
 * the tenant's operational detail further than any consumer needs. The id is
 * enough to join back.
 */
export const notificationReadPayload = z.object({
  notificationId: z.string(),
  ...actorFields,
});

/** Somebody dismissed a notification. Dismissing implies reading (ADR-054 § 4). */
export const notificationDismissedPayload = z.object({
  notificationId: z.string(),
  /** True when this dismissal was also the first read of the row. */
  markedReadByDismissal: z.boolean(),
  ...actorFields,
});

/**
 * Somebody cleared their whole inbox.
 *
 * One event with a count rather than one per row. A person with two hundred
 * unread notifications would otherwise produce two hundred events for a single
 * click, which tells an auditor less than one event saying exactly that.
 */
export const notificationAllReadPayload = z.object({
  /** How many rows the single statement actually moved. Never zero — an
   *  action that changed nothing publishes nothing. */
  count: z.number().int().positive(),
  ...actorFields,
});

export const NOTIFICATION_EVENT_SCHEMAS = {
  [NOTIFICATION_EVENTS.NOTIFICATION_READ]: notificationReadPayload,
  [NOTIFICATION_EVENTS.NOTIFICATION_DISMISSED]: notificationDismissedPayload,
  [NOTIFICATION_EVENTS.NOTIFICATION_ALL_READ]: notificationAllReadPayload,
} as const satisfies Record<NotificationEventName, z.ZodTypeAny>;

/**
 * The aggregate each event is about.
 *
 * `NOTIFICATION_ALL_READ` is about the inbox, not about any one row, so its
 * aggregate is the person. Naming an arbitrary notification as its aggregate
 * would attach the whole action to a row that happened to be first.
 */
export const AGGREGATE_OF = {
  NOTIFICATION_READ: 'InAppNotification',
  NOTIFICATION_DISMISSED: 'InAppNotification',
  NOTIFICATION_ALL_READ: 'NotificationInbox',
} as const satisfies Record<NotificationEventName, string>;

/**
 * Validates before the payload reaches the outbox.
 *
 * Publish-time validation keeps a malformed event out of the log entirely
 * (`docs/07` § 7.8). The alternative is finding out in somebody's dead-letter
 * topic, after the transaction that should have refused it has committed.
 */
export function validateNotificationPayload<N extends NotificationEventName>(
  eventName: N,
  payload: unknown,
): z.infer<(typeof NOTIFICATION_EVENT_SCHEMAS)[N]> {
  const schema = NOTIFICATION_EVENT_SCHEMAS[eventName];
  return schema.parse(payload) as z.infer<(typeof NOTIFICATION_EVENT_SCHEMAS)[N]>;
}

/**
 * The Kafka key for an event.
 *
 * Always the recipient. Every event here is about one person's inbox, and that
 * is the story a consumer has to see in order.
 */
export function resolvePartitionKey(payload: { userId: string }): string {
  if (!payload.userId) {
    throw new Error(
      'Notification routing: resolved to an empty partition key. ' +
        'An event without a stream cannot be ordered or sequenced.',
    );
  }
  return payload.userId;
}
