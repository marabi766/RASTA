import { DLQ_HEADERS, DLQ_REASONS, EVENT_HEADERS } from './envelope';

/**
 * How large a dead letter can be, and so how large a dead-letter topic's
 * messages must be allowed to be (PR #378 r2 F1).
 *
 * A dead letter is the original record — the same key, the same value bytes,
 * the original's platform headers — plus the headers the shared consumer adds
 * (`deadLetterHeaders` in `@rasta/nest-common`), sent GZIP. The broker checks
 * a topic's `max.message.bytes` against the stored batch: compressed when it
 * was sent compressed. So a record the source topic admitted at its limit can
 * still be refused by a dead-letter topic with the same limit, and a refused
 * dead letter is never committed past: the partition stops there.
 *
 * The headroom is built, not hoped for:
 *
 *   - every value the consumer adds is bounded in UTF-8 bytes
 *     ({@link DLQ_HEADER_VALUE_MAX_BYTES}), so what it adds to the record, as
 *     Kafka serializes it, is at most {@link DLQ_ADDED_HEADERS_MAX_BYTES};
 *   - GZIP of N bytes is at most N + {@link gzipGrowthMaxBytes}(N), whatever
 *     the bytes;
 *   - every topic has an explicit limit, and a dead-letter topic's is at least
 *     {@link deadLetterMessageMaxBytes} of the largest limit of any topic that
 *     dead-letters into it (`brokerTopics`, checked by
 *     `scripts/check-kafka-topic-limits.mjs`).
 */

/**
 * The limit every source topic is given: Kafka's own default
 * `message.max.bytes`, 1,048,588 bytes (1 MiB plus the 12-byte log overhead of
 * the batch's offset and length), which a topic inherits when it sets nothing.
 * Kafka 3.9 (`apache/kafka:3.9.0`, the broker compose and CI run) has that
 * default, and neither the broker nor any topic overrode it before this was
 * stated, so stating it changes nothing a producer sees.
 */
export const TOPIC_MESSAGE_MAX_BYTES = 1_048_588;

/**
 * The most UTF-8 bytes each header value the consumer adds may hold.
 *
 * Values that a replay depends on are never cut: they are refused instead when
 * they are larger than any value Kafka itself can produce (a topic name is at
 * most 249 ASCII characters; a partition is a non-negative int32; an offset a
 * non-negative int64). The two free-text values are cut, on a character
 * boundary: the error text, which is a diagnostic, and the writing client's
 * id, which a replay never reads (it restores the producer from the envelope).
 */
export const DLQ_HEADER_VALUE_MAX_BYTES = Object.freeze({
  /** The longest declared reason. A reason is one of `DLQ_REASONS`. */
  reason: Math.max(...Object.values(DLQ_REASONS).map((reason) => utf8Length(reason))),
  /** Kafka's own topic-name limit: 249 characters of `[a-zA-Z0-9._-]`. */
  originalTopic: 249,
  /** A non-negative int32 in decimal: 2147483647. */
  originalPartition: 10,
  /** A non-negative int64 in decimal: 9223372036854775807. */
  originalOffset: 19,
  /** A non-negative safe integer in decimal: 9007199254740991. */
  attempts: 16,
  /** Cut to this many bytes (it was 1,000 characters, up to 3,000 bytes). */
  error: 1000,
  /** `Date#toISOString`, extended years included: +275760-09-13T00:00:00.000Z. */
  firstFailedAt: 27,
  /** The consumer's client id, cut to this many bytes. */
  producer: 128,
});

const ADDED_HEADERS: readonly (readonly [string, number])[] = [
  [DLQ_HEADERS.reason, DLQ_HEADER_VALUE_MAX_BYTES.reason],
  [DLQ_HEADERS.originalTopic, DLQ_HEADER_VALUE_MAX_BYTES.originalTopic],
  [DLQ_HEADERS.originalPartition, DLQ_HEADER_VALUE_MAX_BYTES.originalPartition],
  [DLQ_HEADERS.originalOffset, DLQ_HEADER_VALUE_MAX_BYTES.originalOffset],
  [DLQ_HEADERS.attempts, DLQ_HEADER_VALUE_MAX_BYTES.attempts],
  [DLQ_HEADERS.error, DLQ_HEADER_VALUE_MAX_BYTES.error],
  [DLQ_HEADERS.firstFailedAt, DLQ_HEADER_VALUE_MAX_BYTES.firstFailedAt],
  // Replaces the original's `x-producer` when it had one; counted whole, as
  // though it had none.
  [EVENT_HEADERS.producer, DLQ_HEADER_VALUE_MAX_BYTES.producer],
];

