import { createHash } from 'node:crypto';
import { canonicaliseAuditRecord, type HashableAuditRecord } from './audit.canonical';
import {
  CHAIN_HASH_BYTES,
  ChainHashError,
  chainKeyOf,
  computeRecordHash,
  hashesEqual,
  monthBounds,
  monthLabel,
  monthsBetween,
  PLATFORM_CHAIN_ORGANIZATION_KEY,
  toStorableHash,
  utcMonthOf,
} from './audit.chain';

/**
 * The chain, asserted against the formula ADR-053 § 6 actually writes.
 *
 * ## Why the vectors are computed here rather than imported
 *
 * `recordHash = SHA256( canonical(record without hashes) || previousHash )` is
 * a formula, not an implementation detail. The first-link and second-link
 * vectors below are built by concatenating those two byte strings by hand and
 * hashing the result — not by calling `computeRecordHash` and comparing it to
 * itself. That is the whole point: a test that re-derives the value through the
 * code under test proves the code agrees with itself, and moves along with it
 * when it is wrong. These assertions fail if the implementation ever appends
 * anything the ADR does not describe — a tag, a length prefix, a type byte, a
 * separator.
 *
 * ## And why "nothing for the first record" is a test rather than a comment
 *
 * A previous hash is always exactly thirty-two bytes and an absent one is zero
 * appended bytes. That is unambiguous only because the canonical encoding is
 * self-delimiting and because a short digest is refused rather than stored, so
 * both of those are asserted here too.
 */

const RECORD: HashableAuditRecord = {
  id: '01JAUDIT0000000000000001',
  occurredAt: new Date('2026-09-15T12:00:00.000Z'),
  recordedAt: new Date('2026-09-15T12:00:01.000Z'),
  actorType: 'USER',
  actorId: 'USR-1',
  actorRoles: ['UNION_ADMIN'],
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
  sequenceNo: 1n,
  correctionOf: null,
};

const SECOND: HashableAuditRecord = { ...RECORD, id: '01JAUDIT0000000000000002', sequenceNo: 2n };

const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');

/** The ADR's formula, spelled out independently of the implementation. */
function adrFormula(record: HashableAuditRecord, previousHash: Uint8Array | null): string {
  const canonical = canonicaliseAuditRecord(record);
  const input =
    previousHash === null ? canonical : Buffer.concat([canonical, Buffer.from(previousHash)]);
  return createHash('sha256').update(input).digest('hex');
}

