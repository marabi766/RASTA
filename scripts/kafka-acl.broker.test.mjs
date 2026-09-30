/**
 * The authenticated broker, as bootstrapped (RUN-006, ADR-061 § 3): what each
 * principal may and may not do, asked of the broker itself.
 *
 *   node --test scripts/kafka-acl.broker.test.mjs
 *
 * Needs the broker `infrastructure/docker/kafka/ci-up.sh` (CI) or
 * `pnpm infra:up` (locally) starts, and the environment it exports:
 * KAFKA_BROKERS, KAFKA_SSL_CA_FILE and every KAFKA_SASL_PASSWORD_<NAME>. Without
 * them it refuses to run rather than skip — a skipped broker test is a green
 * that proves nothing.
 *
 * Every allowed write here is a real record, `{"aclTest":"<run>"}`, on a real
 * platform topic (a producer's, a dead-letter or a retry topic). A consumer
 * running against the same broker dead-letters it as VALIDATION_FAILED; run
 * this against a broker nothing else is consuming from — CI runs it last.
 *
 * The rules under test come from TOPIC_PRODUCERS and TOPIC_CONSUMERS through
 * the generated `broker-acls.development.json` (the profile compose and CI
 * apply); each case below is one of them, observed:
 *   - only a topic's owner writes it; a service reads only what it subscribes
 *     to, under groups in its own namespace;
 *   - a service writes only its own dead-letter topic; only `ops-replay`
 *     writes `.retry` topics and reads dead-letter topics, and it reads an
 *     original topic (the replay tool's staleness check) only in its own
 *     groups, never writing it;
 *   - no password, a wrong password, an unknown principal or SASL/PLAIN (even
 *     with a real password) is refused, and so is PLAINTEXT;
 *   - no principal but the admin creates a topic, by request or by producing;
 *   - an idempotent producer needs nothing beyond WRITE on its topic.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import kafkajs from 'kafkajs';
import { connectionFor, diffAcls, fromDescribe, passwordVariable } from './kafka-acl-lib.mjs';

const {
  Kafka,
  logLevel,
  AclResourceTypes,
  AclOperationTypes,
  AclPermissionTypes,
  ResourcePatternTypes,
} = kafkajs;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(
  readFileSync(resolve(ROOT, 'infrastructure/docker/kafka/broker-acls.development.json'), 'utf8'),
);
const configuredCa = process.env.KAFKA_SSL_CA_FILE?.trim();
const env = {
  ...process.env,
  KAFKA_SSL_CA_FILE:
    configuredCa && isAbsolute(configuredCa)
      ? configuredCa
      : resolve(ROOT, 'infrastructure/docker/kafka/.tls/ca.pem'),
};
const read = (path) => readFileSync(path, 'utf8');

// Kafka UI's and the exporter's development passwords live only in
// docker-compose.yml's interpolation defaults — in no env file, so no process
// loads them by accident. Locally, take them from there; CI's `admin` scope
// sets them explicitly, and an explicit value always wins.
const compose = read(resolve(ROOT, 'docker-compose.yml'));
for (const principal of ['kafka-ui', 'kafka-exporter']) {
  const variable = passwordVariable(principal);
  const fallback = new RegExp(`\\$\\{${variable}:-([^}]+)\\}`).exec(compose);
  if (!env[variable] && fallback) env[variable] = fallback[1];
}

const missing = [spec.admin, ...spec.principals]
  .map(passwordVariable)
  .filter((variable) => !env[variable]);
if (missing.length > 0) {
  throw new Error(
    `the broker tests need the bootstrap's environment; missing ${missing.join(', ')} ` +
      '(in CI, the `admin` scope of infrastructure/docker/kafka/kafka-credentials.sh; locally, ' +
      '`pnpm test:kafka-acl-broker`, which loads .env and infrastructure/docker/kafka/bootstrap.env.example)',
  );
}

const run = randomUUID().slice(0, 8);
const clients = [];

/** A kafkajs client as `principal`, failing fast: a refusal is the answer, not a retry. */
function client(principal, overrides = {}) {
  const kafka = new Kafka({
    ...connectionFor(principal, env, read),
    clientId: `acl-test-${principal}-${run}`,
    logLevel: logLevel.NOTHING,
    connectionTimeout: 5_000,
    retry: { retries: 0 },
    ...overrides,
  });
  return kafka;
}

