import { TOPIC_PRODUCERS, RETRY_TOPIC_SUFFIX } from './topic-producers';
import { CONSUMER_GROUP_SEPARATOR, TOPIC_CONSUMERS } from './topic-consumers';
import { AUDIT_TRAIL_TOPIC, NEVER_AUTO_REPLAY_TOPICS } from './envelope';

/**
 * The broker's principals and ACLs, derived from the topology contracts
 * (ADR-061 § 3, RUN-006).
 *
 * One derivation, from `TOPIC_PRODUCERS` (who writes) and `TOPIC_CONSUMERS`
 * (who reads, under which group namespace, dead-lettering where). Nothing
 * here is configuration: a principal that should be able to do more is a
 * change to the contracts, reviewed there.
 *
 *   - A producer: WRITE on each topic it owns.
 *   - A consumer: READ on each subscribed topic and its `.retry` twin; READ on
 *     the consumer groups `<service>.*`; WRITE on its own dead-letter topic.
 *     (READ and WRITE imply DESCRIBE on the broker.)
 *   - `ops-replay`, the operator's replay tool (docs/runbooks/replay-dlq.md):
 *     the only writer of `.retry` topics and the only reader of `.dlq` ones.
 *     It also READs every topic a consumer subscribes to — the only topics a
 *     dead letter can have come from — so a dry-run can tell a stale event
 *     (a newer one exists for its stream key), except the topics in
 *     `NEVER_AUTO_REPLAY_TOPICS`, which it never replays; its groups are confined to
 *     `ops-replay.*` like any principal's, and it WRITEs no original topic.
 *   - Development only (compose and CI, never a deployment): `itest-observer`,
 *     which reads what tests assert on; `kafka-ui` and `kafka-exporter`, which
 *     describe (and, for the UI, browse) the platform's topics and groups.
 *
 * No binding has a wildcard principal, a literal `*` resource or a prefix
 * shorter than a namespace; the broker's own `admin` is a super user used
 * only to bootstrap and is not in this list.
 *
 * A pure function of the contracts: `broker-acls.spec.ts` states the rules,
 * and the generated `infrastructure/docker/kafka/broker-acls.<profile>.json`,
 * which the bootstrap applies, is checked against it.
 */

/**
 * `deployment` holds the services and `ops-replay` only; `development` adds
 * the principals that exist only where no real data does (compose and CI):
 * the read-only test observer, Kafka UI and the exporter. The bootstrap never
 * assumes one: the applier and the broker refuse to run without it named.
 */
export const BROKER_PROFILES = ['deployment', 'development'] as const;
export type BrokerProfile = (typeof BROKER_PROFILES)[number];

export type AclResourceType = 'TOPIC' | 'GROUP' | 'CLUSTER';
export type AclPatternType = 'LITERAL' | 'PREFIXED';
export type AclOperation = 'READ' | 'WRITE' | 'DESCRIBE';

export interface AclBinding {
  readonly principal: string;
  readonly resourceType: AclResourceType;
  readonly resourceName: string;
  readonly patternType: AclPatternType;
  readonly operation: AclOperation;
}

/** The bootstrap super user. Never a service's identity, never in {@link brokerAcls}. */
export const BROKER_ADMIN_PRINCIPAL = 'admin';

/**
 * The operator's replay tool: the only writer of `.retry`, the only reader of
 * `.dlq`, and a reader (never a writer) of every subscribed topic, for the
 * staleness check (docs/runbooks/replay-dlq.md).
 */
export const OPS_REPLAY_PRINCIPAL = 'ops-replay';

/** Principals that exist only where no real data does: compose and CI. */
export const DEVELOPMENT_PRINCIPALS = Object.freeze({
  observer: 'itest-observer',
  ui: 'kafka-ui',
  exporter: 'kafka-exporter',
} as const);

/** The resource name the Kafka cluster ACLs are written against. */
export const KAFKA_CLUSTER_RESOURCE = 'kafka-cluster';

/** The prefix every platform topic shares. */
export const PLATFORM_TOPIC_PREFIX = 'rasta.';

export const DLQ_TOPIC_SUFFIX = '.dlq';

const declaredTopics = (): string[] => Object.keys(TOPIC_PRODUCERS).sort();
const consumers = (): [string, { subscribes: readonly string[]; deadLetterTopic: string }][] =>
  Object.entries(
    TOPIC_CONSUMERS as Record<string, { subscribes: readonly string[]; deadLetterTopic: string }>,
  ).sort(([a], [b]) => a.localeCompare(b));

/** Every principal the broker needs a SCRAM credential for, sorted. The admin is not listed. */
export function brokerPrincipals(profile: BrokerProfile): string[] {
  const names = new Set<string>();
  for (const producers of Object.values(TOPIC_PRODUCERS)) for (const p of producers) names.add(p);
  for (const [service] of consumers()) names.add(service);
  names.add(OPS_REPLAY_PRINCIPAL);
  if (profile === 'development')
    for (const name of Object.values(DEVELOPMENT_PRINCIPALS)) names.add(name);
  return [...names].sort();
}

