import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_CEILING,
  UsageError,
  OPERATOR_PATTERN,
  assess,
  executeReplays,
  executionProblems,
  operatorFrom,
  parseArgs,
  parseTopics,
  recordProblem,
  replayExecutedRecord,
  replayIdFor,
  replayMessage,
  reportLine,
  staleFrom,
  stalenessProbe,
  topologyOf,
  withStaleness,
} from './replay-dlq-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The real contracts, built: a header renamed there must break here.
const contracts = createRequire(import.meta.url)(resolve(ROOT, 'packages/contracts/dist/index.js'));
const { EVENT_HEADERS, DLQ_HEADERS, DLQ_REASONS, REPLAY_HEADERS } = contracts;
const topics = parseTopics(
  readFileSync(resolve(ROOT, 'infrastructure/docker/kafka/topics.txt'), 'utf8'),
);
const DLQ = 'rasta.maintenance.v1.dlq';
const topology = topologyOf(DLQ, { topics, consumers: contracts.TOPIC_CONSUMERS });
const context = { dlq: DLQ, topology, topics, contracts };

function envelope(overrides = {}) {
  return {
    eventId: 'EVT_1',
    eventName: 'USAGE_RECORDED',
    eventVersion: 1,
    occurredAt: '2026-09-29T08:00:00.000Z',
    producer: 'fleet-service',
    producerVersion: '1.0.0',
    aggregateType: 'UsageRecord',
    aggregateId: 'USG_1',
    tenantId: 'ORG_1',
    correlationId: 'COR_1',
    streamKey: 'AST_1',
    streamSeq: 7,
    payload: { anything: 'the tool never reads' },
    ...overrides,
  };
}

/**
 * A dead letter as EventConsumer writes one (#145): the original body, platform
 * and x-dlq-* headers, and the original key — the stream key, unless `key` says
 * otherwise (`null`: dead-lettered with no key).
 */
function deadLetter(
  body = envelope(),
  headerOverrides = {},
  { key = body.streamKey ?? null } = {},
) {
  const headers = {
    [EVENT_HEADERS.eventId]: Buffer.from(body.eventId),
    [EVENT_HEADERS.eventName]: Buffer.from(body.eventName),
    [EVENT_HEADERS.eventVersion]: Buffer.from(String(body.eventVersion)),
    [EVENT_HEADERS.correlationId]: Buffer.from(body.correlationId),
    [EVENT_HEADERS.tenantId]: body.tenantId === undefined ? undefined : Buffer.from(body.tenantId),
    [EVENT_HEADERS.streamSeq]:
      body.streamSeq === undefined ? undefined : Buffer.from(String(body.streamSeq)),
    // As EventConsumer.deadLetter writes it (#145): the consumer's client id,
    // not the original publisher.
    [EVENT_HEADERS.producer]: Buffer.from('maintenance-service'),
    [DLQ_HEADERS.reason]: Buffer.from(DLQ_REASONS.MAX_RETRIES_EXCEEDED),
    [DLQ_HEADERS.originalTopic]: Buffer.from('rasta.fleet.v1'),
    [DLQ_HEADERS.originalPartition]: Buffer.from('1'),
    [DLQ_HEADERS.originalOffset]: Buffer.from('41'),
    [DLQ_HEADERS.attempts]: Buffer.from('4'),
    [DLQ_HEADERS.error]: Buffer.from('handler failed'),
    ...headerOverrides,
  };
  for (const [name, value] of Object.entries(headers))
    if (value === undefined) delete headers[name];
  return {
    partition: 0,
    offset: '12',
    key: key === null ? null : Buffer.from(key),
    value: Buffer.from(JSON.stringify(body)),
    headers,
  };
}

// ------------------------------------------------------------------ arguments

