import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BROKER_ADMIN_PRINCIPAL,
  DEVELOPMENT_PRINCIPALS,
  OPS_REPLAY_PRINCIPAL,
  brokerAclDocument,
  brokerAcls,
  brokerPrincipals,
  brokerTopics,
  BROKER_PROFILES,
  type AclBinding,
  type BrokerProfile,
} from './broker-acls';
import { TOPIC_PRODUCERS } from './topic-producers';
import { TOPIC_CONSUMERS } from './topic-consumers';
import { NEVER_AUTO_REPLAY_TOPICS } from './envelope';

/**
 * RUN-006: the broker's ACLs, derived from the topology contracts. Each test
 * states a rule the generated set must never break; the broker tests
 * (`scripts/kafka-acl.broker.test.mjs`) then prove the broker enforces it.
 */

const PROFILES: readonly BrokerProfile[] = BROKER_PROFILES;
const DECLARED_TOPICS = Object.keys(TOPIC_PRODUCERS);
const DEAD_LETTERS: readonly string[] = Object.values(TOPIC_CONSUMERS).map(
  (entry) => entry.deadLetterTopic,
);
const DEVELOPMENT = new Set<string>(Object.values(DEVELOPMENT_PRINCIPALS));

const where = (acls: AclBinding[], match: Partial<AclBinding>) =>
  acls.filter((acl) =>
    Object.entries(match).every(([key, value]) => acl[key as keyof AclBinding] === value),
  );
const principalsOf = (acls: AclBinding[]) => [...new Set(acls.map((acl) => acl.principal))].sort();