/** Every ACL binding for `profile`, deduplicated and sorted. */
export function brokerAcls(profile: BrokerProfile): AclBinding[] {
  const out = new Map<string, AclBinding>();
  const allow = (
    principal: string,
    resourceType: AclResourceType,
    resourceName: string,
    operation: AclOperation,
    patternType: AclPatternType = 'LITERAL',
  ): void => {
    const binding: AclBinding = { principal, resourceType, resourceName, patternType, operation };
    out.set(JSON.stringify(binding), binding);
  };
  // READ and WRITE imply DESCRIBE on the broker; it is not granted separately.
  const topic = (principal: string, name: string, operation: AclOperation): void => {
    allow(principal, 'TOPIC', name, operation);
  };
  const retry = (name: string): string => `${name}${RETRY_TOPIC_SUFFIX}`;
  const groupNamespace = (service: string): string => `${service}${CONSUMER_GROUP_SEPARATOR}`;

  // Producers write what they own.
  for (const name of declaredTopics()) {
    for (const producer of TOPIC_PRODUCERS[name as keyof typeof TOPIC_PRODUCERS]) {
      topic(producer, name, 'WRITE');
    }
  }

  // Consumers read what they subscribe to, in their own group namespace, and
  // dead-letter to their own topic.
  const deadLetters: string[] = [];
  const subscribedTopics = new Set<string>();
  for (const [service, { subscribes, deadLetterTopic }] of consumers()) {
    for (const name of subscribes) {
      if (!Object.prototype.hasOwnProperty.call(TOPIC_PRODUCERS, name)) {
        // A READ grant on a topic nobody may write is a contract error.
        throw new Error(
          `${service} subscribes to ${name}, which has no producer in TOPIC_PRODUCERS`,
        );
      }
      topic(service, name, 'READ');
      topic(service, retry(name), 'READ');
      subscribedTopics.add(name);
    }
    allow(service, 'GROUP', groupNamespace(service), 'READ', 'PREFIXED');
    topic(service, deadLetterTopic, 'WRITE');
    deadLetters.push(deadLetterTopic);
  }

  // The operator's replay: dead letters out, retries in — and a look at the
  // original topic, to tell whether a newer event exists for the stream key.
  // Not at a topic whose dead letters it never replays (the economic stream).
  for (const name of declaredTopics()) topic(OPS_REPLAY_PRINCIPAL, retry(name), 'WRITE');
  for (const name of deadLetters) topic(OPS_REPLAY_PRINCIPAL, name, 'READ');
  for (const name of subscribedTopics) {
    if (!NEVER_AUTO_REPLAY_TOPICS.has(name)) topic(OPS_REPLAY_PRINCIPAL, name, 'READ');
  }
  allow(OPS_REPLAY_PRINCIPAL, 'GROUP', groupNamespace(OPS_REPLAY_PRINCIPAL), 'READ', 'PREFIXED');

  if (profile === 'development') {
    const { observer, ui, exporter } = DEVELOPMENT_PRINCIPALS;
    for (const name of declaredTopics()) {
      topic(observer, name, 'READ');
      topic(observer, retry(name), 'READ');
    }
    for (const name of deadLetters) topic(observer, name, 'READ');
    allow(observer, 'GROUP', groupNamespace(observer), 'READ', 'PREFIXED');

    for (const tool of [ui, exporter]) {
      allow(tool, 'TOPIC', PLATFORM_TOPIC_PREFIX, 'DESCRIBE', 'PREFIXED');
      allow(tool, 'CLUSTER', KAFKA_CLUSTER_RESOURCE, 'DESCRIBE');
      for (const [service] of consumers()) {
        allow(tool, 'GROUP', groupNamespace(service), 'DESCRIBE', 'PREFIXED');
      }
      for (const namespace of [OPS_REPLAY_PRINCIPAL, observer]) {
        allow(tool, 'GROUP', groupNamespace(namespace), 'DESCRIBE', 'PREFIXED');
      }
    }
    // The UI browses messages; the exporter only reads offsets.
    allow(ui, 'TOPIC', PLATFORM_TOPIC_PREFIX, 'READ', 'PREFIXED');
  }

  return [...out.values()].sort((a, b) =>
    JSON.stringify([a.principal, a.resourceType, a.resourceName, a.operation]).localeCompare(
      JSON.stringify([b.principal, b.resourceType, b.resourceName, b.operation]),
    ),
  );
}

/** The document the bootstrap applies: `infrastructure/docker/kafka/broker-acls.<profile>.json`. */
export function brokerAclDocument(profile: BrokerProfile): {
  profile: BrokerProfile;
  admin: string;
  principals: string[];
  acls: AclBinding[];
} {
  return {
    profile,
    admin: BROKER_ADMIN_PRINCIPAL,
    principals: brokerPrincipals(profile),
    acls: brokerAcls(profile),
  };
}

/**
 * What a bootstrap topic is for, which decides its partitions and retention
 * (`infrastructure/docker/kafka/create-topics.sh`).
 */
export type BrokerTopicKind = 'stream' | 'retry' | 'dead-letter' | 'audit-trail';

export interface BrokerTopic {
  readonly name: string;
  readonly kind: BrokerTopicKind;
}

/**
 * Every topic the broker must hold, derived from the same contracts as the
 * ACLs (review of #131, finding 2): each declared topic and its `.retry` twin,
 * and each consumer's dead-letter topic. Auto-creation is off (ADR-006), so a
 * topic the ACLs name but the bootstrap does not create is a replay or a
 * dead letter that fails at run time; generated together, the two cannot
 * disagree. Sorted by name.
 */
export function brokerTopics(): BrokerTopic[] {
  const out = new Map<string, BrokerTopic>();
  const add = (name: string, kind: BrokerTopicKind): void => {
    out.set(name, { name, kind });
  };
  for (const name of declaredTopics()) {
    add(name, name === AUDIT_TRAIL_TOPIC ? 'audit-trail' : 'stream');
    add(`${name}${RETRY_TOPIC_SUFFIX}`, 'retry');
  }
  for (const [, { deadLetterTopic }] of consumers()) add(deadLetterTopic, 'dead-letter');
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
