import { Counter, Gauge, registry } from '@rasta/observability';
import { AGGREGATION_OUTCOMES } from '../security-events/refusal-aggregation';

/**
 * Refusal-audit telemetry (ADR-053 §§ 4, 13; AUD-004 Phase C1).
 *
 * Every label is drawn from a set fixed in code. None names a tenant, an actor,
 * a resource, an event, a correlation id, an IP address, a URL or an error
 * message: Prometheus is read by systems with none of the audit store's access
 * controls, and a label is an unbounded series the moment it carries a value.
 *
 * Gauges are sampled from the database, never kept by `inc`/`dec` — the same
 * rule the domain outbox gauges follow (ADR-050).
 */

/** How a capture attempt ended. */
export const SECURITY_EVENT_CAPTURE_OUTCOMES = {
  RECORDED: 'recorded',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  SKIPPED: 'skipped',
} as const;
export type SecurityEventCaptureOutcome =
  (typeof SECURITY_EVENT_CAPTURE_OUTCOMES)[keyof typeof SECURITY_EVENT_CAPTURE_OUTCOMES];

/** Why a claimed row was not published. */
export const SECURITY_EVENT_PUBLISH_FAILURE_REASONS = {
  CONTRACT_VIOLATION: 'contract_violation',
  PUBLISH_ERROR: 'publish_error',
} as const;
export type SecurityEventPublishFailureReason =
  (typeof SECURITY_EVENT_PUBLISH_FAILURE_REASONS)[keyof typeof SECURITY_EVENT_PUBLISH_FAILURE_REASONS];

/**
 * Refusal captures, by outcome. `failed` and `timeout` are refusals that were
 * returned without evidence: any sustained rate of either is an audit gap.
 */
export const securityEventCapturesTotal = new Counter({
  name: 'rasta_security_event_captures_total',
  help: 'Refusal audit capture attempts into security_event_outbox, by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/** How a recorded capture landed (AUD-004 Phase C2). Values: `AGGREGATION_OUTCOMES`. */
export const SECURITY_EVENT_AGGREGATION_RESULTS = AGGREGATION_OUTCOMES;

/**
 * Recorded captures by aggregation result. `created` against `incremented` is
 * the aggregation ratio; any `ceiling_reached` means one row reached the
 * INTEGER limit and a successor row was opened for the rest of its window.
 * A capture that timed out is in neither — its result was never confirmed.
 */
export const securityEventAggregationsTotal = new Counter({
  name: 'rasta_security_event_aggregations_total',
  help: 'Recorded refusal captures into security_event_outbox, by aggregation result',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const securityEventsPublishedTotal = new Counter({
  name: 'rasta_security_events_published_total',
  help: 'Refusal audit events acknowledged as published to rasta.audit.trail.v1',
  registers: [registry],
});

export const securityEventPublishFailuresTotal = new Counter({
  name: 'rasta_security_event_publish_failures_total',
  help: 'Refusal audit events that failed to publish and were scheduled for retry, by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

/** A lower bound on possible duplicate deliveries — never a count of duplicates (ADR-050). */
export const securityEventAckFencedTotal = new Counter({
  name: 'rasta_security_event_ack_fenced_total',
  help: 'security_event_outbox mutations refused because the claim token no longer matched',
  registers: [registry],
});

export const securityEventLeaseReclaimedTotal = new Counter({
  name: 'rasta_security_event_lease_reclaimed_total',
  help: 'security_event_outbox rows re-claimed from an expired lease',
  registers: [registry],
});

export const securityEventClaimAttemptsTotal = new Counter({
  name: 'rasta_security_event_claim_attempts_total',
  help: 'security_event_outbox rows claimed',
  registers: [registry],
});

export const securityEventOutboxPendingTotal = new Gauge({
  name: 'rasta_security_event_outbox_pending_total',
  help: 'Unpublished security_event_outbox rows',
  registers: [registry],
});

/**
 * Age of the oldest unpublished row, open window included. Since Phase C2 this
 * sits near the aggregation window by design — alert on the closed-window age
 * below, not on this.
 */
export const securityEventOutboxPendingAgeSeconds = new Gauge({
  name: 'rasta_security_event_outbox_pending_age_seconds',
  help: 'Age of the oldest unpublished security_event_outbox row, including rows whose window is still open',
  registers: [registry],
});

/** Rows still counting refusals: unpublished, window not yet closed. Not claimable. */
export const securityEventOutboxOpenWindows = new Gauge({
  name: 'rasta_security_event_outbox_open_windows',
  help: 'Unpublished security_event_outbox rows whose aggregation window is still open',
  registers: [registry],
});

/** Rows the relay may publish now: unpublished, window closed. */
export const securityEventOutboxClosedBacklogTotal = new Gauge({
  name: 'rasta_security_event_outbox_closed_backlog_total',
  help: 'Unpublished security_event_outbox rows whose aggregation window has closed',
  registers: [registry],
});

/**
 * Drives the audit-gap alert: how long the oldest claimable row has waited
 * since its window closed. Zero when nothing closed is waiting. Independent of
 * the window length, unlike the pending age above.
 */
export const securityEventOutboxClosedBacklogAgeSeconds = new Gauge({
  name: 'rasta_security_event_outbox_closed_backlog_age_seconds',
  help: 'Seconds since the aggregation window of the oldest unpublished, closed security_event_outbox row ended',
  registers: [registry],
});

export const securityEventOutboxLeasesActive = new Gauge({
  name: 'rasta_security_event_outbox_leases_active',
  help: 'security_event_outbox rows currently held under a live claim lease',
  registers: [registry],
});
