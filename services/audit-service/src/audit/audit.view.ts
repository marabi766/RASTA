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
 *   recordHash, previousHash   AUD-003. The columns exist and are never
 *                              written. Publishing two permanently null fields would tell
 *                              a client that integrity verification exists here
 *                              and returned "nothing wrong".
 *   correctionOf               AUD-007. Same reasoning: a null correction link
 *                              reads as "not corrected", which is a claim this
 *                              phase cannot make.
 *   changes                    Published, and always null in path A. Unlike the
 *                              two above, its absence is *itself* the documented
 *                              contract (ADR-053 § 2.1: a projector row stores
 *                              no payload value), so a client that sees null
 *                              learns the true thing.
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
  };
}
