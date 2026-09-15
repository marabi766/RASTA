import {
  OutboxRelay,
  type EventPublisher,
  type OutboxRelayOptions,
  type OutboxStore,
  type RetryBackoff,
} from '@rasta/nest-common';
import {
  securityEventAckFencedTotal,
  securityEventClaimAttemptsTotal,
  securityEventLeaseReclaimedTotal,
  securityEventPublishFailuresTotal,
  securityEventsPublishedTotal,
  SECURITY_EVENT_PUBLISH_FAILURE_REASONS,
} from '../observability/security-event.metrics';
import { AuditTrailContractError } from './audit-trail-envelope';
import { AuditTrailPublisher } from './audit-trail.publisher';

/** The DI token for the refusal relay — distinct from the domain `OutboxRelay`. */
export const SECURITY_EVENT_RELAY = Symbol('IDENTITY_SECURITY_EVENT_RELAY');

export interface SecurityEventRelayOptions {
  store: OutboxStore;
  /** The raw broker publisher. Wrapped here in contract validation. */
  publisher: EventPublisher;
  pollIntervalMs: number;
  batchSize: number;
  leaseSeconds: number;
  backoff: RetryBackoff;
  shutdownGraceSeconds: number;
  logger?: OutboxRelayOptions['logger'];
  /** Test seams only. */
  owner?: string;
  now?: () => number;
}

/**
 * The refusal flusher (ADR-053 § 4): the platform `OutboxRelay`, a second
 * instance, over `security_event_outbox` instead of `outbox_message`.
 *
 * Reusing the relay is the point rather than a shortcut. Its claim, lease
 * renewal, token-fenced acknowledgement, per-row fallback, capped backoff and
 * bounded shutdown are exactly ADR-050's, already proven in `@rasta/nest-common`,
 * and none of it knows what an audit event is — so the refusal queue gets the
 * same delivery semantics as the domain outbox without a second implementation
 * of them, and the relay stays free of identity or audit logic (A-03).
 *
 * What is specific to this queue is all on the edges: the store (this
 * service's table), the publisher (contract validation in front of Kafka) and
 * the counters (their own series, so a stuck refusal queue is never hidden
 * behind a healthy domain outbox).
 */
export function createSecurityEventRelay(options: SecurityEventRelayOptions): OutboxRelay {
  return new OutboxRelay({
    store: options.store,
    publisher: new AuditTrailPublisher(options.publisher),
    pollIntervalMs: options.pollIntervalMs,
    batchSize: options.batchSize,
    leaseSeconds: options.leaseSeconds,
    backoff: options.backoff,
    shutdownGraceSeconds: options.shutdownGraceSeconds,
    logger: options.logger,
    ...(options.owner !== undefined ? { owner: options.owner } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    onBatchPublished: (count) => securityEventsPublishedTotal.inc(count),
    onPublishFailed: (_row, error) =>
      securityEventPublishFailuresTotal.inc({
        reason:
          error instanceof AuditTrailContractError
            ? SECURITY_EVENT_PUBLISH_FAILURE_REASONS.CONTRACT_VIOLATION
            : SECURITY_EVENT_PUBLISH_FAILURE_REASONS.PUBLISH_ERROR,
      }),
    onFenced: (count) => securityEventAckFencedTotal.inc(count),
    onReclaimed: (count) => securityEventLeaseReclaimedTotal.inc(count),
    onClaimAttempt: (count) => securityEventClaimAttemptsTotal.inc(count),
  });
}
