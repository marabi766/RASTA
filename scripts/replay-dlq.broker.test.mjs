/**
 * The DLQ replay tool against the live, authenticated broker, end to end with
 * the platform's own consumer (RUN-006, D-039/D-040 via #145;
 * docs/runbooks/replay-dlq.md).
 *
 * The consumer is a real `EventConsumer` (`@rasta/nest-common`), as
 * maintenance-service, subscribed to `rasta.fleet.v1` — and therefore to its
 * `.retry` twin (#145). Its handler rejects the events this run names, so the
 * dead letters are the real ones `EventConsumer.deadLetter` writes: the
 * original body, the platform headers with `x-producer` overwritten by the
 * consumer, the `x-dlq-*` headers, and the kept key. The one exception is two
 * keyless dead letters, written by hand to stand for ones dead-lettered before
 * #145 kept keys.
 *
 * The tool runs as a child process whose environment holds **only**
 * ops-replay's credential. A replay is proven twice: consumed by the real
 * consumer from `rasta.fleet.v1.retry` (the producer check passing there), and
 * read off the wire by the observer (key, body, headers).
 *
 * It needs fleet-service, maintenance-service, itest-observer and ops-replay's
 * passwords, and the broker admin's, and refuses to run rather than skip
 * without them. It writes marker records on real topics: run it where no
 * other maintenance-service consumer is reading rasta.fleet.v1.
 *
 * The last test deletes records from one rasta.fleet.v1 partition, as
 * retention would — irreversibly. It runs only on a broker declared
 * disposable (`REPLAY_TEST_DISPOSABLE_BROKER=1`, which CI's fresh broker job
 * sets), and even there it deletes nothing unless every record it would
 * delete was written by this run; anywhere else it is skipped, and says so.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import kafkajs from 'kafkajs';
import { connectionFor, passwordVariable } from './kafka-acl-lib.mjs';

const { Kafka, logLevel } = kafkajs;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const contracts = require(resolve(ROOT, 'packages/contracts/dist/index.js'));
const nestCommon = require(resolve(ROOT, 'packages/nest-common/dist/index.js'));
const { EVENT_HEADERS, DLQ_HEADERS, DLQ_REASONS, REPLAY_HEADERS, BROKER_ADMIN_PRINCIPAL } =
  contracts;
const { EventConsumer, UnprocessableEventError, kafkaConnectionFor } = nestCommon;

const ORIGINAL = 'rasta.fleet.v1';
const RETRY = 'rasta.fleet.v1.retry';
/** The replay record: one REPLAY_EXECUTED per executed replay, written by the tool. */
const OPS_REPLAY = 'rasta.ops.replay.v1';
const DLQ = 'rasta.maintenance.v1.dlq';
const OPERATOR = 'replay-itest';
/** Records may be deleted only on a broker declared throwaway (CI's fresh one). */
const DISPOSABLE_BROKER = process.env.REPLAY_TEST_DISPOSABLE_BROKER === '1';

const configuredCa = process.env.KAFKA_SSL_CA_FILE?.trim();
const CA =
  configuredCa && isAbsolute(configuredCa)
    ? configuredCa
    : resolve(ROOT, 'infrastructure/docker/kafka/.tls/ca.pem');
const env = { ...process.env, KAFKA_SSL_CA_FILE: CA, KAFKA_SSL: 'true' };
const read = (path) => readFileSync(path, 'utf8');
const PRINCIPALS = [
  'fleet-service',
  'maintenance-service',
  'itest-observer',
  'ops-replay',
  BROKER_ADMIN_PRINCIPAL,
];
const missing = PRINCIPALS.map(passwordVariable).filter((variable) => !process.env[variable]);
if (missing.length > 0) {
  throw new Error(
    `the replay broker test needs ${missing.join(', ')} (in CI, the admin scope of kafka-credentials.sh; ` +
      'locally, `pnpm test:replay-dlq-broker`, which loads .env and the bootstrap env file)',
  );
}

const run = randomUUID().slice(0, 8);
const TENANT = `ORG_REPLAY_${run}`;
const clients = [];
const kafka = (principal) =>
  new Kafka({
    ...connectionFor(principal, env, read),
    clientId: `replay-itest-${principal}-${run}`,
    logLevel: logLevel.NOTHING,
    retry: { retries: 3 },
  });

