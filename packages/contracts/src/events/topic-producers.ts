import { AUDIT_TRAIL_TOPIC } from './envelope';

/**
 * Which services may publish on which topic (ADR-061 § 1).
 *
 * **A contract, not configuration** — the Q-63 reasoning: two services holding
 * two lists would mean a producer allowed by one and refused by the other. One
 * frozen constant, read by the one check in `EventConsumer` (`nest-common`), so
 * every consumer on the platform applies the same answer.
 *
 * What it guarantees today, stated as ADR-061 § 2 states it: **consistency, not
 * authentication.** The envelope's `producer` is the sender's claim; this check
 * refuses a claim that disagrees with the topic the broker delivered the
 * message on. That closes forgery *across* topics — service A can no longer
 * write in B's name on B's topic and be accepted — and turns a misrouted event
 * into a dead letter. It does not stop anyone who can reach the broker from
 * writing on B's topic *as* B; that is § 3 (SASL/SCRAM and per-topic ACLs), a
 * gate before any real tenant data (RUN-006). Once § 3 holds, the delivery
 * topic itself authenticates the producer and this check becomes proof.
 *
 * ## What belongs here
 *
 * Every topic a consumer on `main` subscribes to, with the services that
 * publish on it — each domain topic has exactly one owner, the explicit audit
 * trail its known producers. A topic with no producer yet (procurement,
 * inventory, contract) is absent on purpose: `EventConsumer` refuses to
 * subscribe to a topic nobody is declared to own, so adding a consumer for one
 * means declaring its producer here first.
 *
 * The values are the producers' `SERVICE_NAME` — what `buildOutboxRow` writes
 * into `envelope.producer`. `asset-service` owns two topics.
 */
export const TOPIC_PRODUCERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'rasta.identity.v1': Object.freeze(['identity-service']),
  'rasta.organization.v1': Object.freeze(['organization-service']),
  'rasta.asset.v1': Object.freeze(['asset-service']),
  'rasta.insurance.v1': Object.freeze(['asset-service']),
  'rasta.fleet.v1': Object.freeze(['fleet-service']),
  'rasta.maintenance.v1': Object.freeze(['maintenance-service']),
  'rasta.marketplace.v1': Object.freeze(['marketplace-service']),
  'rasta.economic.v1': Object.freeze(['economic-service']),
  'rasta.document.v1': Object.freeze(['document-service']),
  'rasta.supplier.v1': Object.freeze(['supplier-service']),
  'rasta.notification.v1': Object.freeze(['notification-service']),
  'rasta.construction.v1': Object.freeze(['construction-service']),
  [AUDIT_TRAIL_TOPIC]: Object.freeze(['identity-service']),
});

/**
 * The suffix of a retry topic. A message redelivered on `<topic>.retry` was
 * published on `<topic>`, so it is judged against `<topic>`'s producers. The
 * suffix is read from the delivery topic the broker reported — never from the
 * envelope — so this does not reopen what ADR-061 § 2 closes.
 */
export const RETRY_TOPIC_SUFFIX = '.retry';

/** The topic whose producers a delivery on `deliveryTopic` is judged against. */
export function ownerTopicOf(deliveryTopic: string): string {
  return deliveryTopic.endsWith(RETRY_TOPIC_SUFFIX)
    ? deliveryTopic.slice(0, -RETRY_TOPIC_SUFFIX.length)
    : deliveryTopic;
}

/** Whether any producer is declared for the topic a delivery belongs to. */
export function isDeclaredTopic(deliveryTopic: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOPIC_PRODUCERS, ownerTopicOf(deliveryTopic));
}

/**
 * Whether `producer` may publish on the topic a message was delivered on.
 *
 * `false` for an undeclared topic as well as for an undeclared producer: a
 * topic nobody is declared to own has no legitimate producer.
 */
export function isAllowedProducer(deliveryTopic: string, producer: string): boolean {
  const topic = ownerTopicOf(deliveryTopic);
  if (!Object.prototype.hasOwnProperty.call(TOPIC_PRODUCERS, topic)) return false;
  return (TOPIC_PRODUCERS[topic] ?? []).includes(producer);
}
