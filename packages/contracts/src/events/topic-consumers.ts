import {
  TOPIC_PRODUCERS,
  isDeclaredTopic,
  ownerTopicOf,
  type DeclaredTopic,
} from './topic-producers';

/**
 * Which services read which topics, under which consumer-group prefix, and
 * where each one dead-letters (ADR-061 § 3, RUN-006).
 *
 * The read-side twin of {@link TOPIC_PRODUCERS}. Together they are the one
 * source the broker's ACLs are generated from: WRITE on a topic for its
 * producers, READ on a topic for the services listed here, READ on the
 * consumer groups `<service>.*`, WRITE on each service's own dead-letter
 * topic. A contract, not configuration, for the same reason as
 * `TOPIC_PRODUCERS` (Q-63): two lists would drift, and a drift here is either
 * an ACL that refuses a real subscription or one that allows a stray one.
 *
 * ## The shape
 *
 * The keys are the consuming services' `SERVICE_NAME`, which is also their
 * broker principal (`User:<service>`). Per service:
 *
 *   - `subscribes`: every topic any of its consumer groups reads. Kafka grants
 *     READ on a topic to a principal, not to a group, so the service is the
 *     unit here, not the group.
 *   - `deadLetterTopic`: the one topic its consumers dead-letter to. Its own,
 *     never the producer's: a message this service could not process is this
 *     service's to replay.
 *
 * Every consumer group a service runs is named `<service>.<purpose>`.
 * `EventConsumer` (`nest-common`) refuses to start a consumer whose group is in
 * a declared service's namespace but whose topics or dead-letter topic are not
 * declared here, and — once it authenticates to the broker — one whose group
 * is outside its own principal's namespace.
 *
 * A service with no consumer (organization, marketplace, document,
 * construction today) is absent. Adding a consumer means declaring it here;
 * `topic-consumers.repo.spec.ts` fails the build for one that is not.
 */

/** Every declared topic: audit-service's domain projector and trail consumer read all of them. */
const EVERY_DECLARED_TOPIC = Object.freeze(Object.keys(TOPIC_PRODUCERS) as DeclaredTopic[]);

export const TOPIC_CONSUMERS = Object.freeze({
  'identity-service': Object.freeze({
    subscribes: Object.freeze(['rasta.identity.v1'] as const),
    deadLetterTopic: 'rasta.identity.v1.dlq',
  }),
  'asset-service': Object.freeze({
    subscribes: Object.freeze([
      'rasta.fleet.v1',
      'rasta.maintenance.v1',
      'rasta.marketplace.v1',
      'rasta.construction.v1',
    ] as const),
    deadLetterTopic: 'rasta.asset.v1.dlq',
  }),
  'fleet-service': Object.freeze({
    subscribes: Object.freeze([
      'rasta.asset.v1',
      'rasta.insurance.v1',
      'rasta.maintenance.v1',
    ] as const),
    deadLetterTopic: 'rasta.fleet.v1.dlq',
  }),
  'maintenance-service': Object.freeze({
    subscribes: Object.freeze(['rasta.fleet.v1', 'rasta.asset.v1'] as const),
    deadLetterTopic: 'rasta.maintenance.v1.dlq',
  }),
  'economic-service': Object.freeze({
    subscribes: Object.freeze(['rasta.maintenance.v1', 'rasta.fleet.v1'] as const),
    deadLetterTopic: 'rasta.economic.v1.dlq',
  }),
  'notification-service': Object.freeze({
    subscribes: Object.freeze(['rasta.insurance.v1', 'rasta.maintenance.v1'] as const),
    deadLetterTopic: 'rasta.notification.v1.dlq',
  }),
  // ADR-052 step 5 (#126): scores suppliers on marketplace outcomes. Its
  // consumer stays refused at startup until the broker authenticates
  // producers (RUN-006 PR B); the declaration is what the ACLs read.
  'supplier-service': Object.freeze({
    subscribes: Object.freeze(['rasta.marketplace.v1'] as const),
    deadLetterTopic: 'rasta.supplier.v1.dlq',
  }),
  'audit-service': Object.freeze({
    subscribes: EVERY_DECLARED_TOPIC,
    deadLetterTopic: 'rasta.audit.v1.dlq',
  }),
});

export type DeclaredConsumer = keyof typeof TOPIC_CONSUMERS;

/** The separator between a service and the purpose in a consumer-group id. */
export const CONSUMER_GROUP_SEPARATOR = '.';

const BY_SERVICE: Readonly<
  Record<string, { subscribes: readonly string[]; deadLetterTopic: string }>
> = TOPIC_CONSUMERS;

export function isDeclaredConsumer(service: string): boolean {
  return Object.prototype.hasOwnProperty.call(BY_SERVICE, service);
}

/**
 * The service whose namespace a consumer-group id is in: the part before the
 * first `.`, or `undefined` when there is none. `fleet-service.asset-sync` →
 * `fleet-service`. Says nothing about whether that service is declared.
 */
export function consumerGroupService(groupId: string): string | undefined {
  const at = groupId.indexOf(CONSUMER_GROUP_SEPARATOR);
  return at > 0 ? groupId.slice(0, at) : undefined;
}

/**
 * Why a consumer does not match its declaration, or `undefined` when it does.
 *
 * `service` is the service the consumer acts for. Returned as text so the one
 * caller (`EventConsumer`) can fail at startup with it; nothing here depends on
 * the consumer's own claims beyond what is passed in.
 */
export function consumerDeclarationProblem(
  service: string,
  consumer: { groupId: string; topics: readonly string[]; deadLetterTopic?: string },
): string | undefined {
  const declared = BY_SERVICE[service];
  if (!isDeclaredConsumer(service) || declared === undefined) {
    return `${service} is not declared in TOPIC_CONSUMERS`;
  }
  if (consumerGroupService(consumer.groupId) !== service) {
    return `group ${consumer.groupId} is outside ${service}'s namespace (${service}${CONSUMER_GROUP_SEPARATOR}…)`;
  }
  // A topic's `.retry` twin is read under the same declaration: it carries
  // replays of the same stream (docs/runbooks/replay-dlq.md).
  const undeclared = consumer.topics.filter(
    (topic) => !isDeclaredTopic(topic) || !declared.subscribes.includes(ownerTopicOf(topic)),
  );
  if (undeclared.length > 0) {
    return `${service} does not declare a subscription to ${undeclared.join(', ')}`;
  }
  if (
    consumer.deadLetterTopic !== undefined &&
    consumer.deadLetterTopic !== declared.deadLetterTopic
  ) {
    return `${service} dead-letters to ${declared.deadLetterTopic}, not ${consumer.deadLetterTopic}`;
  }
  return undefined;
}
