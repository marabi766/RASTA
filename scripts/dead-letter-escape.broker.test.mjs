/**
 * A KNOWN escape from the dead-letter headroom, pinned as it behaves today
 * (PR #378 r4, escape (i) of the r3 review; PM decision D-063 moves the class
 * to its own design task). The follow-up that closes it flips this test.
 *
 *   RASTA_DISPOSABLE_BROKER=1 node --test scripts/dead-letter-escape.broker.test.mjs
 *
 * The headroom a dead-letter topic has over its sources (`@rasta/contracts`
 * dead-letter-size.ts) holds for a source batch sent uncompressed, or GZIP
 * that did not shrink. A source batch GZIP-compressed at a HIGHER level than
 * the dead letter's — KafkaJS's default, level 6 — can be admitted at the
 * source and still not fit: recompressed, the same bytes are larger. No broker
 * setting or ACL fixes the producer's compression level.
 *
 * What this observes, on the broker:
 *   - the record, GZIP level 9, is admitted by its source topic as its
 *     declared producer (organization-service);
 *   - audit-service's shared `EventConsumer` refuses it, and its dead-letter
 *     send to `rasta.audit.v1.dlq` is rejected MESSAGE_TOO_LARGE; nothing
 *     reaches the dead-letter topic;
 *   - kafkajs treats MESSAGE_TOO_LARGE as non-retriable: the consumer crashes
 *     and does NOT restart itself (`restart: false`), so it stops on every
 *     partition it reads, not only the poison record's — while
 *     `EventConsumer.isRunning()`, which health checks read, still says true;
 *   - the group's committed offset stays on the poison record and the record
 *     behind it is never consumed: no silent loss, for as long as the source
 *     topic retains the record;
 *   - a consumer started again (a restarted service) is delivered the same
 *     record — its handler runs a second time — and crashes the same way.
 *
 * Needs the broker `infrastructure/docker/kafka/ci-up.sh` starts and the
 * `admin` scope of `kafka-credentials.sh` (the admin pre-commits the test's
 * group). It leaves the poison record on `rasta.organization.v1`, so it
 * refuses to start without the disposable-broker declaration
 * (disposable-broker.mjs) — CI declares it in the broker-authorisation job
 * alone and runs this after every test that consumes.
 */
import './disposable-broker.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { gzip, unzip } from 'node:zlib';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import kafkajs from 'kafkajs';
import { connectionFor, passwordVariable } from './kafka-acl-lib.mjs';

const { Kafka, logLevel, CompressionTypes, CompressionCodecs } = kafkajs;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const contracts = require(resolve(ROOT, 'packages/contracts/dist/index.js'));
const { EventConsumer, UnprocessableEventError, kafkaConnectionFor } = require(
  resolve(ROOT, 'packages/nest-common/dist/index.js'),
);
const encodeRecord = require('kafkajs/src/protocol/recordBatch/record/v0');
const { RecordBatch } = require('kafkajs/src/protocol/recordBatch/v0');

const SOURCE = 'rasta.organization.v1';
const DLQ = 'rasta.audit.v1.dlq';
const PARTITION = 0;
const limitOf = (name) =>
  contracts.brokerTopics().find((topic) => topic.name === name).maxMessageBytes;
const SOURCE_LIMIT = limitOf(SOURCE);
const DLQ_LIMIT = limitOf(DLQ);

const configuredCa = process.env.KAFKA_SSL_CA_FILE?.trim();
const env = {
  ...process.env,
  KAFKA_SSL: 'true',
  KAFKA_SSL_CA_FILE:
    configuredCa && isAbsolute(configuredCa)
      ? configuredCa
      : resolve(ROOT, 'infrastructure/docker/kafka/.tls/ca.pem'),
};
const missing = ['organization-service', 'audit-service', 'admin']
  .map(passwordVariable)
  .filter((variable) => !process.env[variable]);
if (missing.length > 0 || !process.env.KAFKA_BROKERS) {
  throw new Error(
    `the dead-letter escape test needs KAFKA_BROKERS and ${missing.join(', ') || 'the passwords'} ` +
      '(the admin scope of kafka-credentials.sh); refusing to run rather than skip',
  );
}

const RUN = randomUUID().slice(0, 8);
const kafka = (principal) =>
  new Kafka({
    ...connectionFor(principal, env, (path) => readFileSync(path, 'utf8')),
    clientId: `escape-itest-${principal}-${RUN}`,
    logLevel: logLevel.NOTHING,
    retry: { retries: 3 },
  });

const GZIP_LEVEL_9 = {
  compress: async (encoder) => promisify(gzip)(encoder.buffer, { level: 9 }),
  decompress: async (buffer) => promisify(unzip)(buffer),
};
/** Runs `work` with kafkajs's GZIP codec compressing at level 9, then puts the default back. */
async function atLevel9(work) {
  const original = CompressionCodecs[CompressionTypes.GZIP];
  CompressionCodecs[CompressionTypes.GZIP] = () => GZIP_LEVEL_9;
  try {
    return await work();
  } finally {
    CompressionCodecs[CompressionTypes.GZIP] = original;
  }
}
/** The stored size of a one-record batch, as kafkajs writes it. */
const batchSize = async (message, compression = CompressionTypes.GZIP) =>
  (await RecordBatch({ compression, records: [encodeRecord(message)] })).size();