describe.each(PROFILES)('brokerAcls(%s)', (profile) => {
  const acls = brokerAcls(profile);

  it('lets exactly TOPIC_PRODUCERS write each declared topic', () => {
    for (const topic of DECLARED_TOPICS) {
      const writers = principalsOf(
        where(acls, { resourceType: 'TOPIC', resourceName: topic, operation: 'WRITE' }),
      );
      expect([topic, writers]).toEqual([
        topic,
        [...TOPIC_PRODUCERS[topic as keyof typeof TOPIC_PRODUCERS]].sort(),
      ]);
    }
  });

  it('lets each consumer read exactly what it subscribes to, and its retry twin', () => {
    for (const [service, { subscribes }] of Object.entries(TOPIC_CONSUMERS)) {
      const reads = where(acls, { principal: service, resourceType: 'TOPIC', operation: 'READ' })
        .map((acl) => acl.resourceName)
        .sort();
      expect([service, reads]).toEqual([
        service,
        subscribes.flatMap((topic) => [topic, `${topic}.retry`]).sort(),
      ]);
    }
  });

  it('lets each dead-letter topic be written only by its consumer', () => {
    for (const [service, { deadLetterTopic }] of Object.entries(TOPIC_CONSUMERS)) {
      expect(
        principalsOf(where(acls, { resourceName: deadLetterTopic, operation: 'WRITE' })),
      ).toEqual([service]);
    }
  });

  it('lets only ops-replay write a retry topic, and nobody that of a never-replayed topic', () => {
    const writers = principalsOf(
      acls.filter((acl) => acl.operation === 'WRITE' && acl.resourceName.endsWith('.retry')),
    );
    expect(writers).toEqual([OPS_REPLAY_PRINCIPAL]);
    for (const topic of DECLARED_TOPICS) {
      expect(
        where(acls, {
          principal: OPS_REPLAY_PRINCIPAL,
          resourceName: `${topic}.retry`,
          operation: 'WRITE',
        }),
      ).toHaveLength(NEVER_AUTO_REPLAY_TOPICS.has(topic) ? 0 : 1);
    }
    // Least privilege (PM, round 1 on #144): the tool never replays the
    // economic stream, so ops-replay may not write its .retry either.
    expect(where(acls, { resourceName: 'rasta.economic.v1.retry', operation: 'WRITE' })).toEqual(
      [],
    );
  });

  it('lets only ops-replay (and, in development, the test observer) read a dead-letter topic', () => {
    const readers = principalsOf(
      acls.filter((acl) => acl.operation === 'READ' && DEAD_LETTERS.includes(acl.resourceName)),
    );
    expect(readers).toEqual(
      profile === 'development'
        ? [DEVELOPMENT_PRINCIPALS.observer, OPS_REPLAY_PRINCIPAL].sort()
        : [OPS_REPLAY_PRINCIPAL],
    );
  });

  it('lets ops-replay read every replayable subscribed topic — for the staleness check — and write none', () => {
    const subscribed = new Set(Object.values(TOPIC_CONSUMERS).flatMap((c) => [...c.subscribes]));
    const reads = where(acls, { principal: OPS_REPLAY_PRINCIPAL, operation: 'READ' })
      .filter((acl) => acl.resourceType === 'TOPIC' && !DEAD_LETTERS.includes(acl.resourceName))
      .map((acl) => acl.resourceName)
      .sort();
    expect(reads).toEqual([...subscribed].filter((t) => !NEVER_AUTO_REPLAY_TOPICS.has(t)).sort());
    // audit-service subscribes to the economic stream, yet the tool never
    // replays it: no READ there (Codex round 1 on #144, H2).
    expect(subscribed.has('rasta.economic.v1')).toBe(true);
    expect(reads).not.toContain('rasta.economic.v1');
    // A never-replayed topic the contracts do not declare would exclude nothing.
    for (const name of NEVER_AUTO_REPLAY_TOPICS)
      expect(Object.keys(TOPIC_PRODUCERS)).toContain(name);
    // Its WRITE is the .retry twins alone: never an original, never a dead letter.
    for (const acl of where(acls, { principal: OPS_REPLAY_PRINCIPAL, operation: 'WRITE' })) {
      expect(acl.resourceName.endsWith('.retry')).toBe(true);
    }
    // And its groups stay in its own namespace.
    expect(
      where(acls, { principal: OPS_REPLAY_PRINCIPAL, resourceType: 'GROUP' }).map((acl) => [
        acl.resourceName,
        acl.patternType,
        acl.operation,
      ]),
    ).toEqual([[`${OPS_REPLAY_PRINCIPAL}.`, 'PREFIXED', 'READ']]);
  });

  it('grants groups only by prefix, and only within the principal’s own namespace (tools only describe)', () => {
    for (const acl of where(acls, { resourceType: 'GROUP' })) {
      expect(acl.patternType).toBe('PREFIXED');
      expect(acl.resourceName.endsWith('.')).toBe(true);
      if (acl.operation === 'READ') expect(acl.resourceName).toBe(`${acl.principal}.`);
      else expect([acl.principal, acl.operation]).toEqual([acl.principal, 'DESCRIBE']);
    }
  });

  it('has no wildcard principal, no literal * resource and no prefix shorter than a namespace', () => {
    for (const acl of acls) {
      expect(acl.principal).not.toMatch(/\*/);
      expect(acl.resourceName).not.toBe('*');
      expect(acl.resourceName.length).toBeGreaterThan(0);
      if (acl.patternType === 'PREFIXED') expect(acl.resourceName).toMatch(/^[a-z][a-z0-9-]*\.$/);
    }
  });

  it('never names the admin, which is a super user used only to bootstrap', () => {
    expect(principalsOf(acls)).not.toContain(BROKER_ADMIN_PRINCIPAL);
    expect(brokerPrincipals(profile)).not.toContain(BROKER_ADMIN_PRINCIPAL);
  });

  it('never lets a service write a topic it does not own, or read one it does not subscribe to', () => {
    const services = new Set([
      ...Object.values(TOPIC_PRODUCERS).flat(),
      ...Object.keys(TOPIC_CONSUMERS),
    ]);
    for (const acl of acls.filter((a) => services.has(a.principal) && a.resourceType === 'TOPIC')) {
      if (acl.operation === 'WRITE') {
        const owned = Object.entries(TOPIC_PRODUCERS)
          .filter(([, producers]) => (producers as readonly string[]).includes(acl.principal))
          .map(([topic]) => topic);
        const dlq = (TOPIC_CONSUMERS as Record<string, { deadLetterTopic: string }>)[acl.principal]
          ?.deadLetterTopic;
        expect([...owned, dlq]).toContain(acl.resourceName);
      }
    }
  });
});

