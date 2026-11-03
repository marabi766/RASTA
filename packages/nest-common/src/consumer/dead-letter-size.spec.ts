import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { IHeaders } from 'kafkajs';
import {
  DLQ_HEADERS,
  DLQ_HEADER_VALUE_MAX_BYTES,
  DLQ_REASONS,
  EVENT_HEADERS,
  TOPIC_MESSAGE_MAX_BYTES,
  deadLetterMessageMaxBytes,
  gzipGrowthMaxBytes,
  type DlqReason,
} from '@rasta/contracts';
import {
  DLQ_ADDED_HEADERS_MAX_BYTES,
  DeadLetterHeaderError,
  deadLetterHeaders,
  utf8Prefix,
  type DeadLetterDescription,
} from './event-consumer';

/**
 * The dead letter's size bound (PR #378 r2 F1), measured with kafkajs 2.2.4's
 * own encoders — the bytes the broker checks against `max.message.bytes`.
 */
type Encoded = { size(): number };
type RecordArgs = { key: Buffer | null; value: Buffer | null; headers?: IHeaders };
const Record = jest.requireActual<(args: RecordArgs) => Encoded>(
  'kafkajs/src/protocol/recordBatch/record/v0',
);
const { RecordBatch } = jest.requireActual<{
  RecordBatch: (args: { compression: number; records: Encoded[] }) => Promise<Encoded>;
}>('kafkajs/src/protocol/recordBatch/v0');
const NONE = 0;
const GZIP = 1;

const LONGEST_REASON = Object.values(DLQ_REASONS).reduce((a, b) => (b.length > a.length ? b : a));
/** Four UTF-8 bytes each. */
const ASTRAL = '\u{1F512}';

/** Every value at its cap or past it: the largest dead letter `deadLetterHeaders` can describe. */
const WORST_LETTER: DeadLetterDescription = {
  reason: LONGEST_REASON as DlqReason,
  originalTopic: 't'.repeat(249),
  originalPartition: 2_147_483_647,
  originalOffset: '9223372036854775807',
  attempts: Number.MAX_SAFE_INTEGER,
  detail: ASTRAL.repeat(5000),
  producer: 'p'.repeat(1000),
  failedAt: new Date(8.64e15),
};

/**
 * 63 forwarded headers and no `x-producer` (so the dead letter's adds a header
 * rather than replacing one), and a value that leaves the record's length just
 * under the 1,048,576 varint step: the dead letter crosses both steps.
 */
function worstOriginal(): { key: Buffer; value: Buffer; headers: IHeaders } {
  const headers: IHeaders = {
    [EVENT_HEADERS.eventId]: Array.from({ length: 56 }, (_, i) => `EVT-${i}`),
    [EVENT_HEADERS.eventName]: 'ORGANIZATION_STATUS_CHANGED',
    [EVENT_HEADERS.eventVersion]: '1',
    [EVENT_HEADERS.correlationId]: 'COR-1',
    [EVENT_HEADERS.causationId]: 'CAU-1',
    [EVENT_HEADERS.tenantId]: 'ORG-1',
    [EVENT_HEADERS.traceparent]: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    [EVENT_HEADERS.streamSeq]: '7',
  };
  const key = Buffer.from('ORG-1');
  // The record's body (all but its own length varint, 3 bytes below the step)
  // at 1,048,575: one byte under 1,048,576.
  const body = (length: number): number =>
    Record({ key, value: Buffer.alloc(length), headers }).size() - 3;
  let length = 1_048_000;
  for (let tries = 0; body(length) !== 1_048_575; tries += 1) {
    if (tries > 20) throw new Error('no value length puts the record under the varint step');
    length += 1_048_575 - body(length);
  }
  return { key, value: randomBytes(length), headers };
}

