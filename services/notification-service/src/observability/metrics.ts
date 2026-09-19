import { Counter, Gauge, registry } from '@rasta/observability';

/**
 * NTF-001 intake and dedupe telemetry — the subset of ADR-054 § 12 this story
 * owns. The delivery-duration histogram, the queue gauges and the circuit
 * state belong to the email channel and its worker (NTF-004/005).
 *
 * ## The one rule every label obeys
 *
 * `docs/13` § 13.3: **no high-cardinality label, and nothing identifying.** No
 * `userId`, no `organizationId`, no `assetId`, no address. Every label below
 * is drawn from a set fixed at deploy time — the rule catalogue, the channel
 * enum, a closed list of reasons. `metric-cardinality.spec.ts` asserts it.
 */

export const notificationIntentsTotal = new Counter({
  name: 'rasta_notification_intents_total',
  help: 'Notification intents created from consumed domain events',
  labelNames: ['event_name', 'rule_key'] as const,
  registers: [registry],
});

export const notificationDeliveriesTotal = new Counter({
  name: 'rasta_notification_deliveries_total',
  help: 'Delivery rows by channel and the status they reached',
  labelNames: ['channel', 'status'] as const,
  registers: [registry],
});

/**
 * Repeats inside a semantic window. A steep climb on one rule is a badly
 * tuned rule, which is why `rule_key` is the label and why the number is
 * exported at all (ADR-054 § 3).
 */
export const notificationDedupedTotal = new Counter({
  name: 'rasta_notification_deduped_total',
  help: 'Events suppressed because the same fact was already notified in this window',
  labelNames: ['rule_key'] as const,
  registers: [registry],
});

export const notificationSuppressedTotal = new Counter({
  name: 'rasta_notification_suppressed_total',
  help: 'Intents that reached a terminal SUPPRESSED state, by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const notificationDiscardedTotal = new Counter({
  name: 'rasta_notification_intents_discarded_total',
  help: 'Intents recorded as DISCARDED, by reason (a stale stream sequence, today)',
  labelNames: ['reason'] as const,
  registers: [registry],
});

/** Every increase is an alert: a rule fanning out past the ceiling (ADR § 1). */
export const notificationRecipientTruncatedTotal = new Counter({
  name: 'rasta_notification_recipient_truncated_total',
  help: 'Intents whose recipient list was cut at NOTIFICATION_MAX_RECIPIENTS_PER_INTENT',
  labelNames: ['rule_key'] as const,
  registers: [registry],
});

export const notificationResolutionFailuresTotal = new Counter({
  name: 'rasta_notification_recipient_resolution_failures_total',
  help: 'Recipient resolution attempts that did not complete, by bounded reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const notificationPoisonEventsTotal = new Counter({
  name: 'rasta_notification_poison_events_total',
  help: 'Consumed messages refused as unprocessable, by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const notificationContextKeysDroppedTotal = new Counter({
  name: 'rasta_notification_context_keys_dropped_total',
  help: 'Payload keys refused by the context allowlist at ingest',
  labelNames: ['rule_key'] as const,
  registers: [registry],
});

/**
 * Sampled from the table, never maintained by inc/dec (ADR § 12): an
 * arithmetic gauge drifts on every restart and every missed error path.
 */
export const notificationIntentsPending = new Gauge({
  name: 'rasta_notification_intents_pending',
  help: 'Intents waiting for recipient resolution',
  registers: [registry],
});

export const notificationOldestPendingAgeSeconds = new Gauge({
  name: 'rasta_notification_oldest_pending_intent_age_seconds',
  help: 'Age of the oldest intent still waiting for recipient resolution',
  registers: [registry],
});

/** Bounded reason vocabularies, so no label is ever built from a message. */
export const SUPPRESSION_REASONS = {
  NO_ELIGIBLE_RECIPIENT: 'NO_ELIGIBLE_RECIPIENT',
  RULE_UNKNOWN: 'RULE_UNKNOWN',
  /**
   * The person asked not to receive this (NTF-003).
   *
   * Unlike the two above, this suppresses one *delivery* rather than the whole
   * intent: the notification was produced and the other recipients still get
   * it. One bounded value rather than one per winning layer — the label is a
   * metric dimension and the column is a `VARCHAR(64)`. Which rung of the
   * ladder decided belongs in the preferences API, where a person can ask
   * about their own settings, not in a counter anyone can scrape.
   */
  PREFERENCE_OPT_OUT: 'PREFERENCE_OPT_OUT',
} as const;

export const DISCARD_REASONS = {
  STALE_STREAM_SEQ: 'STALE_STREAM_SEQ',
} as const;

export const RESOLUTION_FAILURE_REASONS = {
  UNREACHABLE: 'UNREACHABLE',
  TIMEOUT: 'TIMEOUT',
  REFUSED: 'REFUSED',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  LEASE_LOST: 'LEASE_LOST',
} as const;

export type ResolutionFailureReason =
  (typeof RESOLUTION_FAILURE_REASONS)[keyof typeof RESOLUTION_FAILURE_REASONS];

/**
 * NTF-002. State changes a person makes to their own in-app rows, by kind.
 * `transition` is a closed three-value set; no id, no user, no tenant.
 */
export const notificationInAppTransitionsTotal = new Counter({
  name: 'rasta_notification_in_app_transitions_total',
  help: 'In-app notification state transitions made through the read API',
  labelNames: ['transition'] as const,
  registers: [registry],
});

export const IN_APP_TRANSITIONS = {
  READ: 'READ',
  DISMISSED: 'DISMISSED',
  READ_ALL: 'READ_ALL',
} as const;
