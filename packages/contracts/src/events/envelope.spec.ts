import { z } from 'zod';
import {
  EVENT_HEADERS,
  MAX_STREAM_SEQ,
  assertSafeStreamSeq,
  eventEnvelopeSchema,
  formatStreamSeq,
  parseEnvelope,
  toStreamSeq,
} from './envelope';

/**
 * ADR-051 § D-5 — the two optional stream fields on the envelope.
 *
 * The property these tests exist to hold is **mixed-version compatibility**.
 * During a staged rollout an old producer emits neither field and a new
 * consumer must still accept the envelope; a new producer emits both and an
 * old consumer must ignore them. Nothing here may make either field required,
 * and `eventVersion` deliberately does not change — an added optional field is
 * not a breaking change.
 *
 * The second property is that `streamSeq` stays a **number**. The database
 * column is `BIGINT`, so the conversion at the wire boundary is checked, and a
 * value that cannot be represented exactly is refused rather than rounded.
 */

const base = {
  eventId: '01J000000000000000000000AA',
  eventName: 'ORDER_CREATED',
  eventVersion: 1,
  occurredAt: '2026-09-05T10:00:00.000Z',
  producer: 'marketplace-service',
  producerVersion: '1.2.3',
  aggregateType: 'Order',
  aggregateId: 'ORD_1',
  correlationId: 'COR_1',
  payload: { orderId: 'ORD_1' },
};

const payloadSchema = z.object({ orderId: z.string() });

// ---------------------------------------------------------------------------
// Mixed-version compatibility
// ---------------------------------------------------------------------------

