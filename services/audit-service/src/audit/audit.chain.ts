import { createHash } from 'node:crypto';
import { canonicaliseAuditRecord, type HashableAuditRecord } from './audit.canonical';

/**
 * The hash chain — ADR-053 § 6, layer 3.
 *
 * Layers 1 and 2 (PostgreSQL privileges and the append-only triggers) stop a
 * mutation from being *made*. This layer makes one that was made anyway
 * **visible**, and it is the only one of the three that survives an attacker
 * who already holds the rights the other two withhold.
 *
 * ## The claim, stated at its real size
 *
 * A hash chain is **tamper-evident, not tamper-proof** (`AGENTS.md` S-10).
 * There is no signature here and ADR-053 says why: signing needs key management
 * this platform does not have, and a key sitting in the same database as the
 * data it signs proves nothing. What the chain gives is that changing one row
 * requires recomputing every row after it in that tenant-month *and* the chain
 * head — which a database superuser can do, and which a reader comparing
 * against an off-box copy of the head can still detect. The runbook
 * `docs/runbooks/audit-chain-divergence.md` states the boundary in full.
 *
 * ## Scope: one chain per (organization, UTC month)
 *
 * A single global chain would serialise every insert in the platform behind one
 * row lock. What has to be provable is "no record of this tenant's month was
 * removed", and a per-tenant-month chain proves exactly that while leaving
 * different tenants and different months independently writable (ADR-053 § 6).
 *
 * The platform-scoped rows — `organization_id IS NULL`, a genuinely
 * platform-level action — form their own chain per month. They are never part
 * of a tenant's chain, for the same reason they are never part of a tenant's
 * query result.
 */

/** Which of the two chain families a record belongs to. */
export type AuditChainScope = 'ORGANIZATION' | 'PLATFORM';

/**
 * The stored key of one chain.
 *
 * `organizationKey` is the empty string for the platform chain and the
 * organization identifier otherwise. The empty string is safe as the platform
 * marker because it is **not a possible organization identifier**: both
 * `audit_event_organization_id_not_blank` and
 * `audit_chain_head_scope_shape` refuse a blank one in the database, and the
 * mapper trims before it writes. The `scope` discriminator is carried beside it
 * so the two families are distinguishable even if that ever stopped being true.
 */
export interface AuditChainKey {
  readonly scope: AuditChainScope;
  readonly organizationKey: string;
  /** First day of the record's UTC month, as `YYYY-MM-DD`. */
  readonly chainMonth: string;
}

/** The platform chain's stored organization key. Never a real identifier. */
export const PLATFORM_CHAIN_ORGANIZATION_KEY = '';

/**
 * The first day of a UTC month, as the `DATE` column spells it.
 *
 * Computed from UTC parts rather than from `toISOString().slice(0, 7)` so the
 * intent is legible, and never from local-time getters: a record that occurred
 * at 23:30 UTC on the last day of a month belongs to that month everywhere,
 * and a Tehran-local `getMonth()` would put it in the next one for readers in
 * one timezone and not for readers in another.
 */
export function utcMonthOf(occurredAt: Date): string {
  const year = occurredAt.getUTCFullYear();
  const month = occurredAt.getUTCMonth() + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
}

/** The `YYYY-MM` label a verification response reports a month under. */
export function monthLabel(chainMonth: string): string {
  return chainMonth.slice(0, 7);
}

/** Which chain a record belongs to, from its tenant and its instant. */
export function chainKeyOf(organizationId: string | null, occurredAt: Date): AuditChainKey {
  return organizationId === null
    ? {
        scope: 'PLATFORM',
        organizationKey: PLATFORM_CHAIN_ORGANIZATION_KEY,
        chainMonth: utcMonthOf(occurredAt),
      }
    : {
        scope: 'ORGANIZATION',
        organizationKey: organizationId,
        chainMonth: utcMonthOf(occurredAt),
      };
}