test('selection is explicit and bounded', () => {
  assert.throws(() => parseArgs([]), /--dlq/);
  assert.throws(() => parseArgs(['--dlq', DLQ]), /select either/);
  assert.throws(
    () => parseArgs(['--dlq', DLQ, '--event-id', 'E', '--partition', '0']),
    /select either/,
  );
  assert.throws(
    () => parseArgs(['--dlq', DLQ, '--partition', '0', '--from-offset', '1']),
    /--to-offset/,
  );
  assert.throws(
    () => parseArgs(['--dlq', DLQ, '--partition', '0', '--from-offset', '5', '--to-offset', '4']),
    /before/,
  );
  // Ten by default, and never more than the ceiling.
  assert.throws(
    () => parseArgs(['--dlq', DLQ, '--partition', '0', '--from-offset', '0', '--to-offset', '10']),
    /more than --max 10/,
  );
  assert.throws(
    () => parseArgs(['--dlq', DLQ, '--event-id', 'E', '--max', String(MAX_CEILING + 1)]),
    /--max/,
  );
  assert.throws(() => parseArgs(['--dlq', DLQ, '--event-id', 'E', '--event-id', 'E']), /repeated/);
  const many = Array.from({ length: 11 }, (_, i) => ['--event-id', `E${i}`]).flat();
  assert.throws(() => parseArgs(['--dlq', DLQ, ...many]), /more than --max/);
  assert.throws(() => parseArgs(['--dlq', DLQ, '--event-id', 'E', '--whatever']), /unknown/);
  const parsed = parseArgs([
    '--dlq',
    DLQ,
    '--partition',
    '0',
    '--from-offset',
    '3',
    '--to-offset',
    '7',
  ]);
  assert.deepEqual(
    [parsed.partition, parsed.fromOffset, parsed.toOffset, parsed.execute],
    [0, '3', '7', false],
  );
});

test('--execute needs --expect-count, and only --execute takes one', () => {
  assert.throws(() => parseArgs(['--dlq', DLQ, '--event-id', 'E', '--execute']), /--expect-count/);
  assert.throws(
    () => parseArgs(['--dlq', DLQ, '--event-id', 'E', '--execute', '--expect-count', '0']),
    /--expect-count/,
  );
  assert.throws(
    () => parseArgs(['--dlq', DLQ, '--event-id', 'E', '--expect-count', '1']),
    /for --execute/,
  );
  const parsed = parseArgs(['--dlq', DLQ, '--event-id', 'E', '--execute', '--expect-count', '1']);
  assert.deepEqual([parsed.execute, parsed.expectCount], [true, 1]);
});

test('the operator is named in the environment, and is never a secret-shaped value', () => {
  assert.throws(() => operatorFrom({}), UsageError);
  assert.throws(() => operatorFrom({ REPLAY_OPERATOR: 'two words' }), UsageError);
  assert.throws(() => operatorFrom({ REPLAY_OPERATOR: 'x'.repeat(65) }), UsageError);
  assert.throws(() => operatorFrom({ REPLAY_OPERATOR: 'a=b;c' }), UsageError);
  assert.equal(operatorFrom({ REPLAY_OPERATOR: ' ops.oncall@rasta ' }), 'ops.oncall@rasta');
});

test('a dead-letter topic implies its one consumer and what it subscribes to', () => {
  assert.equal(topology.consumer, 'maintenance-service');
  assert.ok(topology.subscribes.has('rasta.fleet.v1'));
  assert.throws(
    () => topologyOf('rasta.fleet.v1', { topics, consumers: contracts.TOPIC_CONSUMERS }),
    /not a dead-letter/,
  );
  assert.throws(
    () => topologyOf('rasta.nothing.v1.dlq', { topics, consumers: contracts.TOPIC_CONSUMERS }),
    /not a dead-letter/,
  );
});

// ------------------------------------------------------------------ verdicts