async function connected(entity) {
  await entity.connect();
  clients.push(entity);
  return entity;
}

async function produce(principal, topic, options = {}) {
  const producer = await connected(
    client(principal).producer({ allowAutoTopicCreation: false, ...options }),
  );
  await producer.send({
    topic,
    acks: -1,
    messages: [{ key: run, value: JSON.stringify({ aclTest: run }) }],
  });
}

/**
 * One committed transaction under `transactionalId`, writing a marker to
 * `topic`. `retries` lets the allowed case wait out a transaction coordinator
 * that a fresh broker loads on first use; kafkajs refuses an idempotent
 * producer without at least one, and an authorization error is never retried.
 */
async function transact(principal, transactionalId, topic, retries = 1) {
  const producer = await connected(
    client(principal, { retry: { retries, initialRetryTime: 300 } }).producer({
      transactionalId,
      idempotent: true,
      maxInFlightRequests: 1,
      allowAutoTopicCreation: false,
    }),
  );
  const transaction = await producer.transaction();
  await transaction.send({
    topic,
    acks: -1,
    messages: [{ key: run, value: JSON.stringify({ aclTest: run }) }],
  });
  await transaction.commit();
}

/**
 * What stopped a call: the broker's error type (`TOPIC_AUTHORIZATION_FAILED`)
 * when kafkajs carries one anywhere down its wrapping chain, else the kafkajs
 * error's name. kafkajs wraps a protocol error in a non-retriable one.
 */
function reason(error) {
  for (let cause = error, depth = 0; cause && depth < 8; depth += 1) {
    if (typeof cause.type === 'string') return cause.type;
    cause = cause.originalError ?? cause.cause;
  }
  return error?.name ?? String(error);
}

/** `ALLOWED`, or the reason the call was refused. */
async function refusal(action) {
  try {
    await action();
  } catch (error) {
    return reason(error);
  }
  return 'ALLOWED';
}

/**
 * Waits until the broker can coordinate `groupId`, asked as the admin.
 *
 * Each group lives on one `__consumer_offsets` partition, and on a broker that
 * has just started those partitions finish loading one by one. Until then a
 * join fails with "coordinator not found" — which is also how kafkajs reports
 * a GROUP_AUTHORIZATION_FAILED. Asking first as the admin, for the very same
 * group, is what makes a later refusal an answer about the ACLs alone.
 */
async function coordinatorReady(groupId) {
  const admin = await connected(
    client(spec.admin, { retry: { initialRetryTime: 300, retries: 10 } }).admin(),
  );
  await admin.describeGroups([groupId]);
}

/**
 * Joins `groupId` as `principal`, subscribed to `topic`, and resolves once the
 * group is joined — or with the refusal that stopped it.
 */
async function consume(principal, groupId, topic) {
  await coordinatorReady(groupId);
  const consumer = client(principal).consumer({
    groupId,
    sessionTimeout: 10_000,
    retry: { retries: 0 },
  });
  clients.push(consumer);
  return new Promise((resolveJoin) => {
    const timer = setTimeout(() => resolveJoin('TIMEOUT'), 30_000);
    const done = (outcome) => {
      clearTimeout(timer);
      resolveJoin(outcome);
    };
    consumer.on(consumer.events.GROUP_JOIN, () => done('JOINED'));
    consumer.on(consumer.events.CRASH, ({ payload }) => done(reason(payload?.error)));
    (async () => {
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: false });
      await consumer.run({ eachMessage: async () => undefined });
    })().catch((error) => done(reason(error)));
  });
}

after(async () => {
  await Promise.allSettled(clients.map((entity) => entity.disconnect()));
});

describe('the broker holds exactly the generated ACLs', () => {
  test('describeAcls as admin equals broker-acls.development.json', async () => {
    const admin = await connected(client(spec.admin).admin());
    const { resources } = await admin.describeAcls({
      resourceType: AclResourceTypes.ANY,
      resourcePatternType: ResourcePatternTypes.ANY,
      operation: AclOperationTypes.ANY,
      permissionType: AclPermissionTypes.ANY,
    });
    assert.deepEqual(diffAcls(spec.acls, fromDescribe(resources)), { add: [], remove: [] });
  });
});

