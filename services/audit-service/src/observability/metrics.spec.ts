import {
  auditChainRecordsVerified,
  auditChainVerificationFailuresTotal,
  auditChainVerificationSeconds,
  auditChainVerificationsTotal,
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
  VERIFICATION_OUTCOMES,
  VERIFICATION_SCOPE_LABELS,
  initializeAuditAlertSeries,
} from './metrics';
import { metricsText } from '@rasta/observability';
import { DIVERGENCE_REASON_VALUES } from '../audit/audit.verification.view';

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
  {
    name: 'rasta_audit_chain_verification_failures_total',
    metric: auditChainVerificationFailuresTotal,
  },
  { name: 'rasta_audit_chain_verifications_total', metric: auditChainVerificationsTotal },
  { name: 'rasta_audit_chain_verification_seconds', metric: auditChainVerificationSeconds },
  { name: 'rasta_audit_chain_records_verified', metric: auditChainRecordsVerified },
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

  it('gives the chain metrics only closed sets', () => {
    // The divergence counter is where somebody will be tempted to add an
    // organization label, because the first question during an incident is
    // "whose chain". It stays out: the answer belongs in the verification
    // response, behind the authorization that response already carries.
    expect(labelsOf(auditChainVerificationFailuresTotal)).toEqual(['reason', 'scope']);
    expect(labelsOf(auditChainVerificationsTotal)).toEqual(['scope', 'outcome']);
    expect(labelsOf(auditChainVerificationSeconds)).toEqual(['scope']);
    expect(labelsOf(auditChainRecordsVerified)).toEqual(['scope']);
  });

  it('bounds the chain label sets to a countable number of series', () => {
    // Six reasons times two scopes, and two scopes times four outcomes.
    // Cardinality is a property worth pinning: an unbounded label set is how a
    // metrics endpoint becomes an index of what happened to whom.
    expect(Object.values(VERIFICATION_SCOPE_LABELS)).toEqual(['organization', 'platform']);
    expect(Object.values(VERIFICATION_OUTCOMES)).toEqual([
      'valid',
      'divergent',
      'empty',
      'unverifiable_legacy',
    ]);
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

  it('gives path-B refusals their own closed reasons, on the same bounded labels', () => {
    // AUD-004 Phase B adds five reasons and no label. A tenant mismatch in
    // particular is counted, never labelled with the tenant it disagreed about.
    expect(Object.values(INGESTION_FAILURE_REASONS)).toEqual(
      expect.arrayContaining([
        'trail_invalid_envelope',
        'trail_unsupported_event',
        'trail_invalid_payload',
        'trail_tenant_mismatch',
        'trail_unredacted_sensitive_change',
      ]),
    );
    for (const reason of Object.values(INGESTION_FAILURE_REASONS)) {
      expect(reason).toMatch(/^[a-z_]+$/);
    }
    expect(labelsOf(auditIngestionFailuresTotal)).toEqual(['reason']);
    expect(labelsOf(auditRecordsIngestedTotal)).toEqual([
      'source_service',
      'source_topic',
      'outcome',
    ]);
    expect(labelsOf(auditIngestionLagSeconds)).toEqual(['source_topic']);
  });
});

/**
 * The zero series behind `RastaAuditIngestionFailure` and
 * `RastaAuditChainDivergence`, read from the exposition `/metrics` serves.
 *
 * Both alerts are `increase(...[5m]) > 0`. prom-client exports a labelled
 * series only once it has a value, so a series first exported at 1 has no
 * earlier sample and its first real failure is invisible to `increase`. Every
 * alert-driving tuple must therefore already be exported at zero.
 */