test('a replayable dead letter goes to the original topic’s .retry, keyed by its stream key', () => {
  const decision = assess(deadLetter(), context);
  assert.equal(decision.verdict, 'REPLAYABLE', decision.refusal);
  assert.equal(decision.summary.target, 'rasta.fleet.v1.retry');
  assert.equal(decision.message.key, 'AST_1');
});

test('only the platform headers are restored; x-dlq-* never is', () => {
  const decision = assess(deadLetter(), context);
  const names = Object.keys(decision.message.headers).sort();
  assert.ok(names.length > 0);
  for (const name of names) assert.ok(Object.values(EVENT_HEADERS).includes(name), name);
  assert.ok(!names.some((name) => name.startsWith('x-dlq-')));
  const message = replayMessage(decision, 'rpl-1/ops', REPLAY_HEADERS);
  assert.equal(message.headers[REPLAY_HEADERS.replayId], 'rpl-1/ops');
  assert.equal(message.key, 'AST_1');
  // The body is published byte for byte.
  assert.equal(message.value.toString('utf8'), JSON.stringify(envelope()));
});

const refusals = [
  ['no reason', deadLetter(envelope(), { [DLQ_HEADERS.reason]: undefined }), 'NO_DLQ_REASON'],
  [
    'no original topic',
    deadLetter(envelope(), { [DLQ_HEADERS.originalTopic]: undefined }),
    'NO_ORIGINAL_TOPIC',
  ],
  [
    'an original topic the dead letter’s consumer does not subscribe to',
    deadLetter(envelope(), { [DLQ_HEADERS.originalTopic]: Buffer.from('rasta.marketplace.v1') }),
    'ORIGINAL_TOPIC_NOT_SUBSCRIBED',
  ],
  ['an unparseable body', { ...deadLetter(), value: Buffer.from('{not json') }, 'UNPARSEABLE_BODY'],
  [
    'an invalid envelope',
    { ...deadLetter(), value: Buffer.from(JSON.stringify({ eventId: 'EVT_1' })) },
    'INVALID_ENVELOPE',
  ],
  [
    'a platform header that disagrees with the body',
    deadLetter(envelope(), { [EVENT_HEADERS.tenantId]: Buffer.from('ORG_OTHER') }),
    `HEADER_BODY_MISMATCH:${EVENT_HEADERS.tenantId}`,
  ],
  [
    'a platform header whose body field is absent (x-tenant-id, no tenantId)',
    deadLetter(envelope({ tenantId: undefined }), {
      [EVENT_HEADERS.tenantId]: Buffer.from('ORG_1'),
    }),
    `HEADER_BODY_MISMATCH:${EVENT_HEADERS.tenantId}`,
  ],
  [
    'a header whose body field the schema would default (x-event-version, no eventVersion)',
    (() => {
      const body = envelope();
      delete body.eventVersion;
      return deadLetter(body, { [EVENT_HEADERS.eventVersion]: Buffer.from('1') });
    })(),
    `HEADER_BODY_MISMATCH:${EVENT_HEADERS.eventVersion}`,
  ],
  [
    'a body field whose platform header is absent (causationId, no x-causation-id)',
    deadLetter(envelope({ causationId: 'EVT_0' })),
    `HEADER_BODY_MISMATCH:${EVENT_HEADERS.causationId}`,
  ],
  ...[
    DLQ_REASONS.PRODUCER_NOT_ALLOWED,
    DLQ_REASONS.SOURCE_UNCONFIRMED,
    DLQ_REASONS.BACKFILL_REQUIRED,
  ].map((reason) => [
    `reason ${reason}, which a replay cannot change`,
    deadLetter(envelope(), { [DLQ_HEADERS.reason]: Buffer.from(reason) }),
    'REASON_NOT_REPLAYABLE',
  ]),
  ...['FUNDS_HELD', 'SETTLEMENT_COMPLETED', 'ORDER_RECEIPT_CONFIRMED', 'STATEMENT_APPROVED'].map(
    (eventName) => [
      `${eventName}, a NEVER_AUTO_REPLAY event`,
      deadLetter(envelope({ eventName })),
      'NEVER_AUTO_REPLAY',
    ],
  ),
  [
    'an unsequenced event dead-lettered before the key was kept (#145): no key to replay it with',
    deadLetter(envelope({ streamKey: undefined, streamSeq: undefined })),
    'UNSEQUENCED_NO_KEY',
  ],
  [
    'a sequenced event dead-lettered with no key: its stream key is not proof of the original key',
    deadLetter(envelope(), {}, { key: null }),
    'KEY_UNVERIFIABLE',
  ],
  [
    'a dead letter from `<topic>.retry.retry`: exactly one suffix is stripped',
    deadLetter(envelope(), {
      [DLQ_HEADERS.originalTopic]: Buffer.from('rasta.fleet.v1.retry.retry'),
    }),
    'ORIGINAL_TOPIC_NOT_SUBSCRIBED',
  ],
  [
    'a dead letter whose kept key is not the stream key',
    deadLetter(envelope(), {}, { key: 'OTHER' }),
    'KEY_MISMATCH',
  ],
];
for (const [what, record, refusal] of refusals) {
  test(`refused: ${what}`, () => {
    const decision = assess(record, context);
    assert.equal(decision.verdict, 'REFUSED');
    assert.equal(decision.refusal, refusal);
  });
}

