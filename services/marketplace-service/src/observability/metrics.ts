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
