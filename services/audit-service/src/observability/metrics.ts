import { AUDIT_OUTCOMES, AUDIT_TRAIL_TOPIC } from '@rasta/contracts';
import { Counter, Gauge, Histogram, registry } from '@rasta/observability';
import { DOMAIN_TOPICS } from '../audit/audit.mapper';
import { sourceTopicsOf, type AuditSourceService } from '../audit/audit-producer-topology';
import { DIVERGENCE_REASON_VALUES } from '../audit/audit.verification.view';

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
 * Every label below is drawn from a set fixed at deploy time: the eleven topics
 * this service subscribes to, the services that produce them, and three
 * outcome values. That is what makes them safe.
 */

/**
 * Rows written, by where they came from.
 *
 * `source_service` is **not** the envelope's `producer` string. That string is
 * producer-authored and only length-bounded, so used raw it would let any
 * publisher mint a series per distinct value. The consumers derive the label
 * from `audit-producer-topology.ts` instead — the delivery topic's owner when
 * the producer agrees (path A), a known trail producer (path B), otherwise
 * `unknown` — so it takes at most ten values (`AUDIT_SOURCE_SERVICE_LABELS`).
 * `source_topic` is the delivery topic, eleven values. `outcome` is the
 * three-value enum. The stored row still keeps the producer's own claim.
 */
export const auditRecordsIngestedTotal = new Counter({
  name: 'rasta_audit_records_ingested_total',
  help: 'Audit rows written by the domain projector',
  labelNames: ['source_service', 'source_topic', 'outcome'] as const,
  registers: [registry],
});

/**
 * The producers this deployment says must keep contributing rows.
 *
 * An info metric: `1` for each service named in
 * `AUDIT_EXPECTED_ACTIVE_PRODUCERS`, and no series at all for anything else.
 * `RastaAuditProducerSilent` joins on it, so a producer that nobody has declared
 * traffic-expected can be quiet forever without an alert — which is the only
 * honest default while no document says which services must emit continuously
 * (`docs/24-open-questions.md` Q-54). Its only label is the closed
 * `source_service` set; `unknown` is never a valid value.
 */
export const auditExpectedActiveProducer = new Gauge({
  name: 'rasta_audit_expected_active_producer',
  help: 'Set to 1 for each audit producer configured as traffic-expected (AUDIT_EXPECTED_ACTIVE_PRODUCERS)',
  labelNames: ['source_service'] as const,
  registers: [registry],
});

/**
 * Upper bounds, in seconds, of the ingestion lag histogram's buckets.
 *
 * `60` is an exact boundary because ADR-053 § 13 alerts on p95 > 60 seconds,
 * and `histogram_quantile` interpolates inside a bucket: without a bound at 60
 * the alert would be comparing against a guess. Below it, 1–30 separates "live"
 * from "a retry or two behind"; above it, 2, 5 and 15 minutes and an hour show
 * how far a stalled consumer has fallen before Kafka retention becomes the
 * risk. Past an hour the answer is the `+Inf` bucket prom-client adds, and the
 * broker-side offset lag says how much is waiting. Nine bounds plus `+Inf`, per
 * topic: a bounded, fixed series count.
 */
export const AUDIT_INGESTION_LAG_BUCKETS: readonly number[] = Object.freeze([
  1, 5, 15, 30, 60, 120, 300, 900, 3600,
]);

/**
 * How far behind the domain the store is, in seconds.
 *
 * `recordedAt - occurredAt` for each row written. This is the number that
 * says whether the audit trail is a live record or a historical one, and it is
 * the only reason both timestamps exist as separate columns.
 *
 * A histogram, as ADR-053 § 13 specifies: the alert is on the p95 over a
 * window, and a gauge holding only the last row written cannot answer that —
 * one fast record after a slow minute would overwrite the evidence. Observed
 * only for a row actually written, never for a duplicate or a failure.
 */
export const auditIngestionLagSeconds = new Histogram({
  name: 'rasta_audit_ingestion_lag_seconds',
  help: 'Seconds between a domain event occurring and its audit row being written',
  labelNames: ['source_topic'] as const,
  buckets: [...AUDIT_INGESTION_LAG_BUCKETS],
  registers: [registry],
});

