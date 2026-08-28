import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
  type Metric,
} from 'prom-client';

/**
 * Prometheus metrics shared by every service.
 *
 * One rule governs every label below: **no unbounded cardinality**. A label
 * carrying `userId`, `orderId` or `assetId` creates a new time series per
 * value and will eventually take Prometheus down. Per-entity breakdowns belong
 * in analytics-service, against the database.
 *
 * Route labels use the *template* (`/v1/assets/:id`), never the concrete path,
 * for the same reason.
 */

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: 'rasta_' });

// ---- HTTP ------------------------------------------------------------------

export const httpRequestDuration = new Histogram({
  name: 'http_server_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status', 'service'] as const,
  // Buckets chosen around the p95 SLO of 300ms, with enough resolution above
  // it to distinguish "slightly slow" from "timing out".
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: 'http_server_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status', 'service'] as const,
  registers: [registry],
});

export const httpActiveRequests = new Gauge({
  name: 'http_server_active_requests',
  help: 'In-flight HTTP requests',
  labelNames: ['service'] as const,
  registers: [registry],
});

// ---- Database --------------------------------------------------------------

export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['service', 'model', 'operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

export const dbPoolConnections = new Gauge({
  name: 'db_pool_connections',
  help: 'Database pool connections by state',
  labelNames: ['service', 'state'] as const,
  registers: [registry],
});

// ---- Events ----------------------------------------------------------------

export const outboxPendingTotal = new Gauge({
  name: 'rasta_outbox_pending_total',
  help: 'Unpublished outbox rows',
  labelNames: ['service'] as const,
  registers: [registry],
});

/** Drives the stuck-relay alert. Threshold: 60 seconds. */
export const outboxPendingAgeSeconds = new Gauge({
  name: 'rasta_outbox_pending_age_seconds',
  help: 'Age of the oldest unpublished outbox row',
  labelNames: ['service'] as const,
  registers: [registry],
});

export const eventsPublishedTotal = new Counter({
  name: 'rasta_events_published_total',
  help: 'Domain events published',
  labelNames: ['service', 'topic', 'event_name'] as const,
  registers: [registry],
});

export const eventProcessingDuration = new Histogram({
  name: 'rasta_event_processing_duration_seconds',
  help: 'Event handler duration in seconds',
  labelNames: ['service', 'topic', 'event_name', 'outcome'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30],
  registers: [registry],
});

/** Any increase alerts. A DLQ message is never routine. */
export const dlqMessagesTotal = new Counter({
  name: 'rasta_dlq_messages_total',
  help: 'Messages sent to a dead-letter topic',
  labelNames: ['service', 'topic', 'reason'] as const,
  registers: [registry],
});

/** Any increase alerts: a schema violation means a contract was broken. */
export const eventValidationFailuresTotal = new Counter({
  name: 'rasta_event_validation_failures_total',
  help: 'Events that failed schema validation',
  labelNames: ['service', 'topic', 'event_name', 'phase'] as const,
  registers: [registry],
});

export const duplicateEventsTotal = new Counter({
  name: 'rasta_duplicate_events_total',
  help: 'Events skipped because they were already processed',
  labelNames: ['service', 'topic'] as const,
  registers: [registry],
});

// ---- Security --------------------------------------------------------------

/**
 * Authorization denials.
 *
 * A spike here is what tenant-boundary probing looks like, so the reason is
 * labelled while the actor deliberately is not — the actor would be unbounded
 * cardinality, and the audit log already records it.
 */
export const authorizationDenialsTotal = new Counter({
  name: 'rasta_authorization_denials_total',
  help: 'Requests denied by authorization',
  labelNames: ['service', 'reason', 'route'] as const,
  registers: [registry],
});

export const authenticationFailuresTotal = new Counter({
  name: 'rasta_authentication_failures_total',
  help: 'Requests rejected during authentication',
  labelNames: ['service', 'reason'] as const,
  registers: [registry],
});

// ---- Helpers ---------------------------------------------------------------

export async function metricsText(): Promise<string> {
  return registry.metrics();
}

export const metricsContentType = registry.contentType;

/** Registers a service-specific metric on the shared registry. */
export function register<T extends Metric>(metric: T): T {
  registry.registerMetric(metric);
  return metric;
}

/**
 * The metric constructors, re-exported.
 *
 * A service defining its own metric — fleet's assignment conflicts, for
 * instance — must build it from the *same* prom-client module instance that
 * created {@link registry}, or `registers: [registry]` hands a Registry from
 * one copy of the library a Metric from another. Re-exporting here makes that
 * the only thing a service can do, and keeps prom-client out of every
 * service's dependency list.
 *
 * Metric *definitions* stay with the service that owns them. This package
 * holds the mechanism, never another domain's counters (AGENTS.md A-03).
 */
export { Counter, Gauge, Histogram } from 'prom-client';
export type { Metric } from 'prom-client';

/**
 * Collapses a concrete path to its route template.
 *
 * `/v1/assets/AST_01JBQ8.../usage` becomes `/v1/assets/:id/usage`. Without
 * this, every asset id would create its own time series.
 */
export function normalizeRoute(path: string): string {
  return path
    .split('?')[0]!
    .split('/')
    .map((segment) => {
      if (segment.length === 0) return segment;
      if (/^[A-Z]{2,4}[-_][0-9A-HJKMNP-TV-Z]{26}$/.test(segment)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
        return ':id';
      }
      if (/^\d+$/.test(segment)) return ':id';
      return segment;
    })
    .join('/');
}
