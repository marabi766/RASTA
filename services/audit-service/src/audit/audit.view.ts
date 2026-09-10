import { z } from 'zod';

/**
 * What a caller receives, and the columns deliberately withheld.
 *
 * ## Every `bigint` leaves as a string
 *
 * `sequenceNo` and `sourceStreamSeq` are 64-bit. `JSON.stringify` throws on a
 * native `bigint`, and the fix people reach for — a `toJSON` shim on
 * `BigInt.prototype` — emits a JSON *number*, which loses precision above 2^53
 * in every client that parses JSON the ordinary way. AGENTS.md § 3 settles it
 * for money and the same reasoning applies to any 64-bit integer that a client
 * may compare or echo back: it travels as a string.
 *
 * ## What is not published, and why that is not an oversight
 *
 *   recordHash, previousHash   Written since AUD-003, and still not published.
 *                              A digest is not the useful part of a chain — the
 *                              useful part is whether a *range* recomputes, and
 *                              that is what `GET /v1/audit-events/verify`
 *                              answers. Handing every reader a per-row hash
 *                              invites exactly the wrong check: comparing one
 *                              record's stored hash against itself proves
 *                              nothing, because a forger who rewrote the row
 *                              rewrote the hash beside it. What is published
 *                              instead is `integrity`, below.
 *   correctionOf               AUD-007, and still never written. ADR-053 § 7
 *                              routes a correction through path B, which is
 *                              AUD-004, so a null correction link would read as
 *                              "not corrected" — a claim this phase cannot make.
 *   changes                    Published, and always null in path A. Unlike the
 *                              two above, its absence is *itself* the documented
 *                              contract (ADR-053 § 2.1: a projector row stores
 *                              no payload value), so a client that sees null
 *                              learns the true thing.
 *
 * ## `integrity` says which of two true things this row is, and nothing more
 *
 *   CHAINED     the row carries a chain link, so it is *covered* by
 *               `GET /v1/audit-events/verify`. It does **not** say the row
 *               verified: nothing here recomputes a chain, and a field that
 *               implied it had would be the single most misleading value this
 *               service could publish.
 *   UNCHAINED   the row was written before AUD-003 and has no link. Nothing
 *               backfills it, so it stays honestly outside the chain forever
 *               and any range containing it is reported as unverifiable rather
 *               than as valid.
 */

export const auditEventViewSchema = z
  .object({
    id: z.string(),
    /** When it happened in the domain. The sort key, and the partition key. */
    occurredAt: z.string().datetime({ offset: true }),
    /** When this store wrote the row. The gap between the two is consumer lag. */
    recordedAt: z.string().datetime({ offset: true }),

    actorType: z.enum(['USER', 'SERVICE', 'SYSTEM', 'ANONYMOUS']),
    actorId: z.string().nullable(),
    /** Empty in path A: a domain envelope carries no roles (ADR-053 § 1). */
    actorRoles: z.array(z.string()),

    /** Null only for a genuinely platform-scoped action. */
    organizationId: z.string().nullable(),

    action: z.string(),
    resourceType: z.string(),
    resourceId: z.string().nullable(),

    outcome: z.enum(['SUCCESS', 'FAILURE', 'REFUSED']),
    errorCode: z.string().nullable(),
    reason: z.string().nullable(),

    /** Always null in path A. AUD-004 supplies a bounded, redacted delta. */
    changes: z.unknown().nullable(),

    occurrenceCount: z.number().int(),

    sourceService: z.string(),
    sourceServiceVersion: z.string().nullable(),
    sourceEventId: z.string(),
    sourceEventName: z.string(),
    sourceTopic: z.string(),

    sourceIp: z.string().nullable(),
    sourceUserAgent: z.string().nullable(),

    correlationId: z.string(),
    causationId: z.string().nullable(),
    traceparent: z.string().nullable(),

    /** 64-bit, so a string. Detection only; nothing orders on it. */
    sourceStreamSeq: z.string().nullable(),
    /** 64-bit, so a string. Monotonic **within one partition** only. */
    sequenceNo: z.string(),

    /**
     * Whether this record carries a hash-chain link — not whether it verified.
     *
     * `UNCHAINED` is a pre-AUD-003 row. See the header: the distinction is
     * published because a client that cannot tell the two apart would read
     * every old record as covered by an integrity guarantee that did not exist
     * when it was written.
     */
    integrity: z.enum(['CHAINED', 'UNCHAINED']),
  })
  .strict();

export type AuditEventView = z.infer<typeof auditEventViewSchema>;

export const auditEventPageSchema = z
  .object({
    items: z.array(auditEventViewSchema),
    /** Echo this back as `cursor` for the next page. Null when there is none. */
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();

export type AuditEventPage = z.infer<typeof auditEventPageSchema>;

/** The row shape this mapper reads — the repository's return type, narrowed. */
export interface AuditEventRow {
  id: string;
  occurredAt: Date;
  recordedAt: Date;
  actorType: string;
  actorId: string | null;
  actorRoles: string[];
  organizationId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: string;
  errorCode: string | null;
  reason: string | null;
  changes: unknown;
  occurrenceCount: number;
  sourceService: string;
  sourceServiceVersion: string | null;
  sourceEventId: string;
  sourceEventName: string;
  sourceTopic: string;
  sourceIp: string | null;
  sourceUserAgent: string | null;
  correlationId: string;
  causationId: string | null;
  traceparent: string | null;
  sourceStreamSeq: bigint | null;
  sequenceNo: bigint;
  /** Null on every row written before AUD-003; never backfilled. */
  recordHash: Uint8Array | null;
  previousHash: Uint8Array | null;
}

export function toAuditEventView(row: AuditEventRow): AuditEventView {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),

    actorType: row.actorType as AuditEventView['actorType'],
    actorId: row.actorId,
    actorRoles: row.actorRoles,

    organizationId: row.organizationId,

    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,

    outcome: row.outcome as AuditEventView['outcome'],
    errorCode: row.errorCode,
    reason: row.reason,

    // `undefined` would drop the key from the JSON body entirely, and a missing
    // key and an explicit null are different claims to a client.
    changes: row.changes ?? null,

    occurrenceCount: row.occurrenceCount,

    sourceService: row.sourceService,
    sourceServiceVersion: row.sourceServiceVersion,
    sourceEventId: row.sourceEventId,
    sourceEventName: row.sourceEventName,
    sourceTopic: row.sourceTopic,

    sourceIp: row.sourceIp,
    sourceUserAgent: row.sourceUserAgent,

    correlationId: row.correlationId,
    causationId: row.causationId,
    traceparent: row.traceparent,

    sourceStreamSeq: row.sourceStreamSeq === null ? null : row.sourceStreamSeq.toString(),
    sequenceNo: row.sequenceNo.toString(),

    // Derived from the presence of a link, never from a recomputation. See the
    // header: this field states which of two true things the row is.
    integrity: row.recordHash === null ? 'UNCHAINED' : 'CHAINED',
  };
}
