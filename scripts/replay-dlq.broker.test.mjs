/**
 * The DLQ replay tool against the live, authenticated broker (RUN-006;
 * docs/runbooks/replay-dlq.md). It needs the broker the bootstrap started
 * and these principals' passwords — fleet-service (publishes originals),
 * maintenance-service (dead-letters them, as its EventConsumer would),
 * itest-observer (reads what lands) and ops-replay (the tool) — and refuses to
 * run rather than skip without them.
 *
 * The tool runs as a child process whose environment holds **only**
 * ops-replay's credential: whatever it manages, it manages as ops-replay.
 *
 * Until D-039 lands no service consumes `.retry`, so the harness reads it as
 * the development observer. Like the ACL test, it writes marker records on real
 * topics (the original, the dead letter, `.retry`): run it where nothing else
 * consumes them — CI runs it last.
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
const contracts = createRequire(import.meta.url)(resolve(ROOT, 'packages/contracts/dist/index.js'));
const { EVENT_HEADERS, DLQ_HEADERS, DLQ_REASONS, REPLAY_HEADERS } = contracts;

const ORIGINAL = 'rasta.fleet.v1';
const RETRY = 'rasta.fleet.v1.retry';
const DLQ = 'rasta.maintenance.v1.dlq';
const OPERATOR = 'replay-itest';

const configuredCa = process.env.KAFKA_SSL_CA_FILE?.trim();
const CA =
  configuredCa && isAbsolute(configuredCa)
    ? configuredCa
    : resolve(ROOT, 'infrastructure/docker/kafka/.tls/ca.pem');
const env = { ...process.env, KAFKA_SSL_CA_FILE: CA };
const PRINCIPALS = ['fleet-service', 'maintenance-service', 'itest-observer', 'ops-replay'];
const missing = PRINCIPALS.map(passwordVariable).filter((variable) => !process.env[variable]);
if (missing.length > 0) {
  throw new Error(
    `the replay broker test needs ${missing.join(', ')} (in CI, the admin scope of kafka-credentials.sh; ` +
      'locally, `pnpm test:replay-dlq-broker`, which loads .env and the bootstrap env file)',
  );
}

const run = randomUUID().slice(0, 8);
const clients = [];
const kafka = (principal) =>
  new Kafka({
    ...connectionFor(principal, env, (path) => readFileSync(path, 'utf8')),
    clientId: `replay-itest-${principal}-${run}`,
    logLevel: logLevel.NOTHING,
    retry: { retries: 3 },
  });

async function connected(entity) {
  clients.push(entity);
  await entity.connect();
  return entity;
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
            if (offset >= range.from && offset < range.to)
              records.push({ partition: batch.partition, ...message });
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

async function endOffsets(principal, topic) {
  const admin = await connected(kafka(principal).admin());
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
    {
      env: childEnv,
      encoding: 'utf8',
      timeout: 180_000,
    },
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
    aggregateId: `USG_${run}`,
    tenantId: `ORG_REPLAY_${run}`,
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
  forged: `EVT_RPL_FORGED_${run}`,
};
const keys = { replayable: `AST_OK_${run}`, stale: `AST_STALE_${run}` };
/** eventId → the original bytes, for the byte-for-byte check. */
const bodies = new Map();
let dlqRange;
let originalEnds;

before(async () => {
  const fleet = await connected(
    kafka('fleet-service').producer({ idempotent: true, maxInFlightRequests: 1 }),
  );
  const maintenance = await connected(
    kafka('maintenance-service').producer({ idempotent: true, maxInFlightRequests: 1 }),
  );

  // The originals, as fleet-service publishes them: keyed by the stream key.
  const originals = [
    envelope(ids.replayable, keys.replayable),
    envelope(ids.stale, keys.stale),
    envelope(ids.unsequenced, null),
    envelope(ids.financial, `AST_MONEY_${run}`, { eventName: 'FUNDS_HELD' }),
    envelope(ids.forged, `AST_FORGED_${run}`),
  ];
  const positions = new Map();
  for (const original of originals) {
    const value = JSON.stringify(original);
    bodies.set(original.eventId, value);
    const [meta] = await fleet.send({
      topic: ORIGINAL,
      acks: -1,
      messages: [{ key: original.streamKey ?? original.aggregateId, value }],
    });
    positions.set(original.eventId, { partition: meta.partition, offset: meta.baseOffset });
  }
  // A newer event on the stale one's stream, after it.
  await fleet.send({
    topic: ORIGINAL,
    acks: -1,
    messages: [{ key: keys.stale, value: JSON.stringify(envelope(ids.newer, keys.stale)) }],
  });
  originalEnds = await endOffsets('itest-observer', ORIGINAL);

  // The dead letters, as maintenance-service's EventConsumer writes them: the
  // original body, its platform headers and x-dlq-*, and no key (D-040). One
  // send, so they sit on consecutive offsets.
  const reasonOf = (eventId) =>
    eventId === ids.forged ? DLQ_REASONS.PRODUCER_NOT_ALLOWED : DLQ_REASONS.MAX_RETRIES_EXCEEDED;
  const [dead] = await maintenance.send({
    topic: DLQ,
    acks: -1,
    messages: originals.map((original) => ({
      value: bodies.get(original.eventId),
      headers: {
        [EVENT_HEADERS.eventId]: original.eventId,
        [EVENT_HEADERS.eventName]: original.eventName,
        [EVENT_HEADERS.eventVersion]: String(original.eventVersion),
        [EVENT_HEADERS.correlationId]: original.correlationId,
        [EVENT_HEADERS.tenantId]: original.tenantId,
        [EVENT_HEADERS.producer]: original.producer,
        [DLQ_HEADERS.reason]: reasonOf(original.eventId),
        [DLQ_HEADERS.originalTopic]: ORIGINAL,
        [DLQ_HEADERS.originalPartition]: String(positions.get(original.eventId).partition),
        [DLQ_HEADERS.originalOffset]: String(positions.get(original.eventId).offset),
        [DLQ_HEADERS.attempts]: '4',
        [DLQ_HEADERS.error]: 'replay-itest',
      },
    })),
  });
  const first = BigInt(dead.baseOffset);
  dlqRange = {
    partition: dead.partition,
    from: String(first),
    to: String(first + BigInt(originals.length) - 1n),
  };
}, 120_000);