/**
 * What a dead letter's record can add to the original's, in serialized bytes
 * (Kafka record format v2, as kafkajs writes it):
 *
 *   - each added header, once: its name's length (varint), its name, its
 *     value's length (varint) and its value at its cap. None repeats — the
 *     forwarded headers are the original's platform headers, which never carry
 *     a `x-dlq-*` name, and `x-producer` is replaced, not added again;
 *   - 2 bytes of framing: the record's length and its header count are
 *     varints, whose size steps at 64, 8,192, 1,048,576 and 134,217,728.
 *     Adding 8 headers, or under 2 KB, crosses at most one step each.
 *
 * Nothing else grows. The key and the value are the original's bytes; the
 * forwarded headers are a subset of the original's; a lone record's offset and
 * timestamp deltas are 0, one byte each, never more than the original's; the
 * batch header is the same 61 bytes.
 */
export const DLQ_ADDED_HEADERS_MAX_BYTES =
  ADDED_HEADERS.reduce(
    (total, [name, valueMax]) =>
      total + varIntSize(utf8Length(name)) + utf8Length(name) + varIntSize(valueMax) + valueMax,
    0,
  ) + 2;

/**
 * The most GZIP can add to `n` bytes, whatever they are: zlib's own
 * `deflateBound` for the parameters Node's `zlib.gzip` uses, which kafkajs's
 * GZIP codec calls with none of its own (level 6, windowBits 15, memLevel 8).
 *
 * Derived, not measured: incompressible input is written as stored blocks, and
 * deflate ends a block every 16,383 symbols (`lit_bufsize - 1`, memLevel 8),
 * each stored block costing a 5-byte header — `n/4096 + n/16384` covers
 * 5 bytes per 16,384 — plus `n >> 25` and 7 bytes for the final block and bit
 * padding (`deflateBound` in zlib's deflate.c), plus GZIP's 10-byte header and
 * 8-byte trailer. Node 22's zlib (1.3.1) stays within it for random input at
 * every size the unit test tries.
 */
export function gzipGrowthMaxBytes(n: number): number {
  return Math.floor(n / 4096) + Math.floor(n / 16384) + Math.floor(n / 33554432) + 7 + 18;
}

/**
 * The smallest `max.message.bytes` a dead-letter topic needs for every record
 * a topic limited to `sourceMaxBytes` admitted: the source's limit, plus what
 * the dead letter adds, plus what GZIP can add to the whole.
 *
 * A proof for a source batch sent uncompressed: its record is at most
 * `sourceMaxBytes` less the batch header, so the dead letter's records are at
 * most that plus {@link DLQ_ADDED_HEADERS_MAX_BYTES}, compressed into at most
 * that plus {@link gzipGrowthMaxBytes}. The same holds for a source sent GZIP
 * whose bytes do not compress (the r2 reproduction), whose batch is no smaller
 * than its record. For bytes that do compress it rests on GZIP shrinking the
 * copied record as it shrank the original — true of kafkajs's one-record
 * batches, not proved for a record that a producer batched after others it
 * could refer back to (deflate's 32 KiB window).
 */
export function deadLetterMessageMaxBytes(sourceMaxBytes: number): number {
  const uncompressed = sourceMaxBytes + DLQ_ADDED_HEADERS_MAX_BYTES;
  return uncompressed + gzipGrowthMaxBytes(uncompressed);
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** The size of Kafka's zigzag varint for a non-negative `n`. */
function varIntSize(n: number): number {
  let zigzag = n * 2;
  let size = 1;
  while (zigzag >= 128) {
    zigzag = Math.floor(zigzag / 128);
    size += 1;
  }
  return size;
}
