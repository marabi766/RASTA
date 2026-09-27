import { AUDIT_TRAIL_TOPIC, TOPIC_PRODUCERS, type DeclaredTopic } from '@rasta/contracts';

/**
 * Who produces what this service records — read from the platform's one
 * declaration, `TOPIC_PRODUCERS` in `@rasta/contracts` (ADR-061 § 1).
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

type TopicProducerMap = typeof TOPIC_PRODUCERS;

/** A domain topic: every declared topic except the explicit audit trail. */
export type AuditDomainTopic = Exclude<DeclaredTopic, typeof AUDIT_TRAIL_TOPIC>;

type DomainTopicOwner = TopicProducerMap[AuditDomainTopic][number];

/**
 * Path A: each subscribed domain topic and the one service that owns it.
 *
 * **Derived from `TOPIC_PRODUCERS`** (`@rasta/contracts`, ADR-061 § 1), never
 * restated: the topics the shared consumer lets through are exactly the ones
 * this service subscribes to and labels, and a topic declared there is audited
 * here without a second edit (AGENTS.md S-06). Codex review of #124, finding 2.
 *
 * Twelve topics, eleven owners today — `asset-service` publishes both
 * `rasta.asset.v1` and `rasta.insurance.v1`. Topics with no producer yet
 * (`procurement`, `inventory`, `contract`) are absent from `TOPIC_PRODUCERS`,
 * and so from here. The order is `TOPIC_PRODUCERS`' order.
 *
 * A domain topic has exactly one owner — the label below is "the owner, or
 * unknown" — so a declaration with two refuses to load rather than labelling
 * one of them `unknown`.
 */
export const AUDIT_DOMAIN_TOPIC_OWNERS: readonly Readonly<{
  topic: AuditDomainTopic;
  owner: DomainTopicOwner;
}>[] = Object.freeze(
  (Object.keys(TOPIC_PRODUCERS) as DeclaredTopic[])
    .filter((topic): topic is AuditDomainTopic => topic !== AUDIT_TRAIL_TOPIC)
    .map((topic) => {
      const producers: readonly DomainTopicOwner[] = TOPIC_PRODUCERS[topic];
      const [owner] = producers;
      if (producers.length !== 1 || owner === undefined) {
        throw new Error(
          `${topic} declares ${producers.length} producers in TOPIC_PRODUCERS; ` +
            'audit labels a domain topic by its single owner (ADR-061 § 1)',
        );
      }
      return Object.freeze({ topic, owner });
    }),
);

/**
 * Path B: the platform services known to publish on `rasta.audit.trail.v1` —
 * `TOPIC_PRODUCERS`' declaration for that topic, the same frozen list.
 *
 * `identity-service` alone today (nine refusal sites and the correction
 * command). A future trail producer is declared there, and nowhere else.
 */
export const AUDIT_TRAIL_PRODUCERS = TOPIC_PRODUCERS[AUDIT_TRAIL_TOPIC];

export type AuditSourceService = DomainTopicOwner | (typeof AUDIT_TRAIL_PRODUCERS)[number];

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