after(async () => {
  await Promise.allSettled(clients.map((entity) => entity.disconnect()));
});

const byRange = () => [
  '--partition',
  String(dlqRange.partition),
  '--from-offset',
  dlqRange.from,
  '--to-offset',
  dlqRange.to,
];

describe('a dry-run decides every record and writes nothing', () => {
  test('each verdict, with its reason', async () => {
    const retryBefore = await endOffsets('itest-observer', RETRY);
    const result = replay(byRange());
    assert.equal(result.status, 0, result.stderr);
    const verdict = Object.fromEntries(
      result.records.map((r) => [r.eventId, [r.verdict, r.refusal, r.stale]]),
    );
    assert.deepEqual(verdict[ids.replayable], ['REPLAYABLE', null, false]);
    assert.deepEqual(verdict[ids.stale], ['REFUSED', 'STALE', true]);
    assert.deepEqual(verdict[ids.unsequenced], ['REFUSED', 'UNSEQUENCED', null]);
    assert.deepEqual(verdict[ids.financial], ['REFUSED', 'NEVER_AUTO_REPLAY', null]);
    assert.deepEqual(verdict[ids.forged], ['REFUSED', 'REASON_NOT_REPLAYABLE', null]);
    assert.deepEqual([result.summary.selected, result.summary.replayable], [5, 1]);
    // No payload in the report.
    assert.ok(!JSON.stringify(result.records).includes(`replay-itest-${run}`));
    assert.deepEqual(await endOffsets('itest-observer', RETRY), retryBefore);
  });
});

describe('--execute writes only what a dry-run approved, exactly as many as expected', () => {
  test('a selection with a refusal in it writes nothing', async () => {
    const retryBefore = await endOffsets('itest-observer', RETRY);
    const result = replay([...byRange(), '--execute', '--expect-count', '5']);
    assert.equal(result.status, 1);
    assert.equal(result.summary.written, 0);
    assert.deepEqual(await endOffsets('itest-observer', RETRY), retryBefore);
  });

  test('a count other than the selection’s writes nothing', async () => {
    const retryBefore = await endOffsets('itest-observer', RETRY);
    const result = replay(['--event-id', ids.replayable, '--execute', '--expect-count', '2']);
    assert.equal(result.status, 1);
    assert.deepEqual(await endOffsets('itest-observer', RETRY), retryBefore);
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

  test('replays one record to .retry: its body, its stream key, its platform headers and the replay stamp', async () => {
    const retryBefore = await endOffsets('itest-observer', RETRY);
    const result = replay(['--event-id', ids.replayable, '--execute', '--expect-count', '1']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.summary.written, 1);
    const replayId = `${result.summary.reportId}/${OPERATOR}`;

    const landed = (await readSince('itest-observer', RETRY, retryBefore)).filter(
      (m) => m.headers?.[REPLAY_HEADERS.replayId]?.toString() === replayId,
    );
    assert.equal(landed.length, 1);
    const [message] = landed;
    assert.equal(message.key.toString(), keys.replayable);
    assert.equal(message.value.toString(), bodies.get(ids.replayable));
    const names = Object.keys(message.headers).sort();
    for (const name of names) {
      assert.ok(
        name === REPLAY_HEADERS.replayId || Object.values(EVENT_HEADERS).includes(name),
        `unexpected header ${name}`,
      );
    }
    assert.ok(!names.some((name) => name.startsWith('x-dlq-')));
    assert.equal(message.headers[EVENT_HEADERS.eventId].toString(), ids.replayable);
  });

  test('a stale record is refused, and replayed only when --allow-stale names it', async () => {
    const refused = replay(['--event-id', ids.stale, '--execute', '--expect-count', '1']);
    assert.equal(refused.status, 1);
    assert.equal(refused.records[0].refusal, 'STALE');

    const retryBefore = await endOffsets('itest-observer', RETRY);
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
    const replayId = `${allowed.summary.reportId}/${OPERATOR}`;
    const landed = (await readSince('itest-observer', RETRY, retryBefore)).filter(
      (m) => m.headers?.[REPLAY_HEADERS.replayId]?.toString() === replayId,
    );
    assert.equal(landed.length, 1);
    assert.equal(landed[0].key.toString(), keys.stale);
  });

  test('nothing the tool wrote reached the original topic', async () => {
    const since = await readSince('itest-observer', ORIGINAL, originalEnds);
    assert.deepEqual(
      since.filter((m) => m.headers?.[REPLAY_HEADERS.replayId] !== undefined),
      [],
    );
  });
});