describe('alert-driving series exported at zero', () => {
  interface ExposedSample {
    labels: Record<string, string>;
    value: number;
  }

  async function exposed(name: string): Promise<ExposedSample[]> {
    const text = await metricsText();
    return text
      .split('\n')
      .filter((line) => line.startsWith(`${name}{`))
      .map((line) => {
        const match = /^[a-z_]+\{(.*)\} (\S+)$/.exec(line);
        if (!match) throw new Error(`Unparseable exposition line: ${line}`);
        const labels: Record<string, string> = {};
        for (const pair of (match[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)) {
          labels[pair[1] ?? ''] = pair[2] ?? '';
        }
        return { labels, value: Number(match[2]) };
      });
  }

  const INGESTION = 'rasta_audit_ingestion_failures_total';
  const CHAIN = 'rasta_audit_chain_verification_failures_total';

  const expectedIngestion = Object.values(INGESTION_FAILURE_REASONS).sort();
  const expectedChain = DIVERGENCE_REASON_VALUES.flatMap((reason) =>
    Object.values(VERIFICATION_SCOPE_LABELS).map((scope) => `${reason}|${scope}`),
  ).sort();

  async function assertStartupExposition(): Promise<void> {
    const ingestion = await exposed(INGESTION);
    expect(ingestion.map((sample) => sample.labels.reason).sort()).toEqual(expectedIngestion);
    expect(ingestion).toHaveLength(8);
    for (const sample of ingestion) {
      expect(Object.keys(sample.labels)).toEqual(['reason']);
      expect(sample.value).toBe(0);
    }

    const chain = await exposed(CHAIN);
    expect(chain.map((sample) => `${sample.labels.reason}|${sample.labels.scope}`).sort()).toEqual(
      expectedChain,
    );
    // Six reasons times two scopes.
    expect(chain).toHaveLength(12);
    for (const sample of chain) {
      expect(Object.keys(sample.labels).sort()).toEqual(['reason', 'scope']);
      expect(sample.value).toBe(0);
    }
  }

  afterEach(() => {
    // Leave the singletons as a fresh process has them, whatever a test did.
    auditIngestionFailuresTotal.reset();
    auditChainVerificationFailuresTotal.reset();
    initializeAuditAlertSeries();
  });

  it('exports every tuple at zero on module load, before any failure', async () => {
    // Nothing in this file resets or increments these counters before this
    // test, so this is the exposition the first scrape of a new process sees.
    await assertStartupExposition();
  });

  it('seeds exactly the closed sets, with the lowercase scope the increment site uses', async () => {
    auditIngestionFailuresTotal.reset();
    auditChainVerificationFailuresTotal.reset();
    expect(await exposed(INGESTION)).toEqual([]);
    expect(await exposed(CHAIN)).toEqual([]);

    initializeAuditAlertSeries();

    await assertStartupExposition();
    expect(await metricsText()).not.toMatch(/scope="(ORGANIZATION|PLATFORM)"/);
    const keys = [...(await exposed(INGESTION)), ...(await exposed(CHAIN))].flatMap((sample) =>
      Object.keys(sample.labels).map((label) => label.toLowerCase()),
    );
    for (const forbidden of FORBIDDEN_LABELS) {
      expect(keys).not.toContain(forbidden.toLowerCase());
    }
  });

  it('never erases a real failure when seeded again', async () => {
    auditIngestionFailuresTotal.inc({ reason: INGESTION_FAILURE_REASONS.DATABASE_ERROR });
    auditChainVerificationFailuresTotal.inc({
      reason: DIVERGENCE_REASON_VALUES[0],
      scope: VERIFICATION_SCOPE_LABELS.PLATFORM,
    });

    initializeAuditAlertSeries();

    const ingestion = await exposed(INGESTION);
    expect(ingestion).toHaveLength(8);
    expect(ingestion.filter((sample) => sample.value > 0)).toEqual([
      { labels: { reason: INGESTION_FAILURE_REASONS.DATABASE_ERROR }, value: 1 },
    ]);
    const chain = await exposed(CHAIN);
    expect(chain).toHaveLength(12);
    expect(chain.filter((sample) => sample.value > 0)).toEqual([
      {
        labels: { reason: DIVERGENCE_REASON_VALUES[0], scope: VERIFICATION_SCOPE_LABELS.PLATFORM },
        value: 1,
      },
    ]);
  });
});