async function connected(entity) {
  clients.push(entity);
  await entity.connect();
  return entity;
}

async function eventually(what, probe, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((settle) => setTimeout(settle, 250));
  }
}

/** Everything on `topic` from `since` (partition → next offset) to the current end, as `principal`. */
async function readSince(principal, topic, since) {
  const client = kafka(principal);
  const admin = await connected(client.admin());
  const ends = await admin.fetchTopicOffsets(topic);
  const pending = new Map();
  for (const { partition, high } of ends) {
    const from = since.get(partition) ?? BigInt(high);
    if (from < BigInt(high)) pending.set(partition, { from, to: BigInt(high) });
  }
  if (pending.size === 0) return [];
  const consumer = await connected(
    client.consumer({ groupId: `itest-observer.replay-${run}-${randomUUID().slice(0, 6)}` }),
  );
  await consumer.subscribe({ topic, fromBeginning: false });
  const records = [];
  await new Promise((resolveRead, rejectRead) => {
    const timer = setTimeout(() => rejectRead(new Error(`timed out reading ${topic}`)), 60_000);
    consumer
      .run({
        autoCommit: false,
        eachBatch: async ({ batch }) => {
          const range = pending.get(batch.partition);
          if (!range) return;
          for (const message of batch.messages) {
            const offset = BigInt(message.offset);
            if (offset >= range.from && offset < range.to) {
              records.push({ partition: batch.partition, ...message });
            }
          }
          if (BigInt(batch.lastOffset()) + 1n >= range.to) pending.delete(batch.partition);
          if (pending.size === 0) {
            clearTimeout(timer);
            resolveRead();
          }
        },
      })
      .then(() => {
        for (const [partition, { from }] of pending) {
          consumer.seek({ topic, partition, offset: String(from) });
        }
      })
      .catch(rejectRead);
  });
  await consumer.stop();
  return records;
}

async function endOffsets(topic) {
  const admin = await connected(kafka('itest-observer').admin());
  const offsets = await admin.fetchTopicOffsets(topic);
  return new Map(offsets.map(({ partition, high }) => [partition, BigInt(high)]));
}

/** The CLI, as an operator runs it: nothing in its environment but ops-replay's credential. */
function replay(
  args,
  { operator = OPERATOR, password = process.env.KAFKA_SASL_PASSWORD_OPS_REPLAY } = {},
) {
  const childEnv = {
    PATH: process.env.PATH,
    KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
    KAFKA_SSL_CA_FILE: CA,
  };
  if (password) childEnv.KAFKA_SASL_PASSWORD_OPS_REPLAY = password;
  if (operator) childEnv.REPLAY_OPERATOR = operator;
  const result = spawnSync(
    'node',
    [resolve(ROOT, 'scripts/replay-dlq.mjs'), '--dlq', DLQ, ...args],
    { env: childEnv, encoding: 'utf8', timeout: 180_000 },
  );
  const lines = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    status: result.status,
    stderr: result.stderr,
    records: lines.filter((line) => !line.summary),
    summary: lines.find((line) => line.summary),
  };
}

function envelope(eventId, streamKey, overrides = {}) {
  return {
    eventId,
    eventName: 'USAGE_RECORDED',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'fleet-service',
    producerVersion: '1.0.0',
    aggregateType: 'UsageRecord',
    aggregateId: `USG_${eventId}`,
    tenantId: TENANT,
    correlationId: `COR_${run}`,
    ...(streamKey ? { streamKey, streamSeq: 1 } : {}),
    payload: { marker: `replay-itest-${run}` },
    ...overrides,
  };
}