test('x-producer is neither compared nor copied: the replay carries the publisher, as the relay set it', () => {
  const decision = assess(deadLetter(), context);
  assert.equal(decision.verdict, 'REPLAYABLE', decision.refusal);
  assert.equal(decision.message.headers[EVENT_HEADERS.producer], 'fleet-service');
});

test('an unsequenced event is replayed under the key the dead letter kept (#145)', () => {
  const decision = assess(
    deadLetter(envelope({ streamKey: undefined, streamSeq: undefined }), {}, { key: 'USG_1' }),
    context,
  );
  assert.equal(decision.verdict, 'REPLAYABLE', decision.refusal);
  assert.equal(decision.message.key, 'USG_1');
  assert.equal(decision.summary.key, 'USG_1');
  assert.equal(decision.summary.streamKey, null);
  // And its staleness is looked for under that key.
  assert.equal(stalenessProbe(decision, contracts.RETRY_TOPIC_SUFFIX).key, 'USG_1');
});

test('a sequenced dead letter that kept its key replays under it', () => {
  const decision = assess(deadLetter(), context);
  assert.equal(decision.verdict, 'REPLAYABLE', decision.refusal);
  assert.equal(decision.message.key, 'AST_1');
});

test('every NEVER_AUTO_REPLAY event is refused — there is no override', () => {
  for (const eventName of contracts.NEVER_AUTO_REPLAY) {
    assert.equal(
      assess(deadLetter(envelope({ eventName })), context).refusal,
      'NEVER_AUTO_REPLAY',
      eventName,
    );
  }
});

test('the economic stream is refused by source topic, whatever the event is called', () => {
  const dlq = 'rasta.audit.v1.dlq';
  const audit = {
    dlq,
    topology: topologyOf(dlq, { topics, consumers: contracts.TOPIC_CONSUMERS }),
    topics,
    contracts,
  };
  assert.ok(contracts.NEVER_AUTO_REPLAY_TOPICS.has('rasta.economic.v1'));
  for (const original of ['rasta.economic.v1', 'rasta.economic.v1.retry']) {
    const decision = assess(
      deadLetter(envelope({ eventName: 'A_NAME_THE_LIST_HAS_NOT_CAUGHT_UP_WITH' }), {
        [DLQ_HEADERS.originalTopic]: Buffer.from(original),
      }),
      audit,
    );
    assert.equal(decision.refusal, 'NEVER_AUTO_REPLAY', original);
  }
  // The same consumer's dead letter from another stream is not.
  assert.equal(assess(deadLetter(), audit).verdict, 'REPLAYABLE');
});

