import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AUDIT_CHANGES_MAX_ENTRIES, auditChangeSchema, type AuditChange } from '@rasta/contracts';

/**
 * The audit correction command (ADR-053 § 7, AUD-003 correction): what a platform
 * administrator may send, validated at the boundary and nowhere looser.
 *
 * ## What the request may *not* say
 *
 * No organization, no actor, no source, no action, no outcome. Every one of
 * those is decided elsewhere and never taken from the body:
 *
 *   organization   copied from the trusted audit-service lookup of the target
 *   actor, roles   the verified token
 *   source         the request-context middleware, bounded
 *   action, etc.   fixed by ADR-053 § 7
 *
 * `.strict()` makes that structural rather than a promise: a body that tries to
 * name any of them is refused with `400`, not silently ignored.
 *
 * ## The declared changes reuse the v1 wire contract
 *
 * Each entry is `auditChangeSchema` from `@rasta/contracts` — the very schema
 * audit-service validates path B against — so a value the store would refuse is
 * refused here first. That already rejects an object, an array, a non-finite
 * number and a string over 2000 characters; nothing is truncated, and nothing
 * large is carried as itself (a client with a large value sends the `{ hash }`
 * marker ADR-053 § 5 documents). On top of the contract this adds only what a
 * *command* needs and a wire message does not: a dotted-identifier field whose
 * every segment is safe, no two entries for one field, and no entry that states
 * no change.
 */

/** The audit record id alphabet, as audit-service bounds it. */
const AUDIT_EVENT_ID_PATTERN = /^[0-9A-Za-z_-]+$/;

/** `a`, `a.b`, `credentials.password` — identifiers only, never a path expression. */
const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Checked per dotted segment: the contract checks only the whole field. */
const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** `audit_event.reason VARCHAR(1000)`; ADR-053 § 7 requires it non-empty. */
export const CORRECTION_REASON_MAX_LENGTH = 1000;

const correctionChangeSchema = auditChangeSchema.superRefine((change, ctx) => {
  if (!FIELD_PATTERN.test(change.field)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['field'],
      message: 'field must be a dotted identifier such as "outcome" or "profile.status"',
    });
    return;
  }
  if (change.field.split('.').some((segment) => UNSAFE_SEGMENTS.has(segment))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['field'],
      message: 'field must not contain a prototype-pollution-prone segment',
    });
  }
  // Two scalars that are equal declare no change, which is not a correction.
  const scalar = (value: AuditChange['from']): boolean =>
    value === null || typeof value !== 'object';
  if (scalar(change.from) && scalar(change.to) && change.from === change.to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'a change must differ from its original value',
    });
  }
});

export const auditCorrectionCommandSchema = z
  .object({
    /** The audit record being corrected — its own id, not a source event id. */
    auditEventId: z.string().trim().min(1).max(64).regex(AUDIT_EVENT_ID_PATTERN),
    /**
     * The target's own `occurredAt`, exactly as the audit read API published it.
     * Required because `audit_event` is partitioned on it: the lookup reads one
     * partition by primary key instead of every partition by id. Normalised to
     * one ISO form so `…Z` and `…+00:00` are the same request.
     */
    occurredAt: z
      .string()
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString()),
    reason: z.string().trim().min(1).max(CORRECTION_REASON_MAX_LENGTH),
    changes: z.array(correctionChangeSchema).min(1).max(AUDIT_CHANGES_MAX_ENTRIES),
  })
  .strict()
  .superRefine((command, ctx) => {
    const seen = new Set<string>();
    command.changes.forEach((change, index) => {
      if (seen.has(change.field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['changes', index, 'field'],
          message: 'each field may be corrected at most once per command',
        });
      }
      seen.add(change.field);
    });
  });

export type AuditCorrectionCommand = z.infer<typeof auditCorrectionCommandSchema>;

/**
 * SHA-256 of the normalised command — the idempotency fingerprint.
 *
 * Computed over the *validated* command (trimmed reason, normalised instant),
 * with object keys sorted recursively, so two clients serialising the same
 * request differently are recognised as a retry (`docs/06` § 6.8). Array order
 * is kept: the declared changes are an ordered list, and a reordered list is a
 * different declaration. Only the digest is ever stored.
 */
export function hashCorrectionCommand(command: AuditCorrectionCommand): string {
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(command)))
    .digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
    return sorted;
  }
  return value;
}