/**
 * Every `source_topic` this service writes rows from: the ten path-A domain
 * topics and the path-B trail topic. Derived, never restated, so a topic added
 * to a subscription is exported here with it.
 */
export const AUDIT_INGESTION_SOURCE_TOPICS: readonly string[] = Object.freeze([
  ...DOMAIN_TOPICS,
  AUDIT_TRAIL_TOPIC,
]);

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

  // AUD-004 Phase B — a path-B message the audit-trail consumer refuses to
  // record. Five values rather than one because each points an operator at a
  // different fix, and none of them names anybody: the tenant, the actor and
  // the event stay in the (redacted) log line and the dead-letter copy.

  /** The envelope itself did not parse. */
  TRAIL_INVALID_ENVELOPE: 'trail_invalid_envelope',
  /** It parsed, but is not `AUDIT_EVENT_RECORDED` v1 delivered on the trail topic. */
  TRAIL_UNSUPPORTED_EVENT: 'trail_unsupported_event',
  /** The payload failed the v1 contract or a bound of the column it would fill. */
  TRAIL_INVALID_PAYLOAD: 'trail_invalid_payload',
  /**
   * `payload.organizationId` and `envelope.tenantId` did not agree.
   *
   * Its own reason because it is the one rejection that is a tenant-isolation
   * signal rather than a formatting one: a producer that disagrees with itself
   * about whose record this is must never have either answer picked for it.
   */
  TRAIL_TENANT_MISMATCH: 'trail_tenant_mismatch',
  /** A `changes` entry for a `SENSITIVE_KEYS` field carried a raw value. */
  TRAIL_UNREDACTED_SENSITIVE_CHANGE: 'trail_unredacted_sensitive_change',
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

// ---------------------------------------------------------------------------
// AUD-003 chain telemetry
//
// The same rule again, and here it needs restating rather than assuming: a
// divergence metric is the one place where somebody will be tempted to add an
// organization label, because the first question during an incident is "whose
// chain". It is still refused. A counter naming the tenant whose evidence looks
// altered publishes both the tenant list and an accusation to everyone who can
// read the dashboard, and the answer belongs in the verification response,
// behind the authorization that response already carries (ADR-053 § 13).
// ---------------------------------------------------------------------------

/** How a verification ended. A closed set, so a safe label. */
export const VERIFICATION_OUTCOMES = {
  VALID: 'valid',
  DIVERGENT: 'divergent',
  EMPTY: 'empty',
  UNVERIFIABLE_LEGACY: 'unverifiable_legacy',
} as const;

/** Which chain family was verified. Two values, fixed at compile time. */
export const VERIFICATION_SCOPE_LABELS = {
  ORGANIZATION: 'organization',
  PLATFORM: 'platform',
} as const;

/**
 * Integrity divergences found by verification — the metric ADR-053 § 6 names.
 *
 * **Incremented only for a real divergence.** Not for an empty window, not for
 * a window that turned out to hold pre-AUD-003 records, and not for a refusal:
 * each of those is a normal answer, and a counter that moved for them would
 * make the one alert that must never be ignored the one that always fires.
 *
 * `reason` is `DIVERGENCE_REASONS` — six values — and `scope` is one of two.
 * Twelve series in total, and none of them names anybody.
 */
export const auditChainVerificationFailuresTotal = new Counter({
  name: 'rasta_audit_chain_verification_failures_total',
  help: 'Audit chain verifications that found an integrity divergence',
  labelNames: ['reason', 'scope'] as const,
  registers: [registry],
});

/** Verification requests that completed, by scope and outcome. */
export const auditChainVerificationsTotal = new Counter({
  name: 'rasta_audit_chain_verifications_total',
  help: 'Audit chain verification requests that reached a verdict',
  labelNames: ['scope', 'outcome'] as const,
  registers: [registry],
});

/**
 * How long one verification took, in seconds.
 *
 * Verification is the only read in this service whose cost grows with the data
 * rather than with the page size, so it is the only one worth timing. Buckets
 * run to a minute because a full month of a busy tenant genuinely takes
 * seconds, and a histogram that saturates tells nobody anything.
 */
