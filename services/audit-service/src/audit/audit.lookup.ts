import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { RastaError, getContext } from '@rasta/nest-common';
import { AuditRepository } from './audit.repository';

/**
 * The one programmatic read this service allows: does a correction target
 * exist, and exactly which scope does it belong to (ADR-053 § 7, AUD-003 correction).
 *
 * ## Why this exists at all
 *
 * A correction is produced by `identity-service` and enters this store through
 * path B like every other write. The path-B consumer deliberately does not check
 * that `correctionOf` names a real record in the same tenant — a consumer that
 * refused a correction because its target had not *arrived yet* would dead-letter
 * a valid message on nothing but ordering. So the producer must prove the target
 * before it enqueues, and the producer may not read this service's database
 * (A-01/A-02). This endpoint is the narrow REST answer to exactly that one
 * question, and to nothing else.
 *
 * ## What it discloses, and to whom
 *
 * Three fields: the id, the organization (`null` for a genuinely platform-scoped
 * record) and the occurrence instant — the minimum a producer needs to prove the
 * target exists and to copy its tenant onto the correction. No actor, no action,
 * no reason, no delta: those are the evidence, and nobody reads the evidence
 * programmatically (ADR-053 § 10).
 *
 * Only `identity-service`'s own service token reaches it. `@AllowService` on the
 * route refuses every other service; {@link assertTargetLookupCaller} refuses
 * every *user* token too, which `@AllowService` alone would not — the auth
 * guard admits a verified user to any authenticated route. General audit reads
 * stay closed to service tokens (`access.ts`); this route is a separate door
 * with a separate lock, not a hole in that one.
 *
 * ## Exact match, and the partition key is mandatory
 *
 * `audit_event` is partitioned by `occurred_at` and its identity is
 * `(occurred_at, id)`. The caller must state the instant, and only a row whose
 * id **and** instant both match is found — a single-partition primary-key read.
 * A missing record and a mismatched instant answer the same `404`, so the
 * endpoint cannot be used to probe which ids exist at which times.
 */

/** The only caller this route answers. */
export const AUDIT_TARGET_LOOKUP_CALLER = 'identity-service';

export const auditTargetLookupQuerySchema = z
  .object({
    /** The target's own `occurredAt`, exactly as the read API published it. */
    occurredAt: z
      .string()
      .datetime({ offset: true })
      .transform((value) => new Date(value)),
  })
  .strict();

export type AuditTargetLookupQuery = z.infer<typeof auditTargetLookupQuerySchema>;

export const auditTargetViewSchema = z
  .object({
    id: z.string(),
    /** Null only for a genuinely platform-scoped record. */
    organizationId: z.string().nullable(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type AuditTargetView = z.infer<typeof auditTargetViewSchema>;

/**
 * Refuses everything but `identity-service`'s own service token.
 *
 * The second layer behind `@AllowService`, and the only layer against a user
 * token, which that decorator does not constrain.
 */
export function assertTargetLookupCaller(): void {
  const context = getContext();
  if (context.authType !== 'SERVICE' || context.callerService !== AUDIT_TARGET_LOOKUP_CALLER) {
    throw RastaError.forbidden('This endpoint is reserved for the audit correction producer');
  }
}

@Injectable()
export class AuditTargetLookupService {
  constructor(private readonly repository: AuditRepository) {}

  async lookup(id: string, occurredAt: Date): Promise<AuditTargetView> {
    assertTargetLookupCaller();

    const row = await this.repository.findTarget(id, occurredAt);

    // Re-checked, not assumed from the query: the answer is a proof the producer
    // relies on, so a row that is not exactly the named one is no row at all.
    if (!row || row.id !== id || row.occurredAt.getTime() !== occurredAt.getTime()) {
      // No identifier in the message; `internalContext` keeps it for the log.
      throw RastaError.notFound('AuditEvent', id);
    }

    return {
      id: row.id,
      organizationId: row.organizationId,
      occurredAt: row.occurredAt.toISOString(),
    };
  }
}
