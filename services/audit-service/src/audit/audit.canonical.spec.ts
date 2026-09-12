import { createHash } from 'node:crypto';
import {
  CANONICAL_FIELDS,
  CANONICAL_VERSION,
  CanonicalisationError,
  canonicaliseAuditRecord,
  encodeBigInt,
  encodeBoolean,
  encodeBytes,
  encodeInstant,
  encodeInteger,
  encodeJson,
  encodeNull,
  encodeNullableBigInt,
  encodeNullableText,
  encodeText,
  encodeTextList,
  type HashableAuditRecord,
} from './audit.canonical';

/**
 * The canonical encoding, asserted as a *format* rather than as a function.
 *
 * Everything here is really one property: two honest readers, on two machines,
 * years apart, must derive the same bytes from the same row — and must never
 * derive the same bytes from two different rows. Each test below is one way
 * that property has been broken in real systems:
 *
 *   **Key order is not information.** A `SELECT` that lists columns in another
 *   order builds an object with another insertion order, and a `JSON.stringify`
 *   encoding would invalidate every hash in the store with no data changed.
 *
 *   **Absence and emptiness are different facts.** A null actor and an actor
 *   whose identifier is the empty string are not the same record, and an
 *   encoding that spells both as nothing lets one be swapped for the other.
 *
 *   **Field boundaries cannot be moved.** Without a length prefix an attacker
 *   who controls two adjacent fields can shift the boundary between them and
 *   leave the digest unchanged, which is a forgery with no tampering.
 *
 * The vectors are asserted as hex rather than against a re-implementation.
 * Testing an encoder against a second copy of itself proves the two agree, not
 * that either is right, and it moves with the code when the code is wrong.
 */

const BASE: HashableAuditRecord = {
  id: '01JAUDIT0000000000000001',
  occurredAt: new Date('2026-09-15T12:00:00.000Z'),
  recordedAt: new Date('2026-09-15T12:00:01.500Z'),
  actorType: 'USER',
  actorId: 'USR-1',
  actorRoles: ['UNION_ADMIN', 'SYSTEM_ADMIN'],
  organizationId: 'ORG-1',
  action: 'asset.decommissioned',
  resourceType: 'Asset',
  resourceId: 'AST-1',
  outcome: 'SUCCESS',
  errorCode: null,
  reason: null,
  changes: null,
  occurrenceCount: 1,
  sourceService: 'asset-service',
  sourceServiceVersion: '1.0.0',
  sourceEventId: '01JEVENT0000000000000001',
  sourceEventName: 'ASSET_DECOMMISSIONED',
  sourceTopic: 'rasta.asset.v1',
  sourceIp: null,
  sourceUserAgent: null,
  correlationId: 'corr-1',
  causationId: null,
  traceparent: null,
  sourceStreamSeq: null,
  sequenceNo: 42n,
  correctionOf: null,
};

const hex = (buffer: Buffer): string => buffer.toString('hex');