/** Every UTC month a `from`..`to` range touches, in ascending order. */
export function monthsBetween(from: Date, to: Date): string[] {
  if (to.getTime() < from.getTime()) return [];

  const months: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const last = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1);

  while (cursor.getTime() <= last) {
    months.push(utcMonthOf(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return months;
}

/** The half-open `[start, end)` instants of a `YYYY-MM-01` month. */
export function monthBounds(chainMonth: string): { start: Date; end: Date } {
  const start = new Date(`${chainMonth}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}

/** The digest length this chain uses. SHA-256, so thirty-two bytes. */
export const CHAIN_HASH_BYTES = 32;

/**
 * A digest that owns its own, non-shared, `ArrayBuffer`.
 *
 * Spelled out rather than written as a bare `Uint8Array`, which TypeScript
 * resolves to `Uint8Array<ArrayBufferLike>` — a type that also admits a view
 * over a `SharedArrayBuffer`, and which the Prisma client's `Bytes` input
 * therefore refuses. Every value of this type below is produced by a copy, so
 * the guarantee the name makes is one the code actually keeps: nothing here
 * hands the driver a view into Node's shared `Buffer` pool, where a later
 * allocation could rewrite the bytes of a digest already queued for insert.
 */
export type ChainHash = Uint8Array<ArrayBuffer>;

/** Raised when a chain input is not a thing this chain can be built from. */
export class ChainHashError extends Error {
  constructor(message: string) {
    super(`audit chain: ${message}`);
    this.name = 'ChainHashError';
  }
}

/**
 * `SHA256( canonical(record without hash fields) || previous hash )`, exactly
 * as ADR-053 § 6 writes it.
 *
 * ## The predecessor is appended raw, and nothing is appended for the first
 *
 * The ADR's formula is a concatenation of two byte strings. A previous hash is
 * always exactly {@link CHAIN_HASH_BYTES} bytes, and "no predecessor" appends
 * zero bytes — so the two cases are already unambiguous without a tag, a type
 * byte or a length prefix, and adding one would make this implementation
 * compute something the ADR does not describe. Two independent readers with the
 * ADR and a row must be able to reproduce the digest; every byte this function
 * adds beyond the formula is a byte they would have to guess.
 *
 * The ambiguity a tag would guard against does not exist here. `canonical(...)`
 * is self-delimiting — a fixed field count, a tag on every value and a length
 * prefix on every variable-length one — so the boundary between the record and
 * the appended hash is fixed by the record's own encoding, not by where the
 * appended bytes happen to start. A first record and a record whose predecessor
 * hashed to nothing are not two readings of one input, because a predecessor
 * hash of zero bytes is not a value this chain can hold: `previousHash` is
 * either absent or a full SHA-256 digest, and a short one is refused below and
 * by `audit_chain_head_hash_is_sha256` in the database.
 *
 * @throws ChainHashError if a predecessor is supplied at any other length.
 */
export function computeRecordHash(
  record: HashableAuditRecord,
  previousHash: Uint8Array | null,
): ChainHash {
  if (previousHash !== null && previousHash.length !== CHAIN_HASH_BYTES) {
    // Refused rather than padded, truncated or hashed as-is. A predecessor of
    // the wrong length is a corrupt head or a caller that has confused two
    // digests, and continuing would write a link nothing can ever reproduce —
    // a chain that is silently unverifiable from this record onward.
    throw new ChainHashError(
      `a predecessor hash is ${CHAIN_HASH_BYTES} bytes, not ${previousHash.length}`,
    );
  }

  const digest = createHash('sha256').update(canonicaliseAuditRecord(record));
  if (previousHash !== null) digest.update(previousHash);

  return toStorableHash(digest.digest());
}

/**
 * A digest copied out of whatever buffer produced it.
 *
 * Node's `createHash().digest()` and the PostgreSQL driver both return values
 * backed by a pooled or driver-owned `ArrayBufferLike`. Copying is what makes
 * the returned bytes both immutable in practice and assignable to the driver's
 * `Bytes` input — an assertion would satisfy the compiler while leaving the
 * shared backing store in place, which is the failure mode the type exists to
 * describe rather than a formality to work around.
 */
export function toStorableHash(value: Uint8Array): ChainHash {
  const copy = new Uint8Array(new ArrayBuffer(value.length));
  copy.set(value);
  return copy;
}

/** Constant-time-free equality; these are public digests, not secrets. */
export function hashesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  return Buffer.from(left.buffer, left.byteOffset, left.length).equals(
    Buffer.from(right.buffer, right.byteOffset, right.length),
  );
}
