/**
 * The canonical byte representation an audit record is hashed from (ADR-053 § 6).
 *
 * ## Why this is not `JSON.stringify`
 *
 * A hash chain is only evidence if two honest readers, on two machines, years
 * apart, derive the same bytes from the same row. `JSON.stringify` derives them
 * from **insertion order**, which is a property of the object a particular
 * `SELECT` happened to build, not a property of the record. Re-order two
 * columns in a `select` clause and every hash in the store stops matching, with
 * no data having changed and nothing to point at. The same goes for
 * locale-formatted dates and numbers, for `toLocaleString`, and for any
 * representation that a runtime is free to change between versions.
 *
 * So the encoding here is positional and explicit: a fixed field order declared
 * once in `CANONICAL_FIELDS`, a one-byte type tag on every value, and a length
 * prefix on everything variable-length. Nothing depends on object key order,
 * nothing depends on a locale, and nothing depends on how a JSON serialiser
 * chooses to spell a number.
 *
 * ## Length prefixes are the security property, not tidiness
 *
 * Without them the encoding is ambiguous: `action = "a"`, `resourceType = "bc"`
 * and `action = "ab"`, `resourceType = "c"` would produce identical bytes, and
 * an attacker who can choose two adjacent fields can move a boundary without
 * changing the hash. Every variable-length value below therefore carries its
 * byte length, and every value carries a tag, so a null and an empty string are
 * different bytes rather than both being nothing.
 *
 * ## Versioned, because a canonical form can only ever be replaced
 *
 * `CANONICAL_VERSION` is part of the hashed prefix. If the encoding ever has to
 * change, the new version produces different bytes for the same row by
 * construction, which makes the change visible as a chain boundary instead of
 * as a silent field of mismatches. Old segments stay verifiable under the
 * version they were written with; they are never re-hashed, because re-hashing
 * evidence to make it agree with a new rule is exactly the operation this store
 * exists to make impossible.
 */

/** The version of the encoding below. Part of the hashed prefix. */
export const CANONICAL_VERSION = 1;

/**
 * The domain-separation prefix.
 *
 * Hashing a bare field list would let the same bytes mean something else in
 * another context. The prefix binds every digest to "this store, this
 * encoding, this version".
 */
const CANONICAL_PREFIX = Buffer.from(`rasta.audit.canonical.v${CANONICAL_VERSION}\n`, 'utf8');

/**
 * Type tags. Fixed values, never reordered — a tag is part of the wire format
 * and changing one is a new `CANONICAL_VERSION`, not an edit.
 */
const TAG = {
  NULL: 0x00,
  TEXT: 0x01,
  BIGINT: 0x02,
  INTEGER: 0x03,
  BOOLEAN: 0x04,
  INSTANT: 0x05,
  LIST: 0x06,
  MAP: 0x07,
  BYTES: 0x08,
  DOUBLE: 0x09,
} as const;

/** How deep a `changes` document may nest before the encoder refuses it. */
const MAX_JSON_DEPTH = 32;

function u32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function tagged(tag: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), u32(payload.length), payload]);
}

/** A tag and nothing else. `null` is one byte, and never zero bytes. */
export function encodeNull(): Buffer {
  return Buffer.from([TAG.NULL]);
}

/** UTF-8, length-prefixed. An empty string is a tag and a zero length. */
export function encodeText(value: string): Buffer {
  return tagged(TAG.TEXT, Buffer.from(value, 'utf8'));
}

export function encodeNullableText(value: string | null | undefined): Buffer {
  return value === null || value === undefined ? encodeNull() : encodeText(value);
}

/**
 * A 64-bit integer as its canonical decimal spelling.
 *
 * `BigInt.prototype.toString()` is specified to emit no leading zeros, no
 * separators and no locale digits, so `-0n` and `0n` both spell `0` and there
 * is exactly one representation of every value. Not encoded as eight raw bytes
 * because a decimal string is what a human reading a divergence report can
 * compare against the row.
 */
export function encodeBigInt(value: bigint): Buffer {
  return tagged(TAG.BIGINT, Buffer.from(value.toString(10), 'utf8'));
}

export function encodeNullableBigInt(value: bigint | null | undefined): Buffer {
  return value === null || value === undefined ? encodeNull() : encodeBigInt(value);
}

/** A safe integer. Anything else is a programming error and is refused. */
export function encodeInteger(value: number): Buffer {
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalisationError(`not a safe integer: ${String(value)}`);
  }
  // `Object.is` rather than `===`: `-0 === 0` is true, and `String(-0)` is
  // already `'0'`, but stating it here keeps the invariant readable.
  const normalised = Object.is(value, -0) ? 0 : value;
  return tagged(TAG.INTEGER, Buffer.from(normalised.toString(10), 'utf8'));
}

export function encodeBoolean(value: boolean): Buffer {
  return Buffer.from([TAG.BOOLEAN, value ? 0x01 : 0x00]);
}