test('a dead letter from a .retry topic goes back to that .retry, and its staleness is unknown', () => {
  const decision = assess(
    deadLetter(envelope(), { [DLQ_HEADERS.originalTopic]: Buffer.from('rasta.fleet.v1.retry') }),
    context,
  );
  assert.equal(decision.summary.target, 'rasta.fleet.v1.retry');
  assert.equal(stalenessProbe(decision, contracts.RETRY_TOPIC_SUFFIX), null);
  assert.equal(staleFrom(null, undefined), 'UNKNOWN');
});

// ------------------------------------------------------------------ staleness

test('stale when a newer record for the same stream key follows the original offset', () => {
  const decision = assess(deadLetter(), context);
  const probe = stalenessProbe(decision, contracts.RETRY_TOPIC_SUFFIX);
  assert.deepEqual(probe, { topic: 'rasta.fleet.v1', partition: 1, after: 41n, key: 'AST_1' });
  const low = 0n;
  assert.equal(
    staleFrom(probe, { low, incomplete: false, records: [{ offset: '42', key: 'AST_2' }] }),
    false,
  );
  assert.equal(
    staleFrom(probe, { low, incomplete: false, records: [{ offset: '41', key: 'AST_1' }] }),
    false,
  );
  assert.equal(
    staleFrom(probe, { low, incomplete: false, records: [{ offset: '43', key: 'AST_1' }] }),
    true,
  );
  assert.equal(staleFrom(probe, { low, incomplete: true, records: [] }), 'UNKNOWN');
});

test('retention past the original offset makes staleness unknown, never "not stale"', () => {
  const probe = stalenessProbe(assess(deadLetter(), context), contracts.RETRY_TOPIC_SUFFIX);
  // Offset 42, just after the original 41, is still there: the whole tail was seen.
  assert.equal(staleFrom(probe, { low: 42n, incomplete: false, records: [] }), false);
  // Retention took 42 (streams keep 7 days, dead letters 30): a newer record
  // for the key may have gone with it.
  assert.equal(staleFrom(probe, { low: 43n, incomplete: false, records: [] }), 'UNKNOWN');
  assert.equal(
    staleFrom(probe, { low: 50n, incomplete: false, records: [{ offset: '60', key: 'AST_2' }] }),
    'UNKNOWN',
  );
  // A newer record that survived is still proof.
  assert.equal(
    staleFrom(probe, { low: 50n, incomplete: false, records: [{ offset: '60', key: 'AST_1' }] }),
    true,
  );
  // And a scan that does not say where the partition starts proves nothing.
  assert.equal(staleFrom(probe, { incomplete: false, records: [] }), 'UNKNOWN');
});

test('a stale or unknowably stale record is refused unless --allow-stale names it', () => {
  const decision = assess(deadLetter(), context);
  assert.equal(withStaleness(decision, false, []).verdict, 'REPLAYABLE');
  assert.equal(withStaleness(decision, true, []).refusal, 'STALE');
  assert.equal(withStaleness(decision, 'UNKNOWN', []).refusal, 'STALENESS_UNKNOWN');
  assert.equal(withStaleness(decision, true, ['EVT_OTHER']).refusal, 'STALE');
  const allowed = withStaleness(decision, true, ['EVT_1']);
  assert.equal(allowed.verdict, 'REPLAYABLE');
  assert.equal(allowed.summary.stale, true, 'the report still says it was stale');
});

// ------------------------------------------------------------------ execution and report

test('execution is all or nothing, and exactly the expected count', () => {
  const ok = withStaleness(assess(deadLetter(), context), false, []);
  const refused = assess(deadLetter(envelope({ eventName: 'FUNDS_HELD' })), context);
  assert.deepEqual(executionProblems([ok], 1), []);
  assert.equal(executionProblems([ok], 2).length, 1);
  assert.match(executionProblems([ok, refused], 2)[0], /refused \(NEVER_AUTO_REPLAY\)/);
  assert.equal(executionProblems([], 1).length, 2);
});