describe('the canonical audit record encoding', () => {
  describe('determinism', () => {
    it('is stable when the object is built with its keys in another order', () => {
      // The failure this prevents: a repository whose `select` clause is
      // reordered produces objects with a different insertion order. Under
      // `JSON.stringify` every hash in the store would stop matching, with no
      // row having changed and nothing to point at.
      const reversed = Object.fromEntries(
        Object.entries(BASE).reverse(),
      ) as unknown as HashableAuditRecord;

      expect(Object.keys(reversed)).not.toEqual(Object.keys(BASE));
      expect(hex(canonicaliseAuditRecord(reversed))).toBe(hex(canonicaliseAuditRecord(BASE)));
    });

    it('produces identical bytes on repeated calls', () => {
      expect(hex(canonicaliseAuditRecord(BASE))).toBe(hex(canonicaliseAuditRecord(BASE)));
    });

    it('starts with the versioned domain-separation prefix and the field count', () => {
      const bytes = canonicaliseAuditRecord(BASE);
      const prefix = Buffer.from(`rasta.audit.canonical.v${CANONICAL_VERSION}\n`, 'utf8');

      expect(bytes.subarray(0, prefix.length)).toEqual(prefix);
      // The field count is hashed so that appending a field can never produce
      // the same bytes as a shorter record whose last value decoded the same.
      expect(bytes.readUInt32BE(prefix.length)).toBe(CANONICAL_FIELDS.length);
    });

    it('fixes the field order, so a reordering is a visible change', () => {
      // Pinned as a list rather than as a count. Swapping two fields of the
      // same type would leave the length identical and every other test here
      // passing, while silently changing the meaning of every stored digest.
      expect(CANONICAL_FIELDS.map((field) => field.name)).toEqual([
        'id',
        'occurredAt',
        'recordedAt',
        'actorType',
        'actorId',
        'actorRoles',
        'organizationId',
        'action',
        'resourceType',
        'resourceId',
        'outcome',
        'errorCode',
        'reason',
        'changes',
        'occurrenceCount',
        'sourceService',
        'sourceServiceVersion',
        'sourceEventId',
        'sourceEventName',
        'sourceTopic',
        'sourceIp',
        'sourceUserAgent',
        'correlationId',
        'causationId',
        'traceparent',
        'sourceStreamSeq',
        'sequenceNo',
        'correctionOf',
      ]);
    });

    it('pins the encoding version, which can only ever be replaced', () => {
      // Changing the encoding must change this number in the same commit: the
      // version is part of the hashed prefix precisely so a new rule produces
      // different bytes by construction rather than a silent field of
      // mismatches.
      expect(CANONICAL_VERSION).toBe(1);
    });
  });

  describe('every canonical field affects the bytes', () => {
    // The test that makes the field list a contract instead of a comment. A
    // field left out of `CANONICAL_FIELDS` is a value an attacker can change
    // without the chain noticing, and it is invisible in review because the
    // record still hashes and still verifies.
    const MUTATIONS: { [K in keyof HashableAuditRecord]: HashableAuditRecord[K] } = {
      id: '01JAUDIT0000000000000002',
      occurredAt: new Date('2026-09-15T12:00:00.001Z'),
      recordedAt: new Date('2026-09-15T12:00:02.500Z'),
      actorType: 'SERVICE',
      actorId: 'USR-2',
      actorRoles: ['SYSTEM_ADMIN', 'UNION_ADMIN'],
      organizationId: 'ORG-2',
      action: 'asset.recommissioned',
      resourceType: 'Driver',
      resourceId: 'AST-2',
      outcome: 'FAILURE',
      errorCode: 'FORBIDDEN',
      reason: 'because',
      changes: { a: 1 },
      occurrenceCount: 2,
      sourceService: 'fleet-service',
      sourceServiceVersion: '1.0.1',
      sourceEventId: '01JEVENT0000000000000002',
      sourceEventName: 'ASSET_RECOMMISSIONED',
      sourceTopic: 'rasta.fleet.v1',
      sourceIp: '10.0.0.1',
      sourceUserAgent: 'curl/8',
      correlationId: 'corr-2',
      causationId: 'cause-2',
      traceparent: '00-abc-def-01',
      sourceStreamSeq: 7n,
      sequenceNo: 43n,
      correctionOf: '01JAUDIT0000000000000003',
    };

    const baseline = hex(canonicaliseAuditRecord(BASE));

    for (const field of CANONICAL_FIELDS) {
      it(`changes when \`${field.name}\` changes`, () => {
        const mutated: HashableAuditRecord = { ...BASE, [field.name]: MUTATIONS[field.name] };
        expect(hex(canonicaliseAuditRecord(mutated))).not.toBe(baseline);
      });
    }

    it('covers every field of the record type, so a new column cannot be forgotten', () => {
      expect(Object.keys(MUTATIONS).sort()).toEqual(
        CANONICAL_FIELDS.map((field) => field.name)
          .slice()
          .sort(),
      );
    });
  });

  describe('null is not empty, and empty is not absent', () => {
    it('spells null as one tag byte and never as nothing', () => {
      expect(hex(encodeNull())).toBe('00');
    });

    it('distinguishes a null string from an empty one', () => {
      expect(hex(encodeNullableText(null))).toBe('00');
      expect(hex(encodeText(''))).toBe('0100000000');
      expect(hex(encodeNullableText(null))).not.toBe(hex(encodeText('')));
    });

    it('distinguishes a null bigint from zero', () => {
      expect(hex(encodeNullableBigInt(null))).not.toBe(hex(encodeBigInt(0n)));
    });

    it('distinguishes an empty list from a null value and from an empty string', () => {
      expect(hex(encodeTextList([]))).toBe('0600000000');
      expect(hex(encodeTextList([]))).not.toBe(hex(encodeNull()));
      expect(hex(encodeTextList([]))).not.toBe(hex(encodeText('')));
    });

    it('distinguishes a record with a null actor from one with an empty actor id', () => {
      const nulled = hex(canonicaliseAuditRecord({ ...BASE, actorId: null }));
      const empty = hex(canonicaliseAuditRecord({ ...BASE, actorId: '' }));
      expect(nulled).not.toBe(empty);
    });
  });

  describe('length prefixes, so a field boundary cannot be moved', () => {
    it('refuses to let two adjacent fields be re-split without changing the bytes', () => {
      // Without a length prefix, `action = 'a'` + `resourceType = 'bc'` and
      // `action = 'ab'` + `resourceType = 'c'` would concatenate to the same
      // bytes, and an attacker who controls both fields could rewrite a record
      // and keep its digest.
      const left = canonicaliseAuditRecord({ ...BASE, action: 'a', resourceType: 'bc' });
      const right = canonicaliseAuditRecord({ ...BASE, action: 'ab', resourceType: 'c' });

      expect(hex(left)).not.toBe(hex(right));
    });

    it('writes the byte length, not the character length, for multi-byte text', () => {
      // 'دارایی' is six characters and twelve UTF-8 bytes. A character count
      // here would desynchronise every reader that decodes by bytes.
      const encoded = encodeText('دارایی');
      expect(encoded.readUInt32BE(1)).toBe(Buffer.byteLength('دارایی', 'utf8'));
      expect(encoded.readUInt32BE(1)).toBe(12);
    });
  });

  describe('scalars have exactly one spelling', () => {
    it('encodes a bigint as its canonical decimal form', () => {
      expect(encodeBigInt(42n).subarray(5).toString('utf8')).toBe('42');
      expect(encodeBigInt(-0n).subarray(5).toString('utf8')).toBe('0');
      expect(hex(encodeBigInt(0n))).toBe(hex(encodeBigInt(-0n)));
    });

    it('encodes negative zero and zero identically as integers', () => {
      expect(hex(encodeInteger(-0))).toBe(hex(encodeInteger(0)));
    });

    it('refuses an unsafe integer rather than rounding it', () => {
      expect(() => encodeInteger(Number.MAX_SAFE_INTEGER + 1)).toThrow(CanonicalisationError);
      expect(() => encodeInteger(1.5)).toThrow(CanonicalisationError);
    });

    it('encodes booleans as a tag and one byte', () => {
      expect(hex(encodeBoolean(true))).toBe('0401');
      expect(hex(encodeBoolean(false))).toBe('0400');
    });

    it('encodes an instant as epoch milliseconds, not as a formatted string', () => {
      // A formatting function is the wrong dependency for evidence: epoch
      // milliseconds have one spelling, no timezone and no padding rule.
      const encoded = encodeInstant(new Date('2026-09-15T12:00:00.000Z'));
      expect(encoded.subarray(5).toString('utf8')).toBe(
        String(Date.parse('2026-09-15T12:00:00.000Z')),
      );
    });

    it('encodes two instants of the same millisecond identically, whatever their construction', () => {
      const fromIso = encodeInstant(new Date('2026-09-15T12:00:00.000Z'));
      const fromEpoch = encodeInstant(new Date(Date.parse('2026-09-15T12:00:00.000Z')));
      expect(hex(fromIso)).toBe(hex(fromEpoch));
    });

    it('refuses an invalid date rather than encoding NaN', () => {
      expect(() => encodeInstant(new Date('not a date'))).toThrow(CanonicalisationError);
    });

    it('encodes bytes length-prefixed', () => {
      expect(hex(encodeBytes(Uint8Array.from([0xde, 0xad])))).toBe('0800000002dead');
    });
  });

  describe('lists preserve order, because order is information', () => {
    it('does not sort a role list', () => {
      // Sorting would make two genuinely different records hash identically. A
      // canonical form removes ambiguity; it must never remove information.
      const forward = encodeTextList(['A', 'B']);
      const backward = encodeTextList(['B', 'A']);
      expect(hex(forward)).not.toBe(hex(backward));
    });

    it('distinguishes one two-character role from two one-character roles', () => {
      expect(hex(encodeTextList(['AB']))).not.toBe(hex(encodeTextList(['A', 'B'])));
    });
  });

  describe('json documents', () => {
    it('sorts object keys, so insertion order does not reach the digest', () => {
      expect(hex(encodeJson({ a: 1, b: 2 }))).toBe(hex(encodeJson({ b: 2, a: 1 })));
    });

    it('sorts keys by UTF-8 bytes, not by UTF-16 code units', () => {
      // The two orders disagree above the basic multilingual plane: '\u{1D400}'
      // sorts before 'Ａ' by UTF-8 bytes and after it by UTF-16 code
      // units. This store is Persian-facing and `changes` may carry any key,
      // so this is the difference between a chain that verifies and one that
      // does not.
      const astral = '\u{1D400}';
      const wide = 'Ａ';

      // JavaScript's default sort compares UTF-16 code units and puts the
      // astral character first, because its leading surrogate is 0xD835.
      expect([astral, wide].sort()).toEqual([astral, wide]);
      // UTF-8 disagrees: 0xEF... precedes 0xF0..., so the wide character comes
      // first. The encoder must follow the bytes.
      expect(Buffer.compare(Buffer.from(wide, 'utf8'), Buffer.from(astral, 'utf8'))).toBe(-1);

      const encoded = encodeJson({ [astral]: 1, [wide]: 2 });
      // map tag (1) + entry count (4) + text tag (1) + text length (4).
      const KEY_OFFSET = 10;
      const firstKeyLength = encoded.readUInt32BE(KEY_OFFSET - 4);
      expect(encoded.subarray(KEY_OFFSET, KEY_OFFSET + firstKeyLength).toString('utf8')).toBe(wide);
    });

    it('nests arrays and objects structurally', () => {
      expect(hex(encodeJson({ a: [1, { b: null }] }))).toBe(
        hex(encodeJson({ a: [1, { b: null }] })),
      );
      expect(hex(encodeJson({ a: [1, 2] }))).not.toBe(hex(encodeJson({ a: [2, 1] })));
    });

    it('does not confuse an array with an object that has numeric keys', () => {
      expect(hex(encodeJson(['x']))).not.toBe(hex(encodeJson({ 0: 'x' })));
    });

    it('does not confuse a nested null with an absent key', () => {
      expect(hex(encodeJson({ a: null }))).not.toBe(hex(encodeJson({})));
    });

    it('refuses undefined rather than coercing it to null', () => {
      // Coercion would hash two different documents to the same value.
      expect(() => encodeJson({ a: undefined })).toThrow(CanonicalisationError);
    });

    it('refuses a value with no JSON spelling', () => {
      expect(() => encodeJson(Number.NaN)).toThrow(CanonicalisationError);
      expect(() => encodeJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalisationError);
      expect(() => encodeJson(() => undefined)).toThrow(CanonicalisationError);
      expect(() => encodeJson(Symbol('x'))).toThrow(CanonicalisationError);
    });

    it('refuses a document nested deeper than the encoder will walk', () => {
      // A depth bound rather than a stack overflow: `changes` arrives from a
      // producer, and an unbounded recursion over attacker-shaped input is a
      // denial of service in the middle of a write transaction.
      let deep: unknown = 'leaf';
      for (let i = 0; i < 40; i += 1) deep = { deep };

      expect(() => encodeJson(deep)).toThrow(CanonicalisationError);
    });

    it('encodes a moderately nested document without complaint', () => {
      let shallow: unknown = 'leaf';
      for (let i = 0; i < 10; i += 1) shallow = { shallow };

      expect(() => encodeJson(shallow)).not.toThrow();
    });

    it('encodes a non-integral number by its shortest round-trip decimal', () => {
      expect(encodeJson(1.5).subarray(5).toString('utf8')).toBe('1.5');
      expect(hex(encodeJson(-0))).toBe(hex(encodeJson(0)));
    });

    it('reaches a record through the `changes` field', () => {
      const left = canonicaliseAuditRecord({ ...BASE, changes: { a: 1, b: 2 } });
      const right = canonicaliseAuditRecord({ ...BASE, changes: { b: 2, a: 1 } });
      const other = canonicaliseAuditRecord({ ...BASE, changes: { a: 1, b: 3 } });

      expect(hex(left)).toBe(hex(right));
      expect(hex(left)).not.toBe(hex(other));
    });

    it('treats an absent `changes` as null', () => {
      const nulled = canonicaliseAuditRecord({ ...BASE, changes: null });
      const undefinedish = canonicaliseAuditRecord({ ...BASE, changes: undefined });
      expect(hex(nulled)).toBe(hex(undefinedish));
    });
  });

  describe('known vectors', () => {
    // Pinned bytes, so a change to the encoding cannot pass review as a
    // refactor. If one of these fails, every hash already written is affected
    // and the change needs a new `CANONICAL_VERSION`.
    it('encodes text exactly', () => {
      expect(hex(encodeText('ab'))).toBe('01000000026162');
    });

    it('encodes a bigint exactly', () => {
      expect(hex(encodeBigInt(42n))).toBe('0200000002' + Buffer.from('42').toString('hex'));
    });

    it('encodes the whole base record to a fixed digest', () => {
      // A digest of the canonical bytes rather than the bytes themselves: the
      // record is ~300 bytes and the point of the assertion is that it does
      // not move, not that a reader can decode it here.
      const digest = createHash('sha256').update(canonicaliseAuditRecord(BASE)).digest('hex');

      expect(digest).toBe('b45c4f111947395b9550694b98946c199de9ef18464865facef38b67e923bb0b');
    });
  });
});