describe('the stream fields are optional in both directions', () => {
  it('accepts an envelope with neither field — the old producer', () => {
    const envelope = eventEnvelopeSchema.parse(base);
    expect(envelope.streamSeq).toBeUndefined();
    expect(envelope.streamKey).toBeUndefined();
    // Nothing is invented for an old envelope: absent stays absent, so a
    // consumer cannot mistake a default for a real position.
    expect(Object.hasOwn(envelope, 'streamSeq')).toBe(false);
    expect(Object.hasOwn(envelope, 'streamKey')).toBe(false);
  });

  it('accepts an envelope with both fields — the new producer', () => {
    const envelope = eventEnvelopeSchema.parse({ ...base, streamSeq: 42, streamKey: 'ORD_1' });
    expect(envelope.streamSeq).toBe(42);
    expect(envelope.streamKey).toBe('ORD_1');
  });

  it('does not change eventVersion, because an optional field is not a break', () => {
    const withStream = eventEnvelopeSchema.parse({ ...base, streamSeq: 7, streamKey: 'K' });
    const without = eventEnvelopeSchema.parse(base);
    expect(withStream.eventVersion).toBe(without.eventVersion);
  });

  it('round-trips through JSON with the fields present', () => {
    const envelope = eventEnvelopeSchema.parse({ ...base, streamSeq: 9, streamKey: 'ORD_1' });
    const revived = eventEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)));
    expect(revived).toEqual(envelope);
  });

  it('round-trips through JSON with the fields absent', () => {
    const envelope = eventEnvelopeSchema.parse(base);
    const revived = eventEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)));
    expect(revived).toEqual(envelope);
  });

  it('parseEnvelope carries the fields through, present or absent', () => {
    const withStream = parseEnvelope({ ...base, streamSeq: 3, streamKey: 'ORD_1' }, payloadSchema);
    expect([withStream.streamSeq, withStream.streamKey]).toEqual([3, 'ORD_1']);
    expect(withStream.payload.orderId).toBe('ORD_1');

    const without = parseEnvelope(base, payloadSchema);
    expect(without.streamSeq).toBeUndefined();
    expect(without.payload.orderId).toBe('ORD_1');
  });

  it('accepts one field without the other rather than failing the envelope', () => {
    // Not a shape the producer emits, but an envelope arriving mid-rollout must
    // not be rejected outright — a consumer decides what to do with a partial
    // one, and rejecting here would dead-letter it instead.
    expect(() => eventEnvelopeSchema.parse({ ...base, streamSeq: 1 })).not.toThrow();
    expect(() => eventEnvelopeSchema.parse({ ...base, streamKey: 'K' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Validation — a sequence that is not a positive safe integer is refused
// ---------------------------------------------------------------------------

describe('streamSeq validation', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 2],
    ['infinite', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('rejects a %s sequence', (_label, value) => {
    expect(() => eventEnvelopeSchema.parse({ ...base, streamSeq: value })).toThrow();
  });

  it.each([
    ['a string', '42'],
    ['a bigint', 42n],
    ['null', null],
    ['an object', { value: 42 }],
  ])('rejects %s in place of a number', (_label, value) => {
    expect(() => eventEnvelopeSchema.parse({ ...base, streamSeq: value })).toThrow();
  });

  it('accepts the largest representable sequence', () => {
    const envelope = eventEnvelopeSchema.parse({ ...base, streamSeq: MAX_STREAM_SEQ });
    expect(envelope.streamSeq).toBe(MAX_STREAM_SEQ);
  });

  it('rejects an empty streamKey', () => {
    expect(() => eventEnvelopeSchema.parse({ ...base, streamKey: '' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The BIGINT boundary
// ---------------------------------------------------------------------------

describe('the wire boundary between BIGINT and number', () => {
  it('converts a bigint from the database to a number', () => {
    expect(toStreamSeq(1n)).toBe(1);
    expect(toStreamSeq(BigInt(MAX_STREAM_SEQ))).toBe(MAX_STREAM_SEQ);
  });

  it('passes a number through unchanged', () => {
    expect(toStreamSeq(12)).toBe(12);
  });

  it('refuses rather than rounds a bigint beyond the safe range', () => {
    // The failure this prevents: Number(9007199254740993n) is 9007199254740992,
    // silently off by one, which would put a consumer's gap detection
    // permanently out of step with the producer.
    expect(() => toStreamSeq(BigInt(MAX_STREAM_SEQ) + 2n)).toThrow(RangeError);
    expect(() => toStreamSeq(BigInt(MAX_STREAM_SEQ) + 2n)).toThrow(/positive safe integer/);
  });

  it.each([0, -1, 1.5, Number.NaN])('assertSafeStreamSeq rejects %p', (value) => {
    expect(() => assertSafeStreamSeq(value)).toThrow(RangeError);
  });

  it('formats the header value as canonical decimal', () => {
    expect(formatStreamSeq(1)).toBe('1');
    expect(formatStreamSeq(1234567)).toBe('1234567');
    expect(formatStreamSeq(MAX_STREAM_SEQ)).toBe(String(MAX_STREAM_SEQ));
    // No exponent notation, no separators, no padding — a consumer parses it
    // with a plain Number()/parseInt and gets the same value back.
    expect(formatStreamSeq(MAX_STREAM_SEQ)).not.toMatch(/[e+,_]/);
  });

  it('never serialises a bigint into JSON', () => {
    // Guards the rule rather than the implementation: if a bigint ever reached
    // the envelope, this is the error that would surface in production.
    expect(() => JSON.stringify({ streamSeq: 1n })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

describe('EVENT_HEADERS', () => {
  it('names the stream sequence header exactly as ADR-051 § D-5 does', () => {
    expect(EVENT_HEADERS.streamSeq).toBe('x-stream-seq');
  });

  it('adds no x-stream-key header', () => {
    // The partition key is already the Kafka message key. A second copy in a
    // header could disagree with it, and the accepted ADR names only the
    // sequence header.
    expect(Object.values(EVENT_HEADERS)).not.toContain('x-stream-key');
  });

  it('leaves every pre-existing header untouched', () => {
    expect(EVENT_HEADERS).toMatchObject({
      eventId: 'x-event-id',
      eventName: 'x-event-name',
      eventVersion: 'x-event-version',
      correlationId: 'x-correlation-id',
      causationId: 'x-causation-id',
      tenantId: 'x-tenant-id',
      producer: 'x-producer',
      traceparent: 'traceparent',
    });
  });
});