describe('3. only a topic’s owner writes it', () => {
  test('fleet-service writes rasta.fleet.v1', async () => {
    assert.equal(await refusal(() => produce('fleet-service', 'rasta.fleet.v1')), 'ALLOWED');
  });

  test('fleet-service may not write economic-service’s topic', async () => {
    assert.equal(
      await refusal(() => produce('fleet-service', 'rasta.economic.v1')),
      'TOPIC_AUTHORIZATION_FAILED',
    );
  });

  test('identity-service alone writes the audit trail; asset-service may not', async () => {
    assert.equal(
      await refusal(() => produce('identity-service', 'rasta.audit.trail.v1')),
      'ALLOWED',
    );
    assert.equal(
      await refusal(() => produce('asset-service', 'rasta.audit.trail.v1')),
      'TOPIC_AUTHORIZATION_FAILED',
    );
  });

  test('only marketplace-service writes rasta.marketplace.v1 — the source D-036 depends on', async () => {
    // supplier-service's performance consumer records facts from this topic.
    // SASL alone would still let every authenticated service write it; the
    // per-topic ACL is what leaves marketplace-service the only writer.
    assert.equal(
      await refusal(() => produce('marketplace-service', 'rasta.marketplace.v1')),
      'ALLOWED',
    );
    for (const principal of ['supplier-service', 'economic-service', 'ops-replay']) {
      assert.equal(
        await refusal(() => produce(principal, 'rasta.marketplace.v1')),
        'TOPIC_AUTHORIZATION_FAILED',
        principal,
      );
    }
  });

  test('the development observer and Kafka UI write nothing', async () => {
    for (const principal of ['itest-observer', 'kafka-ui', 'kafka-exporter']) {
      assert.equal(
        await refusal(() => produce(principal, 'rasta.fleet.v1')),
        'TOPIC_AUTHORIZATION_FAILED',
        principal,
      );
    }
  });
});

describe('4. a service reads what it subscribes to, in its own group namespace', () => {
  test('maintenance-service joins its own group on rasta.fleet.v1', async () => {
    assert.equal(
      await consume('maintenance-service', `maintenance-service.acl-test-${run}`, 'rasta.fleet.v1'),
      'JOINED',
    );
  });

  test('maintenance-service may not join a group in fleet-service’s namespace', async () => {
    // The broker answers FindCoordinator with GROUP_AUTHORIZATION_FAILED, which
    // kafkajs reports as "coordinator not found". `consume` has just had the
    // admin find this group's coordinator, so it is there.
    assert.equal(
      await consume('maintenance-service', `fleet-service.acl-test-${run}`, 'rasta.fleet.v1'),
      'KafkaJSGroupCoordinatorNotFound',
    );
  });

  test('marketplace-service, which subscribes to nothing, may not read rasta.economic.v1', async () => {
    const outcome = await consume(
      'marketplace-service',
      `marketplace-service.acl-test-${run}`,
      'rasta.economic.v1',
    );
    assert.match(outcome, /AUTHORIZATION_FAILED/);
  });

  test('fleet-service may not read economic-service’s topic even in its own namespace', async () => {
    const outcome = await consume(
      'fleet-service',
      `fleet-service.acl-test-${run}`,
      'rasta.economic.v1',
    );
    assert.equal(outcome, 'TOPIC_AUTHORIZATION_FAILED');
  });
});