describe('the dead letter size bound (PR #378 r2 F1)', () => {
  it('is what the worst case adds to the original record, serialized, and no less', () => {
    const original = worstOriginal();
    const source = Record(original).size();
    const letter = Record({
      key: original.key,
      value: original.value,
      headers: deadLetterHeaders(original.headers, WORST_LETTER),
    }).size();

    expect(letter - source).toBeLessThanOrEqual(DLQ_ADDED_HEADERS_MAX_BYTES);
    // Tight: every cap is reached and both varint steps are crossed.
    expect(letter - source).toBe(DLQ_ADDED_HEADERS_MAX_BYTES);
    expect(DLQ_ADDED_HEADERS_MAX_BYTES).toBe(1632);
  });

  it('cuts the error text and the client id in bytes, on a character boundary', () => {
    const headers = deadLetterHeaders(undefined, {
      ...WORST_LETTER,
      detail: `x${'ب'.repeat(2000)}`,
      producer: `${'中'.repeat(100)}`,
    });
    const error = headers[DLQ_HEADERS.error] as string;
    const producer = headers[EVENT_HEADERS.producer] as string;
    expect(Buffer.byteLength(error)).toBe(999);
    expect(error).toBe(`x${'ب'.repeat(499)}`);
    expect(Buffer.byteLength(producer)).toBe(126);
    expect(producer).toBe('中'.repeat(42));
    expect(Buffer.byteLength(headers[DLQ_HEADERS.reason] as string)).toBeLessThanOrEqual(
      DLQ_HEADER_VALUE_MAX_BYTES.reason,
    );
  });

  it('keeps short values whole, a lone surrogate counted as kafkajs writes it', () => {
    expect(utf8Prefix('abc', 3)).toBe('abc');
    expect(utf8Prefix('\ud800', 3)).toBe('\ud800');
    expect(utf8Prefix('a\ud800', 3)).toBe('a');
    expect(utf8Prefix(ASTRAL.repeat(3), 7)).toBe(ASTRAL);
  });

  it.each([
    ['a topic name Kafka refuses', { originalTopic: 't'.repeat(250) }],
    ['a topic name with a space', { originalTopic: 'rasta.asset v1' }],
    ['a negative partition', { originalPartition: -1 }],
    ['a partition past int32', { originalPartition: 2_147_483_648 }],
    ['a fractional partition', { originalPartition: 1.5 }],
    ['a negative offset', { originalOffset: '-1' }],
    ['a 20-digit offset', { originalOffset: '1'.repeat(20) }],
    ['an offset that is not a number', { originalOffset: '12a' }],
    ['attempts that are not an integer', { attempts: Number.NaN }],
  ] as const)('never cuts what a replay depends on: refuses %s', (_, change) => {
    expect(() => deadLetterHeaders(undefined, { ...WORST_LETTER, ...change })).toThrow(
      DeadLetterHeaderError,
    );
  });

  it("stays within zlib's default-parameter deflateBound for incompressible input of every size tried", () => {
    for (const n of [0, 1, 100, 16_383, 16_384, 65_536, 1_048_588, 1_050_220, 4_194_304]) {
      const input = randomBytes(n);
      expect(gzipSync(input).length).toBeLessThanOrEqual(n + gzipGrowthMaxBytes(n));
    }
  });

  describe('at the source limit, as batches the broker checks', () => {
    /** An uncompressed source batch of exactly `TOPIC_MESSAGE_MAX_BYTES`, incompressible. */
    async function sourceAtLimit(headers: IHeaders): Promise<{ key: Buffer; value: Buffer }> {
      const value = Buffer.from('{}');
      const size = async (length: number): Promise<number> =>
        (
          await RecordBatch({
            compression: NONE,
            records: [Record({ key: Buffer.alloc(length), value, headers })],
          })
        ).size();
      let length = TOPIC_MESSAGE_MAX_BYTES - 2_000;
      for (let tries = 0; (await size(length)) !== TOPIC_MESSAGE_MAX_BYTES; tries += 1) {
        if (tries > 20) throw new Error('no key length puts the batch at the limit');
        length += TOPIC_MESSAGE_MAX_BYTES - (await size(length));
      }
      return { key: randomBytes(length), value };
    }

    it('the dead letter, GZIP, fits the dead-letter limit and not the source limit', async () => {
      const forwarded = { [EVENT_HEADERS.eventId]: 'EVT-1' };
      const { key, value } = await sourceAtLimit(forwarded);
      const dead = await RecordBatch({
        compression: GZIP,
        records: [Record({ key, value, headers: deadLetterHeaders(forwarded, WORST_LETTER) })],
      });
      expect(dead.size()).toBeGreaterThan(TOPIC_MESSAGE_MAX_BYTES);
      expect(dead.size()).toBeLessThanOrEqual(deadLetterMessageMaxBytes(TOPIC_MESSAGE_MAX_BYTES));
    });

    it('needs the GZIP margin when the added bytes do not compress either', async () => {
      // The added headers at their caps, as random bytes rather than text: what
      // the bound must hold for, whatever the values compress to.
      const added = deadLetterHeaders(undefined, WORST_LETTER);
      const incompressible = Object.fromEntries(
        Object.entries(added).map(([name, text]) => [
          name,
          randomBytes(Buffer.byteLength(text as string)),
        ]),
      );
      const { key, value } = await sourceAtLimit({});
      const dead = await RecordBatch({
        compression: GZIP,
        records: [Record({ key, value, headers: incompressible })],
      });
      expect(dead.size()).toBeGreaterThan(TOPIC_MESSAGE_MAX_BYTES + DLQ_ADDED_HEADERS_MAX_BYTES);
      expect(dead.size()).toBeLessThanOrEqual(deadLetterMessageMaxBytes(TOPIC_MESSAGE_MAX_BYTES));
    });
  });
});