describe('profiles', () => {
  it('gives deployment no development principal', () => {
    const principals = [
      ...principalsOf(brokerAcls('deployment')),
      ...brokerPrincipals('deployment'),
    ];
    for (const name of DEVELOPMENT) expect(principals).not.toContain(name);
  });

  it('gives development exactly the three tools on top of deployment', () => {
    expect(brokerPrincipals('development')).toEqual(
      [...brokerPrincipals('deployment'), ...DEVELOPMENT].sort(),
    );
  });

  it('lists a credential for every principal that has a binding', () => {
    for (const profile of PROFILES) {
      for (const principal of principalsOf(brokerAcls(profile))) {
        expect(brokerPrincipals(profile)).toContain(principal);
      }
    }
  });
});

describe('the development principals', () => {
  it('only ever read or describe: the observer, the UI and the exporter write nothing', () => {
    const acls = brokerAcls('development');
    for (const principal of DEVELOPMENT) {
      expect(where(acls, { principal, operation: 'WRITE' })).toEqual([]);
    }
  });
});

describe('the committed bootstrap files', () => {
  const dir = resolve(__dirname, '../../../../infrastructure/docker/kafka');
  const lines = (file: string) =>
    readFileSync(resolve(dir, file), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#'));

  it.each(PROFILES)(
    'broker-acls.%s.json is what the contracts generate (run `pnpm kafka:acl:generate`)',
    (profile) => {
      const committed: unknown = JSON.parse(
        readFileSync(resolve(dir, `broker-acls.${profile}.json`), 'utf8'),
      );
      expect(committed).toEqual(brokerAclDocument(profile));
    },
  );

  it.each(PROFILES)('principals.%s.txt lists the same principals, one per line', (profile) => {
    expect(lines(`principals.${profile}.txt`)).toEqual(brokerPrincipals(profile));
  });

  it('topics.txt is what the contracts generate', () => {
    expect(lines('topics.txt')).toEqual(brokerTopics().map((t) => `${t.name} ${t.kind}`));
  });

  it('creates exactly the topics the contracts and the ACLs name — no more, no fewer (review of #131, #2)', () => {
    const created = new Set(brokerTopics().map((topic) => topic.name));
    const named = new Set<string>();
    for (const name of DECLARED_TOPICS) {
      named.add(name);
      named.add(`${name}.retry`);
    }
    for (const name of DEAD_LETTERS) named.add(name);
    for (const profile of PROFILES) {
      for (const acl of brokerAcls(profile)) {
        if (acl.resourceType === 'TOPIC' && acl.patternType === 'LITERAL')
          named.add(acl.resourceName);
      }
    }
    expect([...created].sort()).toEqual([...named].sort());
    expect(created).toContain('rasta.audit.trail.v1.retry');
  });

  it('create-topics.sh creates from topics.txt, with no topic list of its own', () => {
    const script = readFileSync(resolve(dir, 'create-topics.sh'), 'utf8');
    expect(script).toContain('topics.txt');
    expect(script).not.toMatch(/rasta\.[a-z]+\.v1/);
  });

  it('create-topics.sh connects only as the admin over SASL_SSL', () => {
    const script = readFileSync(resolve(dir, 'create-topics.sh'), 'utf8');
    expect(script).toContain(':?the admin password is not set');
    expect(script).toContain("echo 'security.protocol=SASL_SSL'");
    const calls = script.split('\n').filter((line) => /"\$\{KAFKA_BIN\}"\/kafka-/.test(line));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain('"${ADMIN_CONFIG[@]}"');
  });
});