describe('5. dead-letter and retry topics', () => {
  test('a service writes its own dead-letter topic and no other', async () => {
    assert.equal(
      await refusal(() => produce('maintenance-service', 'rasta.maintenance.v1.dlq')),
      'ALLOWED',
    );
    assert.equal(
      await refusal(() => produce('maintenance-service', 'rasta.fleet.v1.dlq')),
      'TOPIC_AUTHORIZATION_FAILED',
    );
  });

  test('a service reads the .retry twin of what it subscribes to, but may not write it', async () => {
    assert.equal(
      await consume(
        'maintenance-service',
        `maintenance-service.acl-retry-${run}`,
        'rasta.fleet.v1.retry',
      ),
      'JOINED',
    );
    assert.equal(
      await refusal(() => produce('maintenance-service', 'rasta.fleet.v1.retry')),
      'TOPIC_AUTHORIZATION_FAILED',
    );
  });

  test('a service may not read another’s dead-letter topic', async () => {
    assert.equal(
      await consume('fleet-service', `fleet-service.acl-dlq-${run}`, 'rasta.maintenance.v1.dlq'),
      'TOPIC_AUTHORIZATION_FAILED',
    );
  });

  test('ops-replay reads dead-letter topics and writes .retry topics, and nothing else', async () => {
    assert.equal(
      await consume('ops-replay', `ops-replay.acl-test-${run}`, 'rasta.maintenance.v1.dlq'),
      'JOINED',
    );
    assert.equal(await refusal(() => produce('ops-replay', 'rasta.fleet.v1.retry')), 'ALLOWED');
    assert.equal(
      await refusal(() => produce('ops-replay', 'rasta.fleet.v1')),
      'TOPIC_AUTHORIZATION_FAILED',
    );
    assert.equal(
      await refusal(() => produce('ops-replay', 'rasta.fleet.v1.dlq')),
      'TOPIC_AUTHORIZATION_FAILED',
    );
  });

  test('ops-replay reads an original topic — the staleness check — only in its own groups, and never writes it', async () => {
    assert.equal(
      await consume('ops-replay', `ops-replay.acl-stale-${run}`, 'rasta.fleet.v1'),
      'JOINED',
    );
    // Another namespace's group: refused as GROUP_AUTHORIZATION_FAILED, which
    // kafkajs reports as "coordinator not found" (as in § 4).
    assert.equal(
      await consume('ops-replay', `maintenance-service.acl-stale-${run}`, 'rasta.fleet.v1'),
      'KafkaJSGroupCoordinatorNotFound',
    );
    assert.equal(
      await refusal(() => produce('ops-replay', 'rasta.fleet.v1')),
      'TOPIC_AUTHORIZATION_FAILED',
    );
  });

  test('ops-replay alone writes its replay record, rasta.ops.replay.v1, and still no original of anyone else', async () => {
    assert.equal(await refusal(() => produce('ops-replay', 'rasta.ops.replay.v1')), 'ALLOWED');
    // Not the services — the audit-service that reads it least of all.
    for (const principal of ['audit-service', 'fleet-service', 'identity-service']) {
      assert.equal(
        await refusal(() => produce(principal, 'rasta.ops.replay.v1')),
        'TOPIC_AUTHORIZATION_FAILED',
        principal,
      );
    }
    for (const topic of ['rasta.fleet.v1', 'rasta.audit.trail.v1', 'rasta.economic.v1.retry']) {
      assert.equal(
        await refusal(() => produce('ops-replay', topic)),
        'TOPIC_AUTHORIZATION_FAILED',
        topic,
      );
    }
  });

  test('ops-replay alone uses transactional ids, and only its own: ops-replay.*', async () => {
    // Each replay and its REPLAY_EXECUTED record are one transaction (round 1 on #166).
    assert.equal(
      await refusal(() =>
        transact('ops-replay', `ops-replay.acl-${run}`, 'rasta.fleet.v1.retry', 10),
      ),
      'ALLOWED',
    );
    for (const [principal, transactionalId, topic] of [
      ['ops-replay', `fleet-service.acl-${run}`, 'rasta.fleet.v1.retry'],
      ['fleet-service', `fleet-service.acl-${run}`, 'rasta.fleet.v1'],
      ['fleet-service', `ops-replay.acl-other-${run}`, 'rasta.fleet.v1'],
    ]) {
      // The control: the admin, a super user, runs the same transactional id,
      // so its coordinator is known to be up and the refusal below is the
      // ACL's alone. kafkajs reports TRANSACTIONAL_ID_AUTHORIZATION_FAILED on
      // FindCoordinator as "coordinator not found", as it does for groups (§ 4).
      assert.equal(
        await refusal(() => transact(spec.admin, transactionalId, topic, 10)),
        'ALLOWED',
        `admin control as ${transactionalId}`,
      );
      assert.ok(
        ['TRANSACTIONAL_ID_AUTHORIZATION_FAILED', 'KafkaJSGroupCoordinatorNotFound'].includes(
          await refusal(() => transact(principal, transactionalId, topic)),
        ),
        `${principal} as ${transactionalId} must be refused`,
      );
    }
  });

  test('ops-replay may neither read the economic stream nor write its .retry — it never replays it', async () => {
    assert.equal(
      await consume('ops-replay', `ops-replay.acl-economic-${run}`, 'rasta.economic.v1'),
      'TOPIC_AUTHORIZATION_FAILED',
    );
    assert.equal(
      await refusal(() => produce('ops-replay', 'rasta.economic.v1.retry')),
      'TOPIC_AUTHORIZATION_FAILED',
    );
  });
});