test('a report line carries ids, names, reasons and offsets — never the payload', () => {
  const line = reportLine(
    'rpl-1',
    'dry-run',
    withStaleness(assess(deadLetter(), context), false, []),
  );
  const text = JSON.stringify(line);
  assert.ok(!text.includes('the tool never reads'));
  assert.deepEqual(
    {
      eventId: line.eventId,
      target: line.target,
      streamKey: line.streamKey,
      verdict: line.verdict,
      stale: line.stale,
      dlqOffset: line.dlqOffset,
    },
    {
      eventId: 'EVT_1',
      target: 'rasta.fleet.v1.retry',
      streamKey: 'AST_1',
      verdict: 'REPLAYABLE',
      stale: false,
      dlqOffset: '12',
    },
  );
});

// ------------------------------------------------------------------ the replay record

const REPORT = 'rpl-0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const replayable = (body = envelope()) =>
  withStaleness(assess(deadLetter(body), context), false, []);

test('the operator rule is the contract’s', () => {
  assert.equal(OPERATOR_PATTERN.source, contracts.REPLAY_OPERATOR_PATTERN.source);
});

test('a replay record states the run, the operator, the event, both positions and the verdict — no payload', () => {
  const record = replayExecutedRecord(
    replayable(),
    {
      reportId: REPORT,
      operator: 'ops.alice',
      landed: { partition: 1, offset: '40' },
      eventId: 'EVT_RECORD_1',
      occurredAt: '2026-09-30T08:00:00.000Z',
    },
    contracts,
  );
  assert.equal(record.key, REPORT);
  const body = JSON.parse(record.value);
  assert.equal(contracts.eventEnvelopeSchema.safeParse(body).success, true);
  assert.equal(contracts.replayExecutedPayloadSchemaV1.safeParse(body.payload).success, true);
  assert.deepEqual(
    {
      eventName: body.eventName,
      producer: body.producer,
      tenantId: body.tenantId,
      correlationId: body.correlationId,
      causationId: body.causationId,
      actor: body.actor,
    },
    {
      eventName: 'REPLAY_EXECUTED',
      producer: 'ops-replay',
      tenantId: 'ORG_1',
      correlationId: REPORT,
      causationId: 'EVT_1',
      actor: { type: 'USER', id: 'ops.alice' },
    },
  );
  assert.deepEqual(body.payload, {
    reportId: REPORT,
    operator: 'ops.alice',
    replayedEvent: { eventId: 'EVT_1', eventName: 'USAGE_RECORDED', tenantId: 'ORG_1' },
    dlq: { topic: DLQ, partition: 0, offset: '12' },
    target: { topic: 'rasta.fleet.v1.retry', partition: 1, offset: '40' },
    stale: false,
  });
  assert.ok(!record.value.includes('the tool never reads'), 'no payload of the replayed event');
  assert.equal(record.headers[contracts.EVENT_HEADERS.tenantId], 'ORG_1');
  assert.equal(record.headers[contracts.EVENT_HEADERS.producer], 'ops-replay');
});

test('the record of an event with no tenant has none either: a platform record', () => {
  const record = replayExecutedRecord(
    replayable(envelope({ tenantId: undefined })),
    {
      reportId: REPORT,
      operator: 'ops.alice',
      landed: { partition: 0, offset: '1' },
      eventId: 'EVT_RECORD_2',
      occurredAt: '2026-09-30T08:00:00.000Z',
    },
    contracts,
  );
  const body = JSON.parse(record.value);
  assert.equal(body.tenantId, undefined);
  assert.equal(body.payload.replayedEvent.tenantId, undefined);
  assert.equal(record.headers[contracts.EVENT_HEADERS.tenantId], undefined);
});