/**
 * An instant, as epoch milliseconds in decimal.
 *
 * Not an ISO string: `toISOString` is stable today, but it is a *formatting*
 * function, and a formatting function is the wrong dependency for evidence.
 * Epoch milliseconds are an integer with one spelling, no timezone, no
 * calendar, no fractional-second padding rule to get wrong, and no way for a
 * reader in another locale to derive a different value.
 *
 * The column is `TIMESTAMPTZ(6)` and JavaScript `Date` carries milliseconds, so
 * a microsecond component written by something other than this service would
 * not be visible here. Nothing this service writes has one — every timestamp it
 * supplies comes from a `Date` or from `now()` read into one — and the limit is
 * stated in the runbook rather than left to be discovered.
 */
export function encodeInstant(value: Date): Buffer {
  const millis = value.getTime();
  if (!Number.isFinite(millis)) {
    throw new CanonicalisationError('not a valid instant');
  }
  return tagged(TAG.INSTANT, Buffer.from(millis.toString(10), 'utf8'));
}

/**
 * Raw bytes, length-prefixed. Reached only from `encodeJson`, for a byte value
 * inside a `changes` document.
 *
 * Deliberately **not** how the predecessor hash enters the digest: ADR-053 § 6
 * appends the previous hash to the canonical record rather than making it a
 * canonical field, and `computeRecordHash` appends it raw (`audit.chain.ts`).
 */
export function encodeBytes(value: Uint8Array): Buffer {
  return tagged(TAG.BYTES, Buffer.from(value));
}

/**
 * An ordered list of strings.
 *
 * Order is preserved rather than sorted. `actorRoles` is a sequence the
 * producer chose, and sorting it would make two genuinely different records
 * hash identically — a canonical form must remove ambiguity, never information.
 */
export function encodeTextList(values: readonly string[]): Buffer {
  const parts = values.map((value) => encodeText(value));
  return Buffer.concat([Buffer.from([TAG.LIST]), u32(values.length), ...parts]);
}

/** Raised when a value cannot be encoded deterministically. */
export class CanonicalisationError extends Error {
  constructor(message: string) {
    super(`audit record cannot be canonicalised: ${message}`);
    this.name = 'CanonicalisationError';
  }
}

/**
 * A JSON document, encoded structurally rather than as text.
 *
 * Object keys are sorted by their **UTF-8 byte sequence**, not by
 * `Array.prototype.sort`'s default, which compares UTF-16 code units and
 * therefore orders characters above the basic multilingual plane differently
 * from every byte-oriented implementation. The store is Persian-facing and
 * `changes` may carry any UTF-8 key, so this is the difference between a chain
 * that verifies and one that does not.
 *
 * `undefined`, functions, symbols, `NaN` and `Infinity` are refused rather than
 * coerced: each of them has no JSON spelling, and silently turning one into
 * `null` would hash two different documents to the same value.
 */
export function encodeJson(value: unknown, depth = 0): Buffer {
  if (depth > MAX_JSON_DEPTH) {
    throw new CanonicalisationError(`json nesting exceeds ${MAX_JSON_DEPTH}`);
  }

  if (value === null) return encodeNull();

  switch (typeof value) {
    case 'string':
      return encodeText(value);
    case 'boolean':
      return encodeBoolean(value);
    case 'bigint':
      return encodeBigInt(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalisationError(`json number is not finite: ${String(value)}`);
      }
      if (Number.isSafeInteger(value)) return encodeInteger(value);
      // Shortest round-trip decimal. `Number.prototype.toString` is specified
      // (ECMA-262 6.1.6.1.20) and locale-independent, so this is one spelling
      // per value on every conforming runtime.
      return tagged(TAG.DOUBLE, Buffer.from((Object.is(value, -0) ? 0 : value).toString(), 'utf8'));
    case 'object':
      break;
    default:
      throw new CanonicalisationError(`json value of type ${typeof value} has no encoding`);
  }

  if (Array.isArray(value)) {
    const parts = value.map((element) => encodeJson(element, depth + 1));
    return Buffer.concat([Buffer.from([TAG.LIST]), u32(value.length), ...parts]);
  }

  if (value instanceof Date) return encodeInstant(value);
  if (value instanceof Uint8Array) return encodeBytes(value);

  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, member] of entries) {
    if (member === undefined) {
      throw new CanonicalisationError(`json key ${JSON.stringify(key)} holds undefined`);
    }
  }
  entries.sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  );

  const parts = entries.flatMap(([key, member]) => [
    encodeText(key),
    encodeJson(member, depth + 1),
  ]);
  return Buffer.concat([Buffer.from([TAG.MAP]), u32(entries.length), ...parts]);
}