const ids = {
  replayable: `EVT_RPL_OK_${run}`,
  stale: `EVT_RPL_STALE_${run}`,
  newer: `EVT_RPL_NEWER_${run}`,
  unsequenced: `EVT_RPL_UNSEQ_${run}`,
  financial: `EVT_RPL_MONEY_${run}`,
  unconfirmed: `EVT_RPL_UNCONF_${run}`,
  again: `EVT_RPL_AGAIN_${run}`,
  keyless: `EVT_RPL_KEYLESS_${run}`,
  keylessSequenced: `EVT_RPL_KEYLESS_SEQ_${run}`,
  expired: `EVT_RPL_EXPIRED_${run}`,
  expiredNewer: `EVT_RPL_EXPIRED_NEWER_${run}`,
};
const keys = {
  replayable: `AST_OK_${run}`,
  stale: `AST_STALE_${run}`,
  again: `AST_AGAIN_${run}`,
  expired: `AST_EXPIRED_${run}`,
};
/** The events the consumer rejects on their first delivery from the original topic, and why. */
const REJECT_ON_ORIGINAL = new Map([
  [ids.replayable, DLQ_REASONS.BUSINESS_RULE_VIOLATION],
  [ids.stale, DLQ_REASONS.BUSINESS_RULE_VIOLATION],
  [ids.unsequenced, DLQ_REASONS.BUSINESS_RULE_VIOLATION],
  [ids.financial, DLQ_REASONS.BUSINESS_RULE_VIOLATION],
  [ids.unconfirmed, DLQ_REASONS.SOURCE_UNCONFIRMED],
  [ids.again, DLQ_REASONS.BUSINESS_RULE_VIOLATION],
  [ids.expired, DLQ_REASONS.BUSINESS_RULE_VIOLATION],
]);
/** Rejected once more when replayed, so it is dead-lettered from `.retry`. */
const REJECT_ONCE_ON_RETRY = new Set([ids.again]);

/** What the real consumer was delivered, from which topic. */
const deliveries = [];
const bodies = new Map();
let consumer;
let originalEnds;

const deliveredFrom = (eventId, topic) =>
  deliveries.some((d) => d.eventId === eventId && d.topic === topic);

/** Our dead letters currently on the DLQ, by event id and origin. */
async function deadLetters(since) {
  const records = await readSince('itest-observer', DLQ, since);
  return records
    .map((record) => ({
      eventId:
        record.headers?.[EVENT_HEADERS.eventId]?.toString() ??
        JSON.parse(record.value?.toString() ?? '{}').eventId,
      originalTopic: record.headers?.[DLQ_HEADERS.originalTopic]?.toString(),
      partition: record.partition,
      offset: record.offset,
      key: record.key?.toString() ?? null,
      producer: record.headers?.[EVENT_HEADERS.producer]?.toString(),
    }))
    .filter((d) => Object.values(ids).includes(d.eventId));
}
let dlqStart;
let opsReplayStart;

/** This run's replay records, by report id. */
async function replayRecords(reportId) {
  return (await readSince('itest-observer', OPS_REPLAY, opsReplayStart))
    .filter((m) => m.key?.toString() === reportId)
    .map((m) => ({
      key: m.key.toString(),
      headers: m.headers,
      body: JSON.parse(m.value.toString()),
    }));
}

