import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_CEILING,
  UsageError,
  assess,
  executionProblems,
  operatorFrom,
  parseArgs,
  parseTopics,
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

/** A dead letter as EventConsumer writes one: the original body, platform and x-dlq-* headers, no key. */
function deadLetter(body = envelope(), headerOverrides = {}, { key = null } = {}) {
  const headers = {
    [EVENT_HEADERS.eventId]: Buffer.from(body.eventId),
    [EVENT_HEADERS.eventName]: Buffer.from(body.eventName),
    [EVENT_HEADERS.eventVersion]: Buffer.from(String(body.eventVersion)),
    [EVENT_HEADERS.correlationId]: Buffer.from(body.correlationId),
    [EVENT_HEADERS.tenantId]: Buffer.from(body.tenantId),
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
  const decision = assess(deadLetter(envelope(), {}, { key: 'AST_1' }), context);
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
  assert.equal(
    staleFrom(probe, { incomplete: false, records: [{ offset: '42', key: 'AST_2' }] }),
    false,
  );
  assert.equal(
    staleFrom(probe, { incomplete: false, records: [{ offset: '41', key: 'AST_1' }] }),
    false,
  );
  assert.equal(
    staleFrom(probe, { incomplete: false, records: [{ offset: '43', key: 'AST_1' }] }),
    true,
  );
  assert.equal(staleFrom(probe, { incomplete: true, records: [] }), 'UNKNOWN');
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
