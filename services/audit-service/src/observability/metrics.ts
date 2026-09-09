import { Counter, Gauge, Histogram, registry } from '@rasta/observability';

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
  /**
   * An organization event this service projects for authorization did not
   * match the fields the projection depends on (AUD-002).
   *
   * Separate from `unmappable_envelope` because the two need different
   * responses: an envelope this store cannot map is a producer contract
   * problem, while this one means the hierarchy behind `UNION_ADMIN` scoping
   * has stopped advancing, and a subtree decision that stops advancing is a
   * security control that stops advancing.
   */
  UNMAPPABLE_ORGANIZATION_EVENT: 'unmappable_organization_event',
} as const;

export type IngestionFailureReason =
  (typeof INGESTION_FAILURE_REASONS)[keyof typeof INGESTION_FAILURE_REASONS];

// ---------------------------------------------------------------------------
// AUD-002 query telemetry
//
// Same rule as above, and it bites harder here: these labels describe a
// *search*, and a search is about somebody. `organization`, `actor`,
// `resource` and `correlation` are absent from every label set below, and the
// closed sets that remain are fixed at deploy time -- two endpoints, two scope
// widths, three outcomes, three subtree decisions.
// ---------------------------------------------------------------------------

/** The two read endpoints. A closed set, so a safe label. */
export const QUERY_ENDPOINTS = {
  SEARCH: 'search',
  DETAIL: 'detail',
} as const;

/** What a query did. Never an error message, which can carry a value. */
export const QUERY_OUTCOMES = {
  OK: 'ok',
  NOT_FOUND: 'not_found',
} as const;

/** How a subtree request was decided. */
export const SUBTREE_DECISIONS = {
  /** The target is the caller's own organization; the token settled it. */
  OWN_ORGANIZATION: 'own_organization',
  /** The projection proved the target is a descendant of the caller's root. */
  DESCENDANT: 'descendant',
  /**
   * Refused. Deliberately one bucket for every reason -- sibling, stranger,
   * moved out, deactivated, no projection at all. Splitting them would publish
   * the shape of the hierarchy to anyone who can read a dashboard, and would
   * let a caller distinguish "does not exist" from "exists elsewhere" by
   * watching a counter move.
   */
  REFUSED: 'refused',
} as const;

export const auditQueriesTotal = new Counter({
  name: 'rasta_audit_queries_total',
  help: 'Audit read requests that reached the query service',
  labelNames: ['endpoint', 'scope', 'outcome'] as const,
  registers: [registry],
});

/**
 * How many rows a search returned.
 *
 * A histogram rather than a counter of rows: the operational question is
 * whether somebody is paging the store out in maximum-sized pages, and a
 * distribution answers that while a total does not. Buckets stop at the
 * configured page maximum, because nothing can exceed it.
 */
export const auditQueryRowsReturned = new Histogram({
  name: 'rasta_audit_query_rows_returned',
  help: 'Rows returned by one audit search',
  labelNames: ['endpoint'] as const,
  buckets: [0, 1, 5, 25, 50, 100, 200],
  registers: [registry],
});

export const auditSubtreeDecisionsTotal = new Counter({
  name: 'rasta_audit_subtree_decisions_total',
  help: 'Subtree authorization decisions taken from the local organization projection',
  labelNames: ['decision'] as const,
  registers: [registry],
});
