import { AUDIT_TRAIL_TOPIC } from './envelope';
import { OPS_REPLAY_PRODUCER, OPS_REPLAY_TOPIC } from './ops-replay';

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
 * inventory) is absent on purpose: `EventConsumer` refuses to
 * subscribe to a topic nobody is declared to own, so adding a consumer for one
 * means declaring its producer here first.
 *
 * The values are the producers' `SERVICE_NAME` — what `buildOutboxRow` writes
 * into `envelope.producer`. `asset-service` owns two topics. One producer is
 * not a service: `ops-replay`, the operator's replay tool, alone writes
 * `rasta.ops.replay.v1`, its record of every executed replay (`ops-replay.ts`).
 */
export const TOPIC_PRODUCERS = Object.freeze({
  'rasta.identity.v1': Object.freeze(['identity-service'] as const),
  'rasta.organization.v1': Object.freeze(['organization-service'] as const),
  'rasta.asset.v1': Object.freeze(['asset-service'] as const),
  'rasta.insurance.v1': Object.freeze(['asset-service'] as const),
  'rasta.fleet.v1': Object.freeze(['fleet-service'] as const),
  'rasta.maintenance.v1': Object.freeze(['maintenance-service'] as const),
  'rasta.marketplace.v1': Object.freeze(['marketplace-service'] as const),
  'rasta.economic.v1': Object.freeze(['economic-service'] as const),
  'rasta.document.v1': Object.freeze(['document-service'] as const),
  'rasta.supplier.v1': Object.freeze(['supplier-service'] as const),
  'rasta.notification.v1': Object.freeze(['notification-service'] as const),
  'rasta.construction.v1': Object.freeze(['construction-service'] as const),
  // CON-003 (ADR-068): the draft contract an awarded tender creates, and later the rest of the contract's life.
  'rasta.contract.v1': Object.freeze(['contract-service'] as const),
  [AUDIT_TRAIL_TOPIC]: Object.freeze(['identity-service'] as const),
  [OPS_REPLAY_TOPIC]: Object.freeze([OPS_REPLAY_PRODUCER] as const),
});

/**
 * Literal types, so a consumer that needs its own typed view — audit-service's
 * topology — derives it from this constant instead of restating it (§ 1).
 */
export type DeclaredTopic = keyof typeof TOPIC_PRODUCERS;
export type DeclaredProducer = (typeof TOPIC_PRODUCERS)[DeclaredTopic][number];

/** The same map, read by a topic that is only known at runtime. */
const BY_TOPIC: Readonly<Record<string, readonly string[]>> = TOPIC_PRODUCERS;

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
  return Object.prototype.hasOwnProperty.call(BY_TOPIC, ownerTopicOf(deliveryTopic));
}

/** The producers declared for the topic a delivery belongs to; empty for an undeclared one. */
export function producersOf(deliveryTopic: string): readonly string[] {
  return isDeclaredTopic(deliveryTopic) ? (BY_TOPIC[ownerTopicOf(deliveryTopic)] ?? []) : [];
}

/**
 * Whether `producer` may publish on the topic a message was delivered on.
 *
 * `false` for an undeclared topic as well as for an undeclared producer: a
 * topic nobody is declared to own has no legitimate producer.
 */
export function isAllowedProducer(deliveryTopic: string, producer: string): boolean {
  return producersOf(deliveryTopic).includes(producer);
}