/**
 * A transactional broker stand-in: a transaction's sends become visible only
 * when it commits, as they do to a read-committed consumer. `fail(topic)` may
 * throw from a send, `failCommit` from the commit.
 */
function fakeBroker({ fail = () => false, failCommit = () => false } = {}) {
  const committed = [];
  const aborted = [];
  const offsets = new Map();
  let transactions = 0;
  const beginTransaction = async () => {
    const pending = [];
    const nth = (transactions += 1);
    return {
      send: async (topic, message) => {
        if (fail(topic)) throw new Error(`${topic} refused (injected)`);
        const offset = offsets.get(topic) ?? 0;
        offsets.set(topic, offset + 1);
        pending.push({ topic, message });
        return { partition: 0, offset: String(offset) };
      },
      commit: async () => {
        if (failCommit(nth)) throw new Error('EndTxn answer lost (injected)');
        committed.push(...pending);
      },
      abort: async () => {
        aborted.push(...pending);
      },
    };
  };
  return { committed, aborted, beginTransaction };
}

function run(decisions, broker) {
  const lines = [];
  const warnings = [];
  let ids = 0;
  return executeReplays(decisions, {
    reportId: REPORT,
    operator: 'ops.alice',
    contracts,
    beginTransaction: broker.beginTransaction,
    newEventId: () => `EVT_RECORD_${(ids += 1)}`,
    now: () => '2026-09-30T08:00:00.000Z',
    report: (line) => lines.push(line),
    warn: (text) => warnings.push(text),
  }).then((outcome) => ({ outcome, lines, warnings }));
}

const two = () => [replayable(), replayable(envelope({ eventId: 'EVT_2', streamKey: 'AST_2' }))];

test('each replay and its record commit together, one transaction per event, record after replay', async () => {
  const broker = fakeBroker();
  const { outcome, lines, warnings } = await run(two(), broker);
  assert.deepEqual(outcome, { written: 2, recorded: 2, failed: false });
  assert.deepEqual(
    broker.committed.map((s) => s.topic),
    ['rasta.fleet.v1.retry', 'rasta.ops.replay.v1', 'rasta.fleet.v1.retry', 'rasta.ops.replay.v1'],
  );
  const records = broker.committed
    .filter((s) => s.topic === 'rasta.ops.replay.v1')
    .map((s) => JSON.parse(s.message.value).payload);
  assert.deepEqual(
    records.map((p) => [p.replayedEvent.eventId, p.target.offset]),
    [
      ['EVT_1', '0'],
      ['EVT_2', '1'],
    ],
  );
  assert.deepEqual(
    lines.map((l) => [l.eventId, l.replayOffset, l.auditEventId, l.auditOffset, l.committed]),
    [
      ['EVT_1', '0', 'EVT_RECORD_1', '0', true],
      ['EVT_2', '1', 'EVT_RECORD_2', '1', true],
    ],
  );
  assert.deepEqual(warnings, []);
});

test('each replayed event carries its own stamp: report, operator, place in the run and event id', async () => {
  const broker = fakeBroker();
  const { lines } = await run(two(), broker);
  const stamps = broker.committed
    .filter((s) => s.topic === 'rasta.fleet.v1.retry')
    .map((s) => s.message.headers[REPLAY_HEADERS.replayId]);
  assert.deepEqual(stamps, [`${REPORT}/ops.alice/1/EVT_1`, `${REPORT}/ops.alice/2/EVT_2`]);
  assert.deepEqual(
    lines.map((l) => l.replayId),
    stamps,
  );
  assert.equal(replayIdFor(REPORT, 'ops.alice', 2, 'EVT_2'), `${REPORT}/ops.alice/2/EVT_2`);
});

