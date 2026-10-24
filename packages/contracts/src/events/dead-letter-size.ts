import { DLQ_HEADERS, DLQ_REASONS, EVENT_HEADERS } from './envelope';

/**
 * How large a dead letter can be, and what a dead-letter topic's limit does
 * and does not cover (PR #378 r2 F1; restated in r4 to claim only what is
 * proved).
 *
 * The shared consumer's dead letter (`deadLetterHeaders` in
 * `@rasta/nest-common`) is the original record — the same key, the same value
 * bytes, a subset of its platform headers — plus the headers the consumer
 * adds, sent GZIP at KafkaJS's default level (6). The broker checks a topic's
 * `max.message.bytes` against the stored batch: compressed when it was sent
 * compressed.
 *
 * **Proved.**
 *
 *   - every value the consumer adds is bounded in UTF-8 bytes
 *     ({@link DLQ_HEADER_VALUE_MAX_BYTES}), so what it adds to the record, as
 *     Kafka serializes it, is at most {@link DLQ_ADDED_HEADERS_MAX_BYTES};
 *   - GZIP of N bytes, at the parameters kafkajs uses, is at most
 *     N + {@link gzipGrowthMaxBytes}(N), whatever the bytes. The margin grows
 *     with N: 345 bytes at the planned 1 MiB source limit, 665 at 2 MiB;
 *   - so the shared consumer's dead letter of a source batch sent
 *     uncompressed, or GZIP that did not shrink it (bytes that do not
 *     compress), fits a topic limited to {@link deadLetterMessageMaxBytes} of
 *     the source's limit.
 *
 * **Measured, not proved:** a source batch GZIP-compressed at KafkaJS's
 * default level whose bytes do compress — one record, or several that a relay
 * batched (`kafka.publisher.ts`). Over 400 random batches of 1–12 records the
 * worst dead letter exceeded its whole source batch by 302 bytes, against
 * 1,977 of headroom at the planned limit.
 *
 * **Known escapes** (PR #378 r3; a design task of their own, PM decision
 * D-063). Measured by the r3 review with KafkaJS's encoder:
 *
 *   (i)   a source compressed at a higher level than the dead letter's
 *         recompression: one record GZIP level 9, a 1,030,499-byte batch,
 *         becomes a 1,084,193-byte dead letter at level 6, over the
 *         1,050,565-byte limit. Neither the broker nor the ACLs restrict a
 *         producer's compression level. Pinned as it behaves today by
 *         `scripts/dead-letter-escape.broker.test.mjs`;
 *   (ii)  fleet's parked dead letters rebuild their platform headers from the
 *         stored envelope (`envelopeHeaders` in `asset-sync.consumer.ts`).
 *         `eventId`, `eventName`, `correlationId`, `tenantId`, `causationId`
 *         and `traceparent` have no byte bound in the envelope schema
 *         (`producer` is a name of at most 63 ASCII characters, `streamSeq` a
 *         safe integer, `eventVersion` a number): a 954,635-byte source batch
 *         became a 1,908,980-byte dead letter with a 1,266,668-byte
 *         `x-causation-id` that the original record did not carry;
 *   (iii) fleet publishes the envelope re-serialized from its JSONB column,
 *         not the original bytes, which can compress worse: probably
 *         (587,993 → 1,158,527 bytes in r3's in-memory simulation; not
 *         reproduced on PostgreSQL).
 *
 * In each the dead-letter send is refused MESSAGE_TOO_LARGE, as it is on main
 * (whose shared send was uncompressed, to topics that inherit the broker's
 * default limit). Nothing is committed past the record: the shared consumer
 * crashes — kafkajs does not restart a consumer on a non-retriable error, so
 * it stops on every partition it reads until the service restarts and meets
 * the record again — and the record survives only as long as the source
 * topic's retention; fleet's outbox row stays unpublished and is retried.
 * The record is not lost silently; the consumer's availability is.
 */

/**
 * The limit every source topic is given: Kafka's own default
 * `message.max.bytes`, 1,048,588 bytes (1 MiB plus the 12-byte log overhead of
 * the batch's offset and length), which a topic inherits when it sets nothing.
 * Kafka 3.9 (`apache/kafka:3.9.0`, the broker compose and CI run) has that
 * default, and neither the broker nor any topic in this repository overrode
 * it before this was stated. On a broker where a topic has more, effective or
 * inherited, `create-topics.sh` keeps it (a single run never lowers a limit,
 * r4 F2; r5 says what it sees of a concurrent writer), so stating it changes
 * nothing a producer sees.
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
 * Nothing else grows in the shared consumer's dead letter: the key and the
 * value are the original's bytes; the forwarded headers are a subset of the
 * original's; a lone record's offset and timestamp deltas are 0, one byte
 * each, never more than the original's; the batch header is the same 61
 * bytes. (Fleet's parked dead letters rebuild their forwarded headers and
 * value; this bound covers only what `deadLetterHeaders` adds to them —
 * known escapes (ii) and (iii) above.)
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
 * The smallest `max.message.bytes` a dead-letter topic gets over sources
 * limited to `sourceMaxBytes`: the source's limit, plus what the shared
 * consumer's dead letter adds, plus what GZIP can add to the whole.
 *
 * A proof for a source batch sent uncompressed: its record is at most
 * `sourceMaxBytes` less the 61-byte batch header, so the dead letter's record
 * is at most that plus {@link DLQ_ADDED_HEADERS_MAX_BYTES}, compressed into at
 * most that plus {@link gzipGrowthMaxBytes}. The same holds for a source sent
 * GZIP whose batch is no smaller than its record (bytes that do not compress,
 * the r2 reproduction). For a source sent GZIP at KafkaJS's default level
 * whose bytes do compress it is measured, not proved — one record, or several
 * a relay batched (deflate's 32 KiB window can refer back to records before
 * it). It does not hold for a source compressed at a higher level, nor for
 * fleet's parked dead letters (the known escapes above).
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
