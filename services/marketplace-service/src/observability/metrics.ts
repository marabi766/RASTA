import { Counter, Gauge, Histogram, registry } from '@rasta/observability';

/**
 * Metrics owned by marketplace-service.
 *
 * Only the ones answering a question an operator will actually ask. The
 * platform-wide series — outbox lag, HTTP latency, authorization denials — are
 * already defined in `@rasta/observability` and are not duplicated here.
 *
 * Two rules, inherited from economic-service and load-bearing for the same
 * reasons.
 *
 * **No unbounded cardinality.** Nothing is labelled by `organizationId`,
 * `orderId` or `userId`. A per-tenant breakdown belongs in analytics-service,
 * against the database, under authorization — not in a scrape anyone on the
 * monitoring network can read (AGENTS.md S-09).
 *
 * **No metric is a total of money.** There is no gauge of order value. A
 * cross-tenant money total should not be readable from an unauthenticated
 * scrape, and a Prometheus counter is a float — feeding rial amounts into one
 * would reintroduce in the observability layer exactly the precision loss
 * ADR-022 removed from the domain. Counts of *orders* are safe; sums of
 * *money* are not.
 */

export const ordersCreatedTotal = new Counter({
  name: 'rasta_marketplace_orders_created_total',
  help: 'Orders placed',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * Order state transitions, by destination.
 *
 * The single most useful series here: it answers "are orders completing, and
 * if not where do they stop" without any per-order label.
 */
export const orderTransitionsTotal = new Counter({
  name: 'rasta_marketplace_order_transitions_total',
  help: 'Order state transitions, by destination status',
  labelNames: ['service', 'to'] as const,
  registers: [registry],
});

/**
 * Return-request state transitions, by destination status (RUN-005). Bounded labels: the status
 * set is closed by the database CHECK, and no request id is ever a label.
 */
export const returnTransitionsTotal = new Counter({
  name: 'rasta_marketplace_return_transitions_total',
  help: 'Return request state transitions, by destination status',
  labelNames: ['service', 'to'] as const,
  registers: [registry],
});

/**
 * What the return mirror did with each inventory-service return event (RUN-005 PR 3): `applied`,
 * `duplicate` (already applied), `stale` (an earlier step of a request already past it), `ahead`
 * (a later step before the one it follows; retried, then dead-lettered) or `refused` (dead-
 * lettered at once). A closed set; the event is the inventory event's name.
 */
export const returnMirrorEventsTotal = new Counter({
  name: 'rasta_marketplace_return_mirror_events_total',
  help: 'Inventory return events mirrored onto return requests, by event and result',
  labelNames: ['service', 'event', 'result'] as const,
  registers: [registry],
});

/** Return commands refused for a business rule, by which rule (a closed set, see ReturnService). */
export const returnRefusalsTotal = new Counter({
  name: 'rasta_marketplace_return_refusals_total',
  help: 'Return commands refused for a business rule, by reason',
  labelNames: ['service', 'reason'] as const,
  registers: [registry],
});

/**
 * Orders refused for a business rule, by which rule.
 *
 * Separate from HTTP 4xx because the interesting question is *which* rule: a
 * spike in `INSUFFICIENT_AVAILABILITY` is a catalogue problem, a spike in
 * `ILLEGAL_TRANSITION` is a client integrating incorrectly.
 */
export const orderRefusalsTotal = new Counter({
  name: 'rasta_marketplace_order_refusals_total',
  help: 'Order commands refused, by reason',
  labelNames: ['service', 'reason'] as const,
  registers: [registry],
});

/**
 * Orders past a configured window and still waiting (ADR-043).
 *
 * The metric that makes "no automatic receipt confirmation" operable rather
 * than merely safe. Nothing closes an overdue order automatically, so the only
 * way an unconfirmed delivery gets attention is for somebody to see this
 * number. Labelled by status, so "waiting for the supplier" and "waiting for
 * the buyer" are distinguishable.
 */
export const ordersOverdue = new Gauge({
  name: 'rasta_marketplace_orders_overdue',
  help: 'Orders past their configured window and still awaiting a human decision',
  labelNames: ['service', 'status'] as const,
  registers: [registry],
});

/** Reminders recorded. Never an assertion that anybody was notified. */
export const remindersRecordedTotal = new Counter({
  name: 'rasta_marketplace_reminders_recorded_total',
  help: 'Overdue reminders recorded on orders — a record, not a delivered notification',
  labelNames: ['service', 'status'] as const,
  registers: [registry],
});

export const disputesRaisedTotal = new Counter({
  name: 'rasta_marketplace_disputes_raised_total',
  help: 'Disputes raised, which stop settlement completely',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * Calls to economic-service, by operation and outcome.
 *
 * This service's only outbound dependency, and the one whose failure leaves
 * orders stuck. `outcome` separates a refusal (the call worked, the answer was
 * no) from a failure (the call did not work), because they need different
 * responses from an operator.
 */
export const economicCallsTotal = new Counter({
  name: 'rasta_marketplace_economic_calls_total',
  help: 'Calls to economic-service, by operation and outcome',
  labelNames: ['service', 'operation', 'outcome'] as const,
  registers: [registry],
});

export const economicCallDuration = new Histogram({
  name: 'rasta_marketplace_economic_call_duration_seconds',
  help: 'Latency of calls to economic-service',
  labelNames: ['service', 'operation'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * Settlements that exhausted their retries (ADR-039 § 5).
 *
 * `docs/08` § 8.4 forbids automatic financial compensation after receipt
 * confirmation, so an exhausted settlement waits for a human. This counter is
 * how that human finds out. It should be flat at zero, and any increment is an
 * incident rather than a statistic.
 */
export const settlementsExhaustedTotal = new Counter({
  name: 'rasta_marketplace_settlements_exhausted_total',
  help: 'Orders whose settlement exhausted its retries and now await a human decision',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * Rounds of a dispute release economic-service has not confirmed (FU-080): the
 * obligation stays DISPUTED and the funds held until it does. Rounds need a
 * worker, so no alert reads this; `sagaUnconfirmedCalls` is the state (FU-104).
 */
export const releasesUnconfirmedTotal = new Counter({
  name: 'rasta_marketplace_saga_release_unconfirmed_total',
  help: 'Rounds of a saga dispute release that economic-service has not confirmed',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * Decided disputes whose release economic-service has not confirmed for longer
 * than a call can take, from `saga_unconfirmed_call`, by operation: a closed set
 * of activity names. Sampled by the API process, so no worker or saga is needed
 * (FU-104).
 */
export const sagaUnconfirmedCalls = new Gauge({
  name: 'rasta_marketplace_saga_unconfirmed_calls',
  help: 'Saga economic calls due and still not confirmed, past the time a call can take',
  labelNames: ['service', 'operation'] as const,
  registers: [registry],
});

/** When that count was last read: a count that stopped being read says nothing. */
export const sagaUnconfirmedCallsReadAt = new Gauge({
  name: 'rasta_marketplace_saga_unconfirmed_calls_read_timestamp_seconds',
  help: 'When the count of unconfirmed saga calls was last read from the database',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * By the database clock, the last read that found the operation's calls unconfirmed,
 * and the last that found none. Their order is what clears the release alert, so a
 * zero read earlier than a positive one clears nothing, whichever replica read it,
 * and neither needs the replica to still be there (#769 r1 F1). Only a read moves them.
 */
export const sagaUnconfirmedCallsSeenAt = new Gauge({
  name: 'rasta_marketplace_saga_unconfirmed_calls_seen_timestamp_seconds',
  help: 'When a read of saga_unconfirmed_call last found calls unconfirmed, by the database clock',
  labelNames: ['service', 'operation'] as const,
  registers: [registry],
});

export const sagaUnconfirmedCallsClearedAt = new Gauge({
  name: 'rasta_marketplace_saga_unconfirmed_calls_cleared_timestamp_seconds',
  help: 'When a read of saga_unconfirmed_call last found no call unconfirmed, by the database clock',
  labelNames: ['service', 'operation'] as const,
  registers: [registry],
});

/** Zero only for a deployment that states it runs no worker (`MARKETPLACE_SAGA_WORKER_EXPECTED`). */
export const sagaWorkerExpected = new Gauge({
  name: 'rasta_marketplace_saga_worker_expected',
  help: 'Whether this deployment expects an order saga worker on the queue',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * The older of Temporal's last workflow poll and last activity poll on the saga's
 * task queue, by Temporal's own clock. Moves only on that proof, so anything
 * that prevents the proof reads as a worker that is not polling (FU-104).
 */
export const sagaWorkerLastPoll = new Gauge({
  name: 'rasta_marketplace_saga_worker_last_poll_timestamp_seconds',
  help: 'When Temporal last saw a worker poll both task types of the order saga queue',
  labelNames: ['service'] as const,
  registers: [registry],
});

export const idempotentReplaysTotal = new Counter({
  name: 'rasta_marketplace_idempotent_replays_total',
  help: 'Requests answered from a stored idempotent response instead of re-executing',
  labelNames: ['service', 'endpoint'] as const,
  registers: [registry],
});

/** Product searches, by whether the caller supplied free text (ADR-042). */
export const productSearchesTotal = new Counter({
  name: 'rasta_marketplace_product_searches_total',
  help: 'Catalogue searches, by whether a text query was used',
  labelNames: ['service', 'mode'] as const,
  registers: [registry],
});

/** Durable starter backlog; no tenant/order labels or monetary values. */
export const sagaStartBacklogCount = new Gauge({
  name: 'rasta_marketplace_saga_start_backlog',
  help: 'Orders awaiting proven saga acceptance',
  labelNames: ['service'] as const,
  registers: [registry],
});
export const sagaStartBacklogAge = new Gauge({
  name: 'rasta_marketplace_saga_start_backlog_age_seconds',
  help: 'Age of oldest undelivered saga start intent',
  labelNames: ['service'] as const,
  registers: [registry],
});
export const sagaStartDeliveries = new Counter({
  name: 'rasta_marketplace_saga_start_deliveries_total',
  help: 'Saga start delivery attempts by fixed outcome',
  labelNames: ['service', 'outcome'] as const,
  registers: [registry],
});
