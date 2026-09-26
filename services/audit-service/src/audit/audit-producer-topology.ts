import { AUDIT_TRAIL_TOPIC } from '@rasta/contracts';

/**
 * Who produces what this service records — the one place that says so.
 *
 * This is repository and deployment topology, not a business rule: which
 * service publishes to which topic today (`docs/04`, each service's outbox
 * relay), and which services are known producers on the explicit trail. The
 * subscription list (`DOMAIN_TOPICS`), the metric label set, the zero-seeded
 * alert series and the `AUDIT_EXPECTED_ACTIVE_PRODUCERS` allow-list are all
 * derived from it, so a producer added here is added everywhere at once and a
 * producer missing here is missing everywhere at once.
 *
 * ## Why a metric label needs this at all
 *
 * `envelope.producer` is producer-authored and only length-bounded before it is
 * stored. Stored, that is correct: the row keeps exactly what the producer
 * claimed (ADR-053 § 5). As a Prometheus label it is not, because every distinct
 * string becomes a new series that lives for the retention period — a producer
 * with a bug, or anyone able to publish to a subscribed topic, could otherwise
 * mint series without bound. So the label is derived from this closed set, and
 * anything that does not agree with it is counted under one fallback value.
 * The stored evidence is not touched: this is label hardening, not censorship.
 */

/**
 * Path A: each subscribed domain topic and the one service that owns it.
 *
 * Twelve topics, eleven owners — `asset-service` publishes both `rasta.asset.v1`
 * and `rasta.insurance.v1`. `procurement`, `inventory` and `contract` have no
 * producer yet and are deliberately absent (see `DOMAIN_TOPICS` in
 * `audit.mapper.ts`, which is derived from this list).
 *
 * `rasta.notification.v1` arrived last, with `NTF-002`'s audit events.
 * notification-service consumed for its whole life and produced nothing, so it
 * was absent here for the same reason it had no outbox. `ADR-054 § 3` recorded
 * that as a deviation from `AGENTS.md` S-06 rather than a design choice, and
 * this row is the consuming half of closing it.
 *
 * `rasta.construction.v1` arrived with CON-001: construction-service's project
 * and need lifecycle events (docs/events/README.md § Construction), so every
 * project state change reaches this record (AGENTS.md S-06).
 */
export const AUDIT_DOMAIN_TOPIC_OWNERS = Object.freeze([
  Object.freeze({ topic: 'rasta.identity.v1', owner: 'identity-service' }),
  Object.freeze({ topic: 'rasta.organization.v1', owner: 'organization-service' }),
  Object.freeze({ topic: 'rasta.asset.v1', owner: 'asset-service' }),
  Object.freeze({ topic: 'rasta.insurance.v1', owner: 'asset-service' }),
  Object.freeze({ topic: 'rasta.fleet.v1', owner: 'fleet-service' }),
  Object.freeze({ topic: 'rasta.maintenance.v1', owner: 'maintenance-service' }),
  Object.freeze({ topic: 'rasta.marketplace.v1', owner: 'marketplace-service' }),
  Object.freeze({ topic: 'rasta.economic.v1', owner: 'economic-service' }),
  Object.freeze({ topic: 'rasta.document.v1', owner: 'document-service' }),
  Object.freeze({ topic: 'rasta.supplier.v1', owner: 'supplier-service' }),
  Object.freeze({ topic: 'rasta.notification.v1', owner: 'notification-service' }),
  Object.freeze({ topic: 'rasta.construction.v1', owner: 'construction-service' }),
] as const);

export type AuditDomainTopic = (typeof AUDIT_DOMAIN_TOPIC_OWNERS)[number]['topic'];

/**
 * Path B: the platform services known to publish on `rasta.audit.trail.v1`.
 *
 * `identity-service` alone today (nine refusal sites and the correction
 * command). A future trail producer is added here, and nowhere else.
 */
export const AUDIT_TRAIL_PRODUCERS = Object.freeze(['identity-service'] as const);

export type AuditSourceService =
  (typeof AUDIT_DOMAIN_TOPIC_OWNERS)[number]['owner'] | (typeof AUDIT_TRAIL_PRODUCERS)[number];

/**
 * The `source_service` label for a row whose producer claim does not match
 * the topology: an unknown producer, a known producer on a topic it does not
 * own, or anything overlong. One value, so the label set stays closed.
 */
export const AUDIT_UNKNOWN_SOURCE_SERVICE = 'unknown';

export type AuditSourceServiceLabel = AuditSourceService | typeof AUDIT_UNKNOWN_SOURCE_SERVICE;

/** Every known producer, deduplicated, in topology order. Eleven today. */
export const AUDIT_SOURCE_SERVICES: readonly AuditSourceService[] = Object.freeze([
  ...new Set<AuditSourceService>([
    ...AUDIT_DOMAIN_TOPIC_OWNERS.map((entry) => entry.owner),
    ...AUDIT_TRAIL_PRODUCERS,
  ]),
]);

/** Every value `rasta_audit_records_ingested_total{source_service}` can take. */
export const AUDIT_SOURCE_SERVICE_LABELS: readonly AuditSourceServiceLabel[] = Object.freeze([
  ...AUDIT_SOURCE_SERVICES,
  AUDIT_UNKNOWN_SOURCE_SERVICE,
]);

const OWNER_BY_TOPIC: ReadonlyMap<string, AuditSourceService> = new Map(
  AUDIT_DOMAIN_TOPIC_OWNERS.map((entry) => [entry.topic, entry.owner]),
);

const TRAIL_PRODUCERS: ReadonlySet<string> = new Set(AUDIT_TRAIL_PRODUCERS);

const KNOWN_SOURCE_SERVICES: ReadonlySet<string> = new Set(AUDIT_SOURCE_SERVICES);

export function isAuditSourceService(value: string): value is AuditSourceService {
  return KNOWN_SOURCE_SERVICES.has(value);
}

/**
 * Path A label: the topic's owner, but only when the producer agrees with it.
 *
 * The topic is the delivery topic, never the envelope's claim, so a known
 * service name on a topic that service does not own counts as `unknown` rather
 * than lending its name to somebody else's traffic.
 */
export function domainSourceServiceLabel(
  deliveryTopic: string,
  producer: string,
): AuditSourceServiceLabel {
  const owner = OWNER_BY_TOPIC.get(deliveryTopic);
  return owner !== undefined && producer === owner ? owner : AUDIT_UNKNOWN_SOURCE_SERVICE;
}

/** Path B label: a known trail producer's name, otherwise `unknown`. */
export function trailSourceServiceLabel(producer: string): AuditSourceServiceLabel {
  return TRAIL_PRODUCERS.has(producer)
    ? (producer as AuditSourceService)
    : AUDIT_UNKNOWN_SOURCE_SERVICE;
}

/**
 * The topics a known producer contributes rows from: the domain topics it owns,
 * and the trail topic if it is a trail producer. What zero-seeding reads.
 */
export function sourceTopicsOf(service: AuditSourceService): readonly string[] {
  const topics: string[] = AUDIT_DOMAIN_TOPIC_OWNERS.filter((entry) => entry.owner === service).map(
    (entry) => entry.topic,
  );
  if (TRAIL_PRODUCERS.has(service)) topics.push(AUDIT_TRAIL_TOPIC);
  return Object.freeze(topics);
}