export const auditChainVerificationSeconds = new Histogram({
  name: 'rasta_audit_chain_verification_seconds',
  help: 'Wall-clock seconds spent verifying one audit chain window',
  labelNames: ['scope'] as const,
  buckets: [0.05, 0.25, 1, 5, 15, 60],
  registers: [registry],
});

/** Records walked by one verification. */
export const auditChainRecordsVerified = new Histogram({
  name: 'rasta_audit_chain_records_verified',
  help: 'Records whose chain link was recomputed by one verification',
  labelNames: ['scope'] as const,
  buckets: [0, 1, 100, 1000, 10000, 100000],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Alert series, exported at zero from process start
//
// The two counters above drive `RastaAuditIngestionFailure` and
// `RastaAuditChainDivergence` (infrastructure/docker/prometheus/rules), both
// `increase(...[5m]) > 0`. prom-client exports a labelled series only once it
// has a value, so without this a series would be born at 1 on its first real
// failure and `increase` would have no earlier sample to compare it with: the
// first failure of each kind after a restart would never alert.
//
// `inc(labels, 0)` adds zero. It creates the sample when it is missing and
// leaves an existing count untouched, so calling this again — as tests that
// `reset()` a counter do — never erases a real failure. Every value comes from
// the closed sets the increment sites already use; nothing here is a new label.
//
// ---------------------------------------------------------------------------

/** Exports every alert-driving audit failure series at zero. Idempotent. */
export function initializeAuditAlertSeries(): void {
  for (const reason of Object.values(INGESTION_FAILURE_REASONS)) {
    auditIngestionFailuresTotal.inc({ reason }, 0);
  }
  for (const reason of DIVERGENCE_REASON_VALUES) {
    for (const scope of Object.values(VERIFICATION_SCOPE_LABELS)) {
      auditChainVerificationFailuresTotal.inc({ reason, scope }, 0);
    }
  }
}

/**
 * Exports the ingestion lag histogram at zero for every source topic.
 *
 * `RastaAuditIngestionLagHigh` reads `rate(..._bucket[5m])`, which has the
 * same first-sample blind spot as `increase`. Seeded with `zero()`, never
 * `observe(labels, 0)`: an observation of 0 would put a record that never
 * existed into the lowest bucket and pull the p95 down. `zero()` writes
 * all-zero `_bucket`, `_sum` and `_count` and counts nothing.
 *
 * **Not idempotent, unlike the counter seeding above:** `zero()` replaces a
 * series, observations included. It runs once, at module load, before any
 * record can have been observed — and a test may call it again only after
 * `reset()`.
 */
export function initializeIngestionLagSeries(): void {
  for (const source_topic of AUDIT_INGESTION_SOURCE_TOPICS) {
    auditIngestionLagSeconds.zero({ source_topic });
  }
}

/**
 * Exports the producer-silence inputs for the configured expected producers.
 *
 * Called by `AppModule.onModuleInit`, after the environment has been validated
 * and before either consumer starts, never at module load: the set comes from
 * configuration, and a module-load call could only ever see the empty default.
 *
 * - `rasta_audit_expected_active_producer{source_service} 1` for each one, and
 *   nothing else. The gauge is reset first so the exposition names exactly the
 *   set passed in; it holds configuration, not observations.
 * - `rasta_audit_records_ingested_total` at zero, via `inc(labels, 0)`, for
 *   every topic that producer contributes times each outcome. Without it a
 *   producer's first row after a restart would be born at 1, `increase` would
 *   see no rise, and a producer that did write would be reported silent. `inc`
 *   by zero never erases a real count, so calling this again — as a test that
 *   `reset()`s does — is safe.
 */
export function initializeExpectedProducerSeries(expected: readonly AuditSourceService[]): void {
  auditExpectedActiveProducer.reset();
  for (const source_service of expected) {
    auditExpectedActiveProducer.set({ source_service }, 1);
    for (const source_topic of sourceTopicsOf(source_service)) {
      for (const outcome of AUDIT_OUTCOMES) {
        auditRecordsIngestedTotal.inc({ source_service, source_topic, outcome }, 0);
      }
    }
  }
}

initializeAuditAlertSeries();
initializeIngestionLagSeries();
