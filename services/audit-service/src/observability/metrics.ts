import { Counter, Gauge, registry } from '@rasta/observability';

/**
 * AUD-001 ingestion telemetry.
 *
 * ## The one rule every label here obeys
 *
 * ADR-053 § 13 draws a line no metric crosses: **nothing identifying becomes a
 * label**. No user, organization, actor, resource, event or correlation id. Not
 * because of cardinality alone — though an organization label on a
 * multi-tenant platform is an unbounded series — but because Prometheus is
 * scraped by, retained by and alerted on from systems with none of the audit
 * store's access controls. A metric naming an organization leaks the tenant
 * list to everyone who can read the dashboard.
 *
 * Every label below is drawn from a set fixed at deploy time: the ten topics
 * this service subscribes to, the services that produce them, and three
 * outcome values. That is what makes them safe.
 */

/** Rows written, by where they came from. */
export const auditRecordsIngestedTotal = new Counter({
  name: 'rasta_audit_records_ingested_total',
  help: 'Audit rows written by the domain projector',
  // `source_service` and `source_topic` are both bounded by deployment: nine
  // producing services, ten subscribed topics. `outcome` is the enum.
  labelNames: ['source_service', 'source_topic', 'outcome'] as const,
  registers: [registry],
});

/**
 * How far behind the domain the store is, in seconds.
 *
 * `recordedAt - occurredAt` for the row just written. This is the number that
 * says whether the audit trail is a live record or a historical one, and it is
 * the only reason both timestamps exist as separate columns.
 *
 * A gauge rather than a histogram because the question during an incident is
 * "how stale is it right now", not "what was the distribution last week".
 */
export const auditIngestionLagSeconds = new Gauge({
  name: 'rasta_audit_ingestion_lag_seconds',
  help: 'Seconds between a domain event occurring and its audit row being written',
  labelNames: ['source_topic'] as const,
  registers: [registry],
});

/**
 * Ingestion failures, by a bounded reason.
 *
 * `reason` is a closed set defined in `IngestionFailureReason`, never an error
 * message: a message can contain a row value, and a metric is the last place a
 * value should reach.
 */
export const auditIngestionFailuresTotal = new Counter({
  name: 'rasta_audit_ingestion_failures_total',
  help: 'Audit ingestion attempts that did not produce a row',
  labelNames: ['reason'] as const,
  registers: [registry],
});

/**
 * Rows per partition — day-one capacity evidence (ADR-053 § 11).
 *
 * The ADR pre-builds eighteen months of partitions and states that an audit
 * partition is never dropped, only moved to cold storage. Neither claim can be
 * acted on without knowing how full the partitions actually are, so this is
 * day-one rather than later: the first time anyone asks "when do we need more
 * partitions", the answer has to already be measurable.
 *
 * `partition` is bounded by the migration — nineteen names, fixed at deploy.
 *
 * Sampled from a query, never maintained by `inc`. An arithmetic gauge drifts
 * on every restart and every missed error path, and a drifting capacity number
 * is worse than none.
 */
export const auditPartitionRows = new Gauge({
  name: 'rasta_audit_partition_rows',
  help: 'Approximate row count per audit_event partition',
  labelNames: ['partition'] as const,
  registers: [registry],
});

/** The closed set of ingestion failure reasons. */
export const INGESTION_FAILURE_REASONS = {
  /** The envelope parsed but could not be mapped to a record. */
  UNMAPPABLE_ENVELOPE: 'unmappable_envelope',
  /** The database refused or was unreachable. */
  DATABASE_ERROR: 'database_error',
} as const;

export type IngestionFailureReason =
  (typeof INGESTION_FAILURE_REASONS)[keyof typeof INGESTION_FAILURE_REASONS];
