import { Counter, Gauge, registry } from '@rasta/observability';

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

/** Drives the audit-gap alert: refusals that have not reached the audit trail. */
export const securityEventOutboxPendingAgeSeconds = new Gauge({
  name: 'rasta_security_event_outbox_pending_age_seconds',
  help: 'Age of the oldest unpublished security_event_outbox row',
  registers: [registry],
});

export const securityEventOutboxLeasesActive = new Gauge({
  name: 'rasta_security_event_outbox_leases_active',
  help: 'security_event_outbox rows currently held under a live claim lease',
  registers: [registry],
});