describe('the audit hash chain', () => {
  describe('the ADR-053 § 6 formula', () => {
    it('hashes the first link over the canonical record alone', () => {
      // No predecessor means zero appended bytes — not a tag, not a null
      // marker, not a zero-length prefix. Anything else is an encoding this
      // ADR does not describe and a second reader could not reproduce.
      expect(hex(computeRecordHash(RECORD, null))).toBe(adrFormula(RECORD, null));
    });

    it('hashes a subsequent link over the canonical record and the raw predecessor', () => {
      const first = computeRecordHash(RECORD, null);
      expect(hex(computeRecordHash(SECOND, first))).toBe(adrFormula(SECOND, first));
    });

    it('pins the first-link vector, so the formula cannot change unnoticed', () => {
      // A recorded constant, not a re-derivation. The two tests above already
      // check the *formula* against an independent spelling of it; this one
      // freezes the value that formula produced for `RECORD` under
      // `CANONICAL_VERSION` 1, so a change anywhere beneath — a field order, a
      // tag, a prefix — fails here instead of quietly invalidating every hash
      // already written. If it fails, the change needs a new
      // `CANONICAL_VERSION`, not a new constant.
      expect(hex(computeRecordHash(RECORD, null))).toBe(
        '2ce37b2c397fd19a6147dcd033eeb95d87e6940cf872a0e36297dac5790b9ca0',
      );
    });

    it('pins the second-link vector', () => {
      const first = computeRecordHash(RECORD, null);
      expect(hex(computeRecordHash(SECOND, first))).toBe(
        '90084bd5ae7e3457a033629f89c7cc8bf8aa65769e397d6172563a1f74e037f9',
      );
    });

    it('appends the predecessor raw, with no framing of any kind', () => {
      // Stated as a direct byte-level equality against `sha256(canonical ||
      // previous)`. A tagged or length-prefixed append would still be a
      // deterministic chain and every other test here would pass; only this
      // one distinguishes it from the documented one.
      const previous = new Uint8Array(32).fill(0xab);
      const expected = createHash('sha256')
        .update(canonicaliseAuditRecord(SECOND))
        .update(Buffer.from(previous))
        .digest('hex');

      expect(hex(computeRecordHash(SECOND, previous))).toBe(expected);
    });

    it('gives a first record and a second record different links', () => {
      const first = computeRecordHash(RECORD, null);
      expect(hex(computeRecordHash(RECORD, first))).not.toBe(hex(first));
    });

    it('changes when any covered field of the record changes', () => {
      const first = computeRecordHash(RECORD, null);
      const altered = computeRecordHash({ ...RECORD, action: 'asset.recommissioned' }, null);
      expect(hex(altered)).not.toBe(hex(first));
    });

    it('changes when the predecessor changes', () => {
      const a = computeRecordHash(SECOND, new Uint8Array(32).fill(0x01));
      const b = computeRecordHash(SECOND, new Uint8Array(32).fill(0x02));
      expect(hex(a)).not.toBe(hex(b));
    });
  });

  describe('a predecessor is thirty-two bytes or it is nothing', () => {
    it('states the digest length it expects', () => {
      expect(CHAIN_HASH_BYTES).toBe(32);
      expect(computeRecordHash(RECORD, null)).toHaveLength(CHAIN_HASH_BYTES);
    });

    it('refuses a short predecessor rather than padding or hashing it', () => {
      // Refused, because a link computed from a malformed predecessor is a
      // link nothing can ever reproduce: the chain would be silently
      // unverifiable from that record onward and the row would still commit.
      expect(() => computeRecordHash(SECOND, new Uint8Array(31))).toThrow(ChainHashError);
    });

    it('refuses a long predecessor', () => {
      expect(() => computeRecordHash(SECOND, new Uint8Array(33))).toThrow(ChainHashError);
    });

    it('refuses an empty predecessor, which is not the same as no predecessor', () => {
      expect(() => computeRecordHash(SECOND, new Uint8Array(0))).toThrow(ChainHashError);
    });

    it('names the length it got, without echoing the bytes', () => {
      // A digest is not a secret, but an error message is a place values leak
      // from (`AGENTS.md` S-09), and a length is all a caller needs.
      expect(() => computeRecordHash(SECOND, new Uint8Array(7))).toThrow(/32 bytes, not 7/);
    });
  });

  describe('hashes are copied out of the buffers that produced them', () => {
    it('returns a view over a buffer of exactly the digest length', () => {
      const digest = computeRecordHash(RECORD, null);
      expect(digest.byteOffset).toBe(0);
      expect(digest.buffer.byteLength).toBe(CHAIN_HASH_BYTES);
    });

    it('copies rather than aliasing the source', () => {
      // The failure this prevents: Node's `Buffer` is backed by a shared pool,
      // and a view into it can be rewritten by a later allocation after the
      // digest has been queued for insert.
      const source = new Uint8Array(32).fill(0x11);
      const copy = toStorableHash(source);

      source.fill(0x22);

      expect(hex(copy)).toBe('11'.repeat(32));
      expect(copy.buffer).not.toBe(source.buffer);
    });

    it('copies a view that shares a larger backing buffer', () => {
      const pool = new Uint8Array(64).fill(0x33);
      const view = pool.subarray(16, 48);
      const copy = toStorableHash(view);

      pool.fill(0x44);

      expect(hex(copy)).toBe('33'.repeat(32));
      expect(copy.buffer.byteLength).toBe(32);
    });
  });

  describe('hash equality', () => {
    it('compares by value, not by identity', () => {
      expect(hashesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
      expect(hashesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    });

    it('treats two nulls as equal and a null against a value as unequal', () => {
      expect(hashesEqual(null, null)).toBe(true);
      expect(hashesEqual(null, new Uint8Array(32))).toBe(false);
      expect(hashesEqual(new Uint8Array(32), null)).toBe(false);
    });

    it('treats different lengths as unequal without reading past either', () => {
      expect(hashesEqual(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
    });

    it('compares a view into a larger buffer by its own bytes only', () => {
      // The realistic shape: a digest read back from the driver is often a
      // view into a shared read buffer. Comparing the whole backing store
      // would report two identical digests as different.
      const pool = new Uint8Array(64).fill(0x00);
      pool.set(new Uint8Array(32).fill(0x55), 16);

      expect(hashesEqual(pool.subarray(16, 48), new Uint8Array(32).fill(0x55))).toBe(true);
    });
  });

  describe('which chain a record belongs to', () => {
    it('keys a tenant record by its organization and its UTC month', () => {
      expect(chainKeyOf('ORG-1', new Date('2026-09-15T12:00:00.000Z'))).toEqual({
        scope: 'ORGANIZATION',
        organizationKey: 'ORG-1',
        chainMonth: '2026-09-01',
      });
    });

    it('keys a record with no tenant onto the platform chain', () => {
      // The platform chain is a separate family, never a tenant's, for the
      // same reason a null-tenant row never appears in a tenant's results.
      expect(chainKeyOf(null, new Date('2026-09-15T12:00:00.000Z'))).toEqual({
        scope: 'PLATFORM',
        organizationKey: PLATFORM_CHAIN_ORGANIZATION_KEY,
        chainMonth: '2026-09-01',
      });
    });

    it('uses the empty string as the platform key, which no tenant can hold', () => {
      expect(PLATFORM_CHAIN_ORGANIZATION_KEY).toBe('');
    });

    it('never puts a tenant and the platform in the same chain', () => {
      const tenant = chainKeyOf('ORG-1', new Date('2026-09-15T12:00:00.000Z'));
      const platform = chainKeyOf(null, new Date('2026-09-15T12:00:00.000Z'));
      expect(tenant).not.toEqual(platform);
      expect(tenant.scope).not.toBe(platform.scope);
    });

    it('puts two tenants in different chains for the same month', () => {
      const a = chainKeyOf('ORG-1', new Date('2026-09-15T12:00:00.000Z'));
      const b = chainKeyOf('ORG-2', new Date('2026-09-15T12:00:00.000Z'));
      expect(a.organizationKey).not.toBe(b.organizationKey);
    });

    it('puts one tenant in different chains for different months', () => {
      const august = chainKeyOf('ORG-1', new Date('2026-08-31T23:59:59.999Z'));
      const september = chainKeyOf('ORG-1', new Date('2026-09-01T00:00:00.000Z'));
      expect(august.chainMonth).toBe('2026-08-01');
      expect(september.chainMonth).toBe('2026-09-01');
    });
  });

  describe('UTC months', () => {
    it('reads the month from UTC parts and never from local time', () => {
      // A record at 23:30 UTC on the last day of a month belongs to that month
      // everywhere. A Tehran-local `getMonth()` would put it in the next one
      // for readers in one timezone and not for readers in another, and the
      // chain would fork on the reader's clock.
      expect(utcMonthOf(new Date('2026-08-31T23:30:00.000Z'))).toBe('2026-08-01');
      expect(utcMonthOf(new Date('2026-09-01T00:00:00.000Z'))).toBe('2026-09-01');
    });

    it('rolls over at exactly midnight UTC on the first', () => {
      expect(utcMonthOf(new Date('2026-08-31T23:59:59.999Z'))).toBe('2026-08-01');
      expect(utcMonthOf(new Date('2026-09-01T00:00:00.000Z'))).toBe('2026-09-01');
    });

    it('pads single-digit months', () => {
      expect(utcMonthOf(new Date('2026-01-05T00:00:00.000Z'))).toBe('2026-01-01');
    });

    it('handles a December-to-January rollover', () => {
      expect(utcMonthOf(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12-01');
      expect(utcMonthOf(new Date('2027-01-01T00:00:00.000Z'))).toBe('2027-01-01');
    });

    it('labels a month as YYYY-MM', () => {
      expect(monthLabel('2026-09-01')).toBe('2026-09');
    });
  });

  describe('the months a window touches', () => {
    it('lists one month for a window inside one month', () => {
      expect(
        monthsBetween(new Date('2026-09-02T00:00:00Z'), new Date('2026-09-20T00:00:00Z')),
      ).toEqual(['2026-09-01']);
    });

    it('lists every month a window spans, in ascending order', () => {
      expect(
        monthsBetween(new Date('2026-08-20T00:00:00Z'), new Date('2026-10-03T00:00:00Z')),
      ).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
    });

    it('crosses a year boundary', () => {
      expect(
        monthsBetween(new Date('2026-12-20T00:00:00Z'), new Date('2027-01-03T00:00:00Z')),
      ).toEqual(['2026-12-01', '2027-01-01']);
    });

    it('includes the month a window ends in even at its first instant', () => {
      expect(
        monthsBetween(new Date('2026-08-20T00:00:00Z'), new Date('2026-09-01T00:00:00.000Z')),
      ).toEqual(['2026-08-01', '2026-09-01']);
    });

    it('returns nothing when the window is inverted', () => {
      // Defensive rather than reachable: the query schema refuses `to` before
      // `from`. An empty list is the safe answer if it ever were reachable —
      // no chain read at all, rather than an unbounded loop.
      expect(
        monthsBetween(new Date('2026-09-20T00:00:00Z'), new Date('2026-08-20T00:00:00Z')),
      ).toEqual([]);
    });

    it('returns one month for a zero-width window', () => {
      const instant = new Date('2026-09-20T00:00:00Z');
      expect(monthsBetween(instant, instant)).toEqual(['2026-09-01']);
    });

    it('does not mutate the dates it is given', () => {
      const from = new Date('2026-08-20T00:00:00Z');
      const to = new Date('2026-10-03T00:00:00Z');
      monthsBetween(from, to);
      expect(from.toISOString()).toBe('2026-08-20T00:00:00.000Z');
      expect(to.toISOString()).toBe('2026-10-03T00:00:00.000Z');
    });
  });

  describe('month bounds', () => {
    it('is half-open, so no instant belongs to two months', () => {
      const september = monthBounds('2026-09-01');
      expect(september.start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
      expect(september.end.toISOString()).toBe('2026-10-01T00:00:00.000Z');

      const october = monthBounds('2026-10-01');
      expect(october.start.toISOString()).toBe(september.end.toISOString());
    });

    it('crosses a year boundary', () => {
      expect(monthBounds('2026-12-01').end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    });

    it('handles February in a non-leap year', () => {
      expect(monthBounds('2026-02-01').end.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    });

    it('handles February in a leap year', () => {
      expect(monthBounds('2028-02-01').end.toISOString()).toBe('2028-03-01T00:00:00.000Z');
    });
  });
});