/**
 * Every field the record hash covers, in the one order that defines the
 * encoding.
 *
 * ## What is here, and what is not
 *
 * Every column of `audit_event` except `record_hash` and `previous_hash`
 * themselves — the hash cannot cover its own output, which is why ADR-053 § 6
 * writes the rule as "the canonical record **without** the hash fields, plus
 * the previous hash".
 *
 * That includes the two columns the database used to fill in by itself.
 * `recorded_at` and `sequence_no` are now read out of the same transaction that
 * writes the row (`AuditRepository.ingest`) and supplied explicitly, precisely
 * so they can be hashed: a value the chain does not cover is a value somebody
 * can change without the chain noticing, and "when did this store learn of it"
 * is exactly the kind of fact an attacker would want to move.
 *
 * `recorded_at` is still the database's clock and never this process's — it
 * comes from `now()` inside the writing transaction, which is the same value
 * the old column default produced.
 *
 * ## Adding a field is a version change
 *
 * Appending to this list changes the bytes of every future record and none of
 * the past ones, so it must come with a new `CANONICAL_VERSION`. There is no
 * "just one more column" edit here that is safe to make quietly.
 */
export interface HashableAuditRecord {
  readonly id: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly actorRoles: readonly string[];
  readonly organizationId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly reason: string | null;
  readonly changes: unknown;
  readonly occurrenceCount: number;
  readonly sourceService: string;
  readonly sourceServiceVersion: string | null;
  readonly sourceEventId: string;
  readonly sourceEventName: string;
  readonly sourceTopic: string;
  readonly sourceIp: string | null;
  readonly sourceUserAgent: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly traceparent: string | null;
  readonly sourceStreamSeq: bigint | null;
  readonly sequenceNo: bigint;
  readonly correctionOf: string | null;
}

interface CanonicalField {
  readonly name: keyof HashableAuditRecord;
  readonly encode: (record: HashableAuditRecord) => Buffer;
}

/** The declared field order. Positional: the names are documentation. */
export const CANONICAL_FIELDS: readonly CanonicalField[] = [
  { name: 'id', encode: (r) => encodeText(r.id) },
  { name: 'occurredAt', encode: (r) => encodeInstant(r.occurredAt) },
  { name: 'recordedAt', encode: (r) => encodeInstant(r.recordedAt) },
  { name: 'actorType', encode: (r) => encodeText(r.actorType) },
  { name: 'actorId', encode: (r) => encodeNullableText(r.actorId) },
  { name: 'actorRoles', encode: (r) => encodeTextList(r.actorRoles) },
  { name: 'organizationId', encode: (r) => encodeNullableText(r.organizationId) },
  { name: 'action', encode: (r) => encodeText(r.action) },
  { name: 'resourceType', encode: (r) => encodeText(r.resourceType) },
  { name: 'resourceId', encode: (r) => encodeNullableText(r.resourceId) },
  { name: 'outcome', encode: (r) => encodeText(r.outcome) },
  { name: 'errorCode', encode: (r) => encodeNullableText(r.errorCode) },
  { name: 'reason', encode: (r) => encodeNullableText(r.reason) },
  { name: 'changes', encode: (r) => encodeJson(r.changes ?? null) },
  { name: 'occurrenceCount', encode: (r) => encodeInteger(r.occurrenceCount) },
  { name: 'sourceService', encode: (r) => encodeText(r.sourceService) },
  { name: 'sourceServiceVersion', encode: (r) => encodeNullableText(r.sourceServiceVersion) },
  { name: 'sourceEventId', encode: (r) => encodeText(r.sourceEventId) },
  { name: 'sourceEventName', encode: (r) => encodeText(r.sourceEventName) },
  { name: 'sourceTopic', encode: (r) => encodeText(r.sourceTopic) },
  { name: 'sourceIp', encode: (r) => encodeNullableText(r.sourceIp) },
  { name: 'sourceUserAgent', encode: (r) => encodeNullableText(r.sourceUserAgent) },
  { name: 'correlationId', encode: (r) => encodeText(r.correlationId) },
  { name: 'causationId', encode: (r) => encodeNullableText(r.causationId) },
  { name: 'traceparent', encode: (r) => encodeNullableText(r.traceparent) },
  { name: 'sourceStreamSeq', encode: (r) => encodeNullableBigInt(r.sourceStreamSeq) },
  { name: 'sequenceNo', encode: (r) => encodeBigInt(r.sequenceNo) },
  { name: 'correctionOf', encode: (r) => encodeNullableText(r.correctionOf) },
];

/**
 * The canonical bytes of one record, without its hash fields.
 *
 * The field count is hashed alongside the prefix so that appending a field can
 * never produce the same bytes as a shorter record whose last value happened to
 * decode the same way.
 */
export function canonicaliseAuditRecord(record: HashableAuditRecord): Buffer {
  const fields = CANONICAL_FIELDS.map((field) => field.encode(record));
  return Buffer.concat([CANONICAL_PREFIX, u32(CANONICAL_FIELDS.length), ...fields]);
}