before(async () => {
  dlqStart = await endOffsets(DLQ);
  opsReplayStart = await endOffsets(OPS_REPLAY);

  consumer = new EventConsumer(
    {
      ...kafkaConnectionFor(
        'maintenance-service',
        `maintenance-service-replay-itest-${run}`,
        env,
        read,
      ),
      groupId: `maintenance-service.replay-itest-${run}`,
      topics: [ORIGINAL],
      deadLetterTopic: DLQ,
      fromBeginning: false,
      retryBackoffMs: 50,
    },
    async (event, delivery) => {
      if (event.tenantId !== TENANT) return 'SKIPPED';
      deliveries.push({ eventId: event.eventId, topic: delivery.topic });
      const reason = REJECT_ON_ORIGINAL.get(event.eventId);
      if (delivery.topic === ORIGINAL && reason) {
        throw new UnprocessableEventError(reason, 'replay-itest: rejected by the harness');
      }
      if (delivery.topic === RETRY && REJECT_ONCE_ON_RETRY.delete(event.eventId)) {
        throw new UnprocessableEventError(
          DLQ_REASONS.BUSINESS_RULE_VIOLATION,
          'replay-itest: rejected again on .retry',
        );
      }
      return undefined;
    },
    { log: () => undefined, warn: () => undefined, error: () => undefined },
  );
  await consumer.start();

  const fleet = await connected(
    kafka('fleet-service').producer({ idempotent: true, maxInFlightRequests: 1 }),
  );
  const publish = async (original) => {
    const value = JSON.stringify(original);
    bodies.set(original.eventId, value);
    // As the outbox relay publishes (nest-common outbox `buildHeaders`).
    const headers = {
      [EVENT_HEADERS.eventId]: original.eventId,
      [EVENT_HEADERS.eventName]: original.eventName,
      [EVENT_HEADERS.eventVersion]: String(original.eventVersion),
      [EVENT_HEADERS.correlationId]: original.correlationId,
      [EVENT_HEADERS.producer]: original.producer,
      [EVENT_HEADERS.tenantId]: original.tenantId,
    };
    if (original.streamSeq !== undefined) {
      headers[EVENT_HEADERS.streamSeq] = String(original.streamSeq);
    }
    await fleet.send({
      topic: ORIGINAL,
      acks: -1,
      messages: [{ key: original.streamKey ?? original.aggregateId, value, headers }],
    });
  };

  // The consumer has joined once a warm-up event reaches it.
  const warmUp = `EVT_RPL_WARM_${run}`;
  await eventually('the consumer to join', async () => {
    await publish(envelope(warmUp, `AST_WARM_${run}`));
    return deliveredFrom(warmUp, ORIGINAL);
  });

  for (const original of [
    envelope(ids.replayable, keys.replayable),
    envelope(ids.stale, keys.stale),
    envelope(ids.unsequenced, null),
    envelope(ids.financial, `AST_MONEY_${run}`, { eventName: 'FUNDS_HELD' }),
    envelope(ids.unconfirmed, `AST_UNCONF_${run}`),
    envelope(ids.again, keys.again),
  ]) {
    await publish(original);
  }
  // A newer event on the stale one's stream, after it.
  await publish(envelope(ids.newer, keys.stale));
  // And one whose newer event retention will take (the last test).
  await publish(envelope(ids.expired, keys.expired));
  await publish(envelope(ids.expiredNewer, keys.expired));
  originalEnds = await endOffsets(ORIGINAL);

  let seen = [];
  await eventually('the real dead letters', async () => {
    seen = await deadLetters(dlqStart);
    return REJECT_ON_ORIGINAL.size === seen.length;
  }).catch((error) => {
    throw new Error(
      `${error.message}; dead letters seen: ${JSON.stringify(seen.map((d) => d.eventId))}; ` +
        `deliveries: ${JSON.stringify(deliveries)}`,
    );
  });

  // Two dead letters from before #145 kept keys: written by hand, keyless,
  // as maintenance-service's consumer wrote them then — one unsequenced, one
  // sequenced (whose stream key proves nothing about the original's key).
  const maintenance = await connected(
    kafka('maintenance-service').producer({ idempotent: true, maxInFlightRequests: 1 }),
  );
  const old = [envelope(ids.keyless, null), envelope(ids.keylessSequenced, `AST_OLD_${run}`)];
  await maintenance.send({
    topic: DLQ,
    acks: -1,
    messages: old.map((body) => ({
      value: JSON.stringify(body),
      headers: {
        [EVENT_HEADERS.eventId]: body.eventId,
        [EVENT_HEADERS.eventName]: body.eventName,
        [EVENT_HEADERS.eventVersion]: '1',
        [EVENT_HEADERS.correlationId]: body.correlationId,
        [EVENT_HEADERS.tenantId]: body.tenantId,
        ...(body.streamSeq === undefined
          ? {}
          : { [EVENT_HEADERS.streamSeq]: String(body.streamSeq) }),
        [EVENT_HEADERS.producer]: 'maintenance-service',
        [DLQ_HEADERS.reason]: DLQ_REASONS.BUSINESS_RULE_VIOLATION,
        [DLQ_HEADERS.originalTopic]: ORIGINAL,
        [DLQ_HEADERS.originalPartition]: '0',
        [DLQ_HEADERS.originalOffset]: '0',
      },
    })),
  });
}, 240_000);

after(async () => {
  await consumer?.stop();
  await Promise.allSettled(clients.map((entity) => entity.disconnect()));
});

