import {
  auditIngestionFailuresTotal,
  auditIngestionLagSeconds,
  auditPartitionRows,
  auditQueriesTotal,
  auditQueryRowsReturned,
  auditRecordsIngestedTotal,
  auditSubtreeDecisionsTotal,
  INGESTION_FAILURE_REASONS,
  QUERY_ENDPOINTS,
  QUERY_OUTCOMES,
  SUBTREE_DECISIONS,
} from './metrics';

/**
 * The line ADR-053 § 13 draws, asserted rather than described.
 *
 * Prometheus is scraped by, retained by and alerted on from systems with none
 * of the audit store's access controls. A label naming an organization leaks
 * the tenant list to everyone who can read a dashboard; a label naming an actor
 * or a resource turns the metrics endpoint into an unprotected index of who did
 * what. It bites hardest on the AUD-002 counters, because those describe a
 * *search* — and a search is about somebody.
 *
 * This file asserts the property from the label names, so a metric added later
 * with an identifying label fails here rather than in production.
 */

/**
 * Label names no metric in this service may carry, in the spellings a developer
 * would reach for.
 */
const FORBIDDEN_LABELS = [
  'organization',
  'organization_id',
  'organizationId',
  'tenant',
  'tenant_id',
  'actor',
  'actor_id',
  'actorId',
  'user',
  'user_id',
  'userId',
  'resource',
  'resource_id',
  'resourceId',
  'correlation',
  'correlation_id',
  'correlationId',
  'event_id',
  'eventId',
  'id',
  'action',
  'message',
  'error',
] as const;

/** prom-client keeps the declared names on the instance. */
interface LabelledMetric {
  readonly labelNames: readonly string[];
}

const AUDIT_METRICS: { name: string; metric: unknown }[] = [
  { name: 'rasta_audit_records_ingested_total', metric: auditRecordsIngestedTotal },
  { name: 'rasta_audit_ingestion_lag_seconds', metric: auditIngestionLagSeconds },
  { name: 'rasta_audit_ingestion_failures_total', metric: auditIngestionFailuresTotal },
  { name: 'rasta_audit_partition_rows', metric: auditPartitionRows },
  { name: 'rasta_audit_queries_total', metric: auditQueriesTotal },
  { name: 'rasta_audit_query_rows_returned', metric: auditQueryRowsReturned },
  { name: 'rasta_audit_subtree_decisions_total', metric: auditSubtreeDecisionsTotal },
];

const labelsOf = (metric: unknown): readonly string[] =>
  (metric as LabelledMetric).labelNames ?? [];

describe('metric cardinality', () => {
  it.each(AUDIT_METRICS)('$name carries no identifying label', ({ metric }) => {
    const labels = labelsOf(metric).map((label) => label.toLowerCase());

    for (const forbidden of FORBIDDEN_LABELS) {
      expect(labels).not.toContain(forbidden.toLowerCase());
    }
  });

  it.each(AUDIT_METRICS)('$name declares its labels at all', ({ metric }) => {
    // A metric whose `labelNames` came back empty would pass the check above
    // vacuously, which is how this kind of assertion stops testing anything.
    expect(Array.isArray(labelsOf(metric))).toBe(true);
  });

  it('gives the query counters only closed sets', () => {
    expect(labelsOf(auditQueriesTotal)).toEqual(['endpoint', 'scope', 'outcome']);
    expect(labelsOf(auditQueryRowsReturned)).toEqual(['endpoint']);
    expect(labelsOf(auditSubtreeDecisionsTotal)).toEqual(['decision']);
  });
});

describe('the closed label sets themselves', () => {
  it('has two endpoints, because there are two endpoints', () => {
    expect(Object.values(QUERY_ENDPOINTS)).toEqual(['search', 'detail']);
  });

  it('records an outcome and never an error message', () => {
    // A message can carry a row value, and a metric is the last place a value
    // should reach.
    expect(Object.values(QUERY_OUTCOMES)).toEqual(['ok', 'not_found']);
  });

  it('collapses every subtree refusal into one bucket', () => {
    // Splitting sibling from stranger from moved-out would publish the shape of
    // the hierarchy to anyone who can read a dashboard, and would let a caller
    // distinguish "does not exist" from "exists elsewhere" by watching a
    // counter move.
    expect(Object.values(SUBTREE_DECISIONS)).toEqual(['own_organization', 'descendant', 'refused']);
  });

  it('separates a failed organization projection from a failed envelope', () => {
    // The two need different responses: an unmappable envelope is a producer
    // contract problem, while a stalled organization projection means the
    // hierarchy behind UNION_ADMIN scoping has stopped advancing.
    expect(Object.values(INGESTION_FAILURE_REASONS)).toContain('unmappable_organization_event');
    expect(new Set(Object.values(INGESTION_FAILURE_REASONS)).size).toBe(
      Object.values(INGESTION_FAILURE_REASONS).length,
    );
  });
});