test('a replay that fails aborts its transaction: nothing committed, the run stops and fails', async () => {
  const broker = fakeBroker({ fail: (topic) => topic === 'rasta.fleet.v1.retry' });
  const { outcome, lines } = await run(two(), broker);
  assert.deepEqual(outcome, { written: 0, recorded: 0, failed: true });
  assert.deepEqual(broker.committed, []);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].committed, false);
  assert.match(lines[0].error, /refused \(injected\)/);
});

test('a failure — or a kill — between the replay and its record leaves neither committed', async () => {
  // The .retry send succeeded inside the transaction; the record's did not.
  // The replay is aborted with it: no replay without its REPLAY_EXECUTED.
  const broker = fakeBroker({ fail: (topic) => topic === 'rasta.ops.replay.v1' });
  const { outcome, lines } = await run(two(), broker);
  assert.deepEqual(outcome, { written: 0, recorded: 0, failed: true });
  assert.deepEqual(broker.committed, []);
  assert.deepEqual(
    broker.aborted.map((s) => s.topic),
    ['rasta.fleet.v1.retry'],
  );
  assert.equal(lines.length, 1);
  assert.deepEqual(
    [lines[0].eventId, lines[0].replayOffset, lines[0].committed],
    ['EVT_1', '0', false],
  );
});

test('a commit whose answer is lost is reported as unknown, loudly, and fails the run', async () => {
  const broker = fakeBroker({ failCommit: () => true });
  const { outcome, lines, warnings } = await run(two(), broker);
  assert.deepEqual(outcome, { written: 0, recorded: 0, failed: true });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].committed, 'UNKNOWN');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^COMMIT OUTCOME UNKNOWN for EVT_1 .*both committed or both not/);
});

test('an unknown commit on the 2nd event names its own stamp and position, never the 1st', async () => {
  // Round 2 on #166: EVT_1 committed; EVT_2's commit answer is lost. A
  // run-level stamp would be found on EVT_1's replay and read as "EVT_2 landed".
  const broker = fakeBroker({ failCommit: (nth) => nth === 2 });
  const { outcome, lines, warnings } = await run(two(), broker);
  assert.deepEqual(outcome, { written: 1, recorded: 1, failed: true });
  assert.deepEqual(
    lines.map((l) => [l.eventId, l.replayId, l.replayPartition, l.replayOffset, l.committed]),
    [
      ['EVT_1', `${REPORT}/ops.alice/1/EVT_1`, 0, '0', true],
      ['EVT_2', `${REPORT}/ops.alice/2/EVT_2`, 0, '1', 'UNKNOWN'],
    ],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^COMMIT OUTCOME UNKNOWN for EVT_2 /);
  assert.ok(warnings[0].includes(`x-replay-id ${REPORT}/ops.alice/2/EVT_2`), warnings[0]);
  assert.ok(warnings[0].includes('rasta.fleet.v1.retry partition 0 offset 1'), warnings[0]);
  // The stamp the warning names is not on the committed replay of EVT_1.
  const committedStamps = broker.committed
    .filter((s) => s.topic === 'rasta.fleet.v1.retry')
    .map((s) => s.message.headers[REPLAY_HEADERS.replayId]);
  assert.deepEqual(committedStamps, [`${REPORT}/ops.alice/1/EVT_1`]);
});

test('an event its record cannot state is refused by name before anything is sent', () => {
  // The envelope allows any event id; REPLAY_EXECUTED's replayedEvent.eventId
  // allows 128 characters (round 1 on #166).
  const long = 'E'.repeat(129);
  const decision = assess(deadLetter(envelope({ eventId: long })), context);
  assert.equal(decision.verdict, 'REFUSED');
  assert.equal(decision.refusal, 'UNRECORDABLE:replayedEvent.eventId');
  assert.equal(
    assess(deadLetter(envelope({ eventId: 'E'.repeat(128) })), context).verdict,
    'REPLAYABLE',
  );
  assert.equal(recordProblem(replayable().summary, contracts), null);
});