describe('the dead letters are the real ones (#145)', () => {
  test('the consumer kept the key and overwrote x-producer with its own name', async () => {
    const dead = await deadLetters(dlqStart);
    const replayable = dead.find((d) => d.eventId === ids.replayable);
    assert.equal(replayable.key, keys.replayable);
    assert.equal(replayable.originalTopic, ORIGINAL);
    assert.notEqual(replayable.producer, 'fleet-service');
    assert.equal(dead.find((d) => d.eventId === ids.keyless).key, null);
    assert.equal(dead.find((d) => d.eventId === ids.keylessSequenced).key, null);
  });
});

describe('a dry-run decides every record and writes nothing', () => {
  test('each verdict, with its reason', async () => {
    const retryBefore = await endOffsets(RETRY);
    const result = replay(
      [
        ids.replayable,
        ids.stale,
        ids.unsequenced,
        ids.financial,
        ids.unconfirmed,
        ids.keyless,
        ids.keylessSequenced,
      ].flatMap((id) => ['--event-id', id]),
    );
    assert.equal(result.status, 0, result.stderr);
    const verdict = Object.fromEntries(
      result.records.map((r) => [r.eventId, [r.verdict, r.refusal, r.stale]]),
    );
    assert.deepEqual(verdict[ids.replayable], ['REPLAYABLE', null, false]);
    assert.deepEqual(verdict[ids.stale], ['REFUSED', 'STALE', true]);
    // Unsequenced, but the dead letter kept the publisher's key.
    assert.deepEqual(verdict[ids.unsequenced], ['REPLAYABLE', null, false]);
    assert.deepEqual(verdict[ids.financial], ['REFUSED', 'NEVER_AUTO_REPLAY', null]);
    assert.deepEqual(verdict[ids.unconfirmed], ['REFUSED', 'REASON_NOT_REPLAYABLE', null]);
    assert.deepEqual(verdict[ids.keyless], ['REFUSED', 'UNSEQUENCED_NO_KEY', null]);
    assert.deepEqual(verdict[ids.keylessSequenced], ['REFUSED', 'KEY_UNVERIFIABLE', null]);
    assert.deepEqual([result.summary.selected, result.summary.replayable], [7, 2]);
    assert.ok(!JSON.stringify(result.records).includes(`replay-itest-${run}`), 'no payload');
    assert.deepEqual(await endOffsets(RETRY), retryBefore);
  });
});