describe('6. authentication', () => {
  /** Connects and writes one record to fleet-service's own topic, as `overrides` configure. */
  const write = (overrides) => async () => {
    const producer = await connected(
      client('fleet-service', overrides).producer({ allowAutoTopicCreation: false }),
    );
    await producer.send({ topic: 'rasta.fleet.v1', acks: -1, messages: [{ value: run }] });
  };

  test('the control: fleet-service’s own credential writes', async () => {
    assert.equal(await refusal(write({})), 'ALLOWED');
  });

  test('a wrong password is refused', async () => {
    const sasl = {
      mechanism: 'scram-sha-512',
      username: 'fleet-service',
      password: `wrong-${run}`,
    };
    assert.equal(await refusal(write({ sasl })), 'KafkaJSSASLAuthenticationError');
  });

  test('an unknown principal is refused', async () => {
    const sasl = {
      mechanism: 'scram-sha-512',
      username: 'contract-service',
      password: `any-${run}`,
    };
    assert.equal(await refusal(write({ sasl })), 'KafkaJSSASLAuthenticationError');
  });

  test('SASL/PLAIN is refused, even with fleet-service’s real password', async () => {
    const sasl = {
      mechanism: 'plain',
      username: 'fleet-service',
      password: env[passwordVariable('fleet-service')],
    };
    assert.equal(await refusal(write({ sasl })), 'UNSUPPORTED_SASL_MECHANISM');
  });

  test('TLS without SASL is refused', async () => {
    assert.notEqual(await refusal(write({ sasl: undefined })), 'ALLOWED');
  });

  test('PLAINTEXT is refused', async () => {
    assert.notEqual(await refusal(write({ sasl: undefined, ssl: false })), 'ALLOWED');
  });

  test('a broker certificate the client does not trust is refused', async () => {
    assert.notEqual(await refusal(write({ ssl: { rejectUnauthorized: true } })), 'ALLOWED');
  });
});

describe('7. no service creates a topic', () => {
  test('by request', async () => {
    const admin = await connected(client('fleet-service').admin());
    const outcome = await refusal(() =>
      admin.createTopics({ topics: [{ topic: `rasta.fleet.v1.acl-test-${run}` }] }),
    );
    assert.match(outcome, /AUTHORIZATION_FAILED|KafkaJSAggregateError/);
    const admins = await connected(client(spec.admin).admin());
    assert.ok(!(await admins.listTopics()).includes(`rasta.fleet.v1.acl-test-${run}`));
  });

  test('by producing to a topic that does not exist', async () => {
    const outcome = await refusal(() =>
      produce('fleet-service', `rasta.fleet.v1.acl-auto-${run}`, { allowAutoTopicCreation: true }),
    );
    assert.notEqual(outcome, 'ALLOWED');
    const admin = await connected(client(spec.admin).admin());
    assert.ok(!(await admin.listTopics()).includes(`rasta.fleet.v1.acl-auto-${run}`));
  });
});

describe('8. the idempotent producer every service runs needs only WRITE on its topic', () => {
  // As the services configure it; kafkajs requires retries for idempotence.
  const IDEMPOTENT = { idempotent: true, maxInFlightRequests: 1, retry: { retries: 2 } };

  test('fleet-service connects idempotently and writes with acks=all', async () => {
    assert.equal(
      await refusal(() => produce('fleet-service', 'rasta.fleet.v1', IDEMPOTENT)),
      'ALLOWED',
    );
  });

  test('and still may not write a topic it does not own', async () => {
    assert.equal(
      await refusal(() => produce('fleet-service', 'rasta.asset.v1', IDEMPOTENT)),
      'TOPIC_AUTHORIZATION_FAILED',
    );
  });
});