const isTooLarge = (error) =>
  error?.type === 'MESSAGE_TOO_LARGE' || error?.cause?.type === 'MESSAGE_TOO_LARGE';

function envelope(eventId, aggregateId) {
  return {
    eventId,
    eventName: 'ORGANIZATION_PROBE',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'organization-service',
    producerVersion: '0.0.0',
    aggregateType: 'Organization',
    aggregateId,
    correlationId: `escape-${RUN}`,
    payload: {},
  };
}

/**
 * Random text over two characters: every 3-byte prefix recurs constantly, so
 * level 6's 128-deep match search finds shorter matches than level 9's
 * 4,096-deep one — about 5% larger output. Random bytes after it fill the
 * batch to just under the source limit at level 9.
 */
function bulkOf(binaryLength, fillerLength) {
  const bits = randomBytes(Math.ceil(binaryLength / 8));
  const text = Buffer.alloc(binaryLength);
  for (let i = 0; i < binaryLength; i += 1) text[i] = (bits[i >> 3] >> (i & 7)) & 1 ? 0x31 : 0x30;
  return Buffer.concat([text, randomBytes(fillerLength)]);
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

test('KNOWN ESCAPE (i): a source record GZIP level 9 whose dead letter does not fit is refused MESSAGE_TOO_LARGE; the consumer crashes without restarting, its offset stays uncommitted and nothing behind it is consumed', async (t) => {
  const poison = envelope(`escape-${RUN}-poison`, `ORG-ESCAPE-${RUN}`);
  const next = envelope(`escape-${RUN}-next`, `ORG-ESCAPE-${RUN}-NEXT`);
  const key = Buffer.from(poison.aggregateId);
  const value = Buffer.from(JSON.stringify(poison));
  const bulkHeader = contracts.EVENT_HEADERS.causationId;

  // A record whose level-9 batch is ~2 KB under the source limit.
  const binary = 1_500_000;
  let filler = SOURCE_LIMIT - 300_000;
  let record;
  for (let tries = 0; ; tries += 1) {
    record = { key, value, headers: { [bulkHeader]: bulkOf(binary, filler) } };
    const size = await atLevel9(() => batchSize(record));
    if (size <= SOURCE_LIMIT - 1_024 && size > SOURCE_LIMIT - 4_096) break;
    assert.ok(tries < 10, `no filler puts the level-9 batch just under ${SOURCE_LIMIT}`);
    filler += SOURCE_LIMIT - 2_048 - size;
  }
  const level9 = await atLevel9(() => batchSize(record));
  const level6 = await batchSize(record);
  // The setup itself: admitted at level 9, and over the dead-letter limit once
  // KafkaJS recompresses the same record at its default level, before any
  // header is added.
  assert.ok(level9 <= SOURCE_LIMIT, `level 9: ${level9}`);
  assert.ok(level6 > DLQ_LIMIT, `level 6: ${level6}, dead-letter limit ${DLQ_LIMIT}`);
  t.diagnostic(
    `source batch at GZIP level 9: ${level9} (limit ${SOURCE_LIMIT}); the same record at level 6: ${level6} (dead-letter limit ${DLQ_LIMIT})`,
  );

  const organization = kafka('organization-service');
  const producer = organization.producer({ retry: { retries: 0 } });
  const adminClient = kafka('admin').admin();
  await Promise.all([producer.connect(), adminClient.connect()]);
  const groupId = `audit-service.itest-escape-${RUN}`;
  let consumer;
  const handled = [];
  const rejected = [];
  const sent = [];
  try {
    // 1. Admitted by the source topic, GZIP level 9, as its declared producer.
    const [admitted] = await atLevel9(() =>
      producer.send({
        topic: SOURCE,
        acks: -1,
        compression: CompressionTypes.GZIP,
        messages: [{ ...record, partition: PARTITION }],
      }),
    );
    assert.equal(admitted.partition, PARTITION);
    const poisonOffset = admitted.baseOffset;
    const [behind] = await producer.send({
      topic: SOURCE,
      acks: -1,
      messages: [
        {
          key: Buffer.from(next.aggregateId),
          value: Buffer.from(JSON.stringify(next)),
          partition: PARTITION,
        },
      ],
    });
    assert.ok(BigInt(behind.baseOffset) > BigInt(poisonOffset));

    // The group starts exactly at the poison record on its partition, at the
    // end of the others; the dead-letter topic's end is noted.
    const ends = await adminClient.fetchTopicOffsets(SOURCE);
    await adminClient.setOffsets({
      groupId,
      topic: SOURCE,
      partitions: ends.map(({ partition, high }) => ({
        partition,
        offset: partition === PARTITION ? poisonOffset : high,
      })),
    });
    const dlqBefore = await adminClient.fetchTopicOffsets(DLQ);

    // 2. audit-service's shared consumer refuses the poison record. Every
    //    dead-letter send, the broker's answer, and each kafkajs crash are
    //    recorded.
    const crashes = [];
    const consumerFor = (clientId) => {
      const shared = new EventConsumer(
        {
          ...kafkaConnectionFor('audit-service', clientId),
          groupId,
          topics: [SOURCE],
          deadLetterTopic: DLQ,
        },
        async (event) => {
          handled.push(event.eventId);
          if (event.eventId === poison.eventId) {
            throw new UnprocessableEventError(
              contracts.DLQ_REASONS.VALIDATION_FAILED,
              'refused by the known-escape test',
            );
          }
        },
        { log: () => undefined, warn: () => undefined, error: () => undefined },
      );
      const client = shared.kafka;
      const makeProducer = client.producer.bind(client);
      client.producer = (...args) => {
        const dlqProducer = makeProducer(...args);
        const send = dlqProducer.send.bind(dlqProducer);
        dlqProducer.send = async (request) => {
          try {
            const result = await send(request);
            sent.push(request.topic);
            return result;
          } catch (error) {
            rejected.push(error);
            throw error;
          }
        };
        return dlqProducer;
      };
      const makeConsumer = client.consumer.bind(client);
      client.consumer = (...args) => {
        const inner = makeConsumer(...args);
        inner.on(inner.events.CRASH, ({ payload }) => crashes.push(payload));
        return inner;
      };
      return shared;
    };
    const rootCause = (error) => (error?.cause ? rootCause(error.cause) : error);

    consumer = consumerFor(`escape-itest-${RUN}-1`);
    await consumer.start();

    // 3. Rejected by the broker; the consumer crashes and stays down.
    await eventually(
      'the consumer to crash on the rejected dead letter',
      async () => crashes.length >= 1,
    );
    assert.equal(rejected.length, 1);
    assert.ok(isTooLarge(rejected[0]), String(rejected[0]?.type));
    assert.equal(rootCause(crashes[0].error).type, 'MESSAGE_TOO_LARGE');
    assert.equal(crashes[0].restart, false);
    assert.equal(consumer.isRunning(), true, 'EventConsumer noticed the crash');
    assert.deepEqual(sent, []);
    assert.deepEqual(await adminClient.fetchTopicOffsets(DLQ), dlqBefore);

    // Not only that partition: a record on another one is not consumed either.
    const elsewhere = envelope(`escape-${RUN}-elsewhere`, `ORG-ESCAPE-${RUN}-ELSEWHERE`);
    await producer.send({
      topic: SOURCE,
      acks: -1,
      messages: [
        {
          key: Buffer.from(elsewhere.aggregateId),
          value: Buffer.from(JSON.stringify(elsewhere)),
          partition: PARTITION + 1,
        },
      ],
    });
    await new Promise((settle) => setTimeout(settle, 10_000));
    assert.ok(!handled.includes(next.eventId), 'consumed past the poison record');
    assert.ok(
      !handled.includes(elsewhere.eventId),
      'a crashed consumer consumed another partition',
    );
    const [stalled] = await adminClient.fetchOffsets({ groupId, topics: [SOURCE] });
    assert.equal(
      stalled.partitions.find(({ partition }) => partition === PARTITION).offset,
      poisonOffset,
    );

    await consumer.stop({ deadlineAt: Date.now() + 20_000 });
    consumer = undefined;

    // 4. Started again, as a restarted service would be: the same record is
    //    delivered again (its handler runs a second time), refused and
    //    rejected again, and the consumer crashes again. Nothing was dropped.
    consumer = consumerFor(`escape-itest-${RUN}-2`);
    await consumer.start();
    await eventually(
      'the second consumer to crash on the same record',
      async () => crashes.length >= 2,
    );
    assert.equal(handled.filter((id) => id === poison.eventId).length, 2);
    assert.equal(rejected.length, 2);
    assert.ok(rejected.every(isTooLarge));
    assert.equal(crashes[1].restart, false);
    await consumer.stop({ deadlineAt: Date.now() + 20_000 });
    consumer = undefined;

    const [committed] = await adminClient.fetchOffsets({ groupId, topics: [SOURCE] });
    assert.equal(
      committed.partitions.find(({ partition }) => partition === PARTITION).offset,
      poisonOffset,
    );
    assert.ok(!handled.includes(next.eventId));
    assert.deepEqual(sent, []);
    assert.deepEqual(await adminClient.fetchTopicOffsets(DLQ), dlqBefore);
  } finally {
    if (consumer) await consumer.stop({ deadlineAt: Date.now() + 20_000 }).catch(() => undefined);
    await Promise.all([producer.disconnect(), adminClient.disconnect()]);
  }
});