describe('--execute writes only what a dry-run approved, exactly as many as expected', () => {
  test('a selection with a refusal in it writes nothing', async () => {
    const retryBefore = await endOffsets(RETRY);
    const result = replay([
      '--event-id',
      ids.replayable,
      '--event-id',
      ids.financial,
      '--execute',
      '--expect-count',
      '2',
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.summary.written, 0);
    assert.deepEqual(await endOffsets(RETRY), retryBefore);
  });

  test('a count other than the selection’s writes nothing', async () => {
    const retryBefore = await endOffsets(RETRY);
    const result = replay(['--event-id', ids.replayable, '--execute', '--expect-count', '2']);
    assert.equal(result.status, 1);
    assert.deepEqual(await endOffsets(RETRY), retryBefore);
  });

  test('no operator in the environment, no execution', () => {
    const result = replay(['--event-id', ids.replayable, '--execute', '--expect-count', '1'], {
      operator: null,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /REPLAY_OPERATOR/);
  });

  test('no ops-replay credential, no tool', () => {
    const result = replay(['--event-id', ids.replayable], { password: null });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /as ops-replay/);
  });

  test('a replay is consumed from .retry by the real consumer, and is on the wire as the publisher sent it', async () => {
    const retryBefore = await endOffsets(RETRY);
    const result = replay(['--event-id', ids.replayable, '--execute', '--expect-count', '1']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.summary.written, 1);

    await eventually('the consumer to take the replay from .retry', async () =>
      deliveredFrom(ids.replayable, RETRY),
    );

    const replayId = `${result.summary.reportId}/${OPERATOR}`;
    const landed = (await readSince('itest-observer', RETRY, retryBefore)).filter(
      (m) => m.headers?.[REPLAY_HEADERS.replayId]?.toString() === replayId,
    );
    assert.equal(landed.length, 1);
    const [message] = landed;
    assert.equal(message.key.toString(), keys.replayable);
    assert.equal(message.value.toString(), bodies.get(ids.replayable));
    for (const name of Object.keys(message.headers)) {
      assert.ok(
        name === REPLAY_HEADERS.replayId || Object.values(EVENT_HEADERS).includes(name),
        `unexpected header ${name}`,
      );
    }
    // The publisher, as the relay set it — not the consumer that dead-lettered it.
    assert.equal(message.headers[EVENT_HEADERS.producer].toString(), 'fleet-service');

    // And, after it landed, its one record on rasta.ops.replay.v1 — keyed by
    // the run, stating where it moved and under what verdict, no payload.
    assert.equal(result.summary.recorded, 1);
    const [line] = result.records;
    const records = await replayRecords(result.summary.reportId);
    assert.equal(records.length, 1);
    const [{ body, headers }] = records;
    assert.equal(body.eventName, 'REPLAY_EXECUTED');
    assert.equal(body.producer, 'ops-replay');
    assert.equal(body.eventId, line.auditEventId);
    assert.equal(body.tenantId, TENANT);
    assert.equal(body.correlationId, result.summary.reportId);
    assert.deepEqual(body.actor, { type: 'USER', id: OPERATOR });
    assert.deepEqual(body.payload, {
      reportId: result.summary.reportId,
      operator: OPERATOR,
      replayedEvent: { eventId: ids.replayable, eventName: 'USAGE_RECORDED', tenantId: TENANT },
      dlq: { topic: DLQ, partition: line.dlqPartition, offset: line.dlqOffset },
      target: { topic: RETRY, partition: line.replayPartition, offset: line.replayOffset },
      stale: false,
    });
    assert.ok(!JSON.stringify(body).includes(`replay-itest-${run}`), 'no replayed payload');
    assert.equal(headers[EVENT_HEADERS.producer].toString(), 'ops-replay');
  });

  test('an unsequenced event replays under the key its dead letter kept', async () => {
    const retryBefore = await endOffsets(RETRY);
    const result = replay(['--event-id', ids.unsequenced, '--execute', '--expect-count', '1']);
    assert.equal(result.status, 0, result.stderr);
    await eventually('the consumer to take it from .retry', async () =>
      deliveredFrom(ids.unsequenced, RETRY),
    );
    const replayId = `${result.summary.reportId}/${OPERATOR}`;
    const [message] = (await readSince('itest-observer', RETRY, retryBefore)).filter(
      (m) => m.headers?.[REPLAY_HEADERS.replayId]?.toString() === replayId,
    );
    assert.equal(message.key.toString(), `USG_${ids.unsequenced}`);
  });

  test('a stale record is refused, and replayed only when --allow-stale names it', async () => {
    const refused = replay(['--event-id', ids.stale, '--execute', '--expect-count', '1']);
    assert.equal(refused.status, 1);
    assert.equal(refused.records[0].refusal, 'STALE');
    assert.ok(!deliveredFrom(ids.stale, RETRY));

    const allowed = replay([
      '--event-id',
      ids.stale,
      '--allow-stale',
      ids.stale,
      '--execute',
      '--expect-count',
      '1',
    ]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.records[0].stale, true, 'the report still says it was stale');
    await eventually('the consumer to take it from .retry', async () =>
      deliveredFrom(ids.stale, RETRY),
    );
  });

  test('a replay dead-lettered again from .retry goes back to that same .retry, once allowed', async () => {
    // First replay: the harness rejects it once more on .retry, so the
    // consumer dead-letters it with x-dlq-original-topic = rasta.fleet.v1.retry.
    const first = replay(['--event-id', ids.again, '--execute', '--expect-count', '1']);
    assert.equal(first.status, 0, first.stderr);
    const second = await eventually('the dead letter from .retry', async () =>
      (await deadLetters(dlqStart)).find(
        (d) => d.eventId === ids.again && d.originalTopic === RETRY,
      ),
    );
    const byOffset = [
      '--partition',
      String(second.partition),
      '--from-offset',
      second.offset,
      '--to-offset',
      second.offset,
    ];

    // Exactly one `.retry` is stripped: the target is the same twin, and the
    // tool cannot see the stream from there, so staleness is unknown.
    const dry = replay(byOffset);
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(
      [dry.records[0].target, dry.records[0].stale, dry.records[0].refusal],
      [RETRY, 'UNKNOWN', 'STALENESS_UNKNOWN'],
    );

    const deliveredBefore = deliveries.filter(
      (d) => d.eventId === ids.again && d.topic === RETRY,
    ).length;
    const allowed = replay([
      ...byOffset,
      '--allow-stale',
      ids.again,
      '--execute',
      '--expect-count',
      '1',
    ]);
    assert.equal(allowed.status, 0, allowed.stderr);
    await eventually(
      'the consumer to take it from .retry again',
      async () =>
        deliveries.filter((d) => d.eventId === ids.again && d.topic === RETRY).length >
        deliveredBefore,
    );
  });

  test('a refused or dry-run selection records nothing on rasta.ops.replay.v1', async () => {
    const dry = replay(['--event-id', ids.replayable]);
    const refused = replay(['--event-id', ids.financial, '--execute', '--expect-count', '1']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(refused.status, 1);
    for (const result of [dry, refused]) {
      assert.deepEqual(await replayRecords(result.summary.reportId), []);
    }
  });

  test('nothing the tool wrote reached the original topic', async () => {
    const since = await readSince('itest-observer', ORIGINAL, originalEnds);
    assert.deepEqual(
      since.filter((m) => m.headers?.[REPLAY_HEADERS.replayId] !== undefined),
      [],
    );
  });
});

describe('retention past the original offset (Codex round 1 on #144, H1)', () => {
  test('a newer record for the key that retention took leaves staleness unknown, never "not stale"', async (t) => {
    if (!DISPOSABLE_BROKER) {
      t.skip(
        'deletes rasta.fleet.v1 records, as retention would: runs only with ' +
          'REPLAY_TEST_DISPOSABLE_BROKER=1 on a throwaway broker (CI sets it)',
      );
      return;
    }
    const before = replay(['--event-id', ids.expired]);
    assert.equal(before.status, 0, before.stderr);
    const [line] = before.records;
    assert.deepEqual([line.stale, line.refusal], [true, 'STALE']);

    // Retention, as the broker applies it: the partition's start moves past
    // the original, and the newer record for the key goes with it. Deleted:
    // [low, the newer record] and nothing after it — and only once every
    // record in that range is shown to be this run's own.
    const partition = Number(line.originalPartition);
    const admin = await connected(kafka(BROKER_ADMIN_PRINCIPAL).admin());
    const { low } = (await admin.fetchTopicOffsets(ORIGINAL)).find(
      (o) => o.partition === partition,
    );
    const records = await readSince(
      'itest-observer',
      ORIGINAL,
      new Map([[partition, BigInt(low)]]),
    );
    const newer = records.find(
      (r) => r.headers?.[EVENT_HEADERS.eventId]?.toString() === ids.expiredNewer,
    );
    assert.ok(newer, 'the newer record for the key is on the original partition');
    const range = records.filter((r) => BigInt(r.offset) <= BigInt(newer.offset));
    const foreign = range.filter((r) => {
      try {
        return JSON.parse(r.value?.toString() ?? '').payload?.marker !== `replay-itest-${run}`;
      } catch {
        return true;
      }
    });
    assert.deepEqual(
      foreign.map((r) => r.offset),
      [],
      `${ORIGINAL}/${partition} holds records this run did not write before offset ` +
        `${newer.offset}: refusing to delete them — the broker is not a throwaway one`,
    );
    assert.equal(
      BigInt(range.length),
      BigInt(newer.offset) + 1n - BigInt(low),
      'every offset in the range was read and checked',
    );
    const deleteTo = String(BigInt(newer.offset) + 1n);
    assert.ok(BigInt(deleteTo) > BigInt(line.originalOffset) + 1n, 'the newer record follows it');
    await admin.deleteTopicRecords({
      topic: ORIGINAL,
      partitions: [{ partition, offset: deleteTo }],
    });

    const after = replay(['--event-id', ids.expired]);
    assert.equal(after.status, 0, after.stderr);
    assert.deepEqual(
      [after.records[0].verdict, after.records[0].stale, after.records[0].refusal],
      ['REFUSED', 'UNKNOWN', 'STALENESS_UNKNOWN'],
    );
    const refused = replay(['--event-id', ids.expired, '--execute', '--expect-count', '1']);
    assert.equal(refused.status, 1);
    assert.ok(!deliveredFrom(ids.expired, RETRY));
  });
});
