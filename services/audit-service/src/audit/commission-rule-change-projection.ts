import { z } from 'zod';
import {
  BUSINESS_LINES,
  DLQ_REASONS,
  auditChangesSchema,
  type AuditChange,
  type EventEnvelope,
} from '@rasta/contracts';
import { UnprocessableEventError, type EventDelivery } from '@rasta/nest-common';

/**
 * The before/after terms of a commission rule change, kept in the hashed audit
 * record (docs/23 D-057; Codex round 1 on #307, F5).
 *
 * economic-service records every commission rule change as
 * `COMMISSION_RULE_CHANGED` with the rule's terms before and after — the record
 * docs/10 § 10.7 and ADR-023 require of a rate decision. Path A otherwise keeps
 * the envelope only, so a rule's deactivation or end would reach the store as
 * "something changed" with nothing to say what. This projection is the one
 * exception: an allow-listed delta of the rule's terms in `changes`.
 *
 * ## Allow-list, validated, bounded
 *
 * The payload is parsed in full against economic's own contract — the pinned
 * copy below, by the version the envelope names — and a payload economic could
 * never have published is refused to the dead-letter topic rather than stored
 * in part. Only the {@link RULE_TERM_FIELDS} are read, and only those whose
 * value changed (every one, from null, on creation). Every value is a scalar a
 * steering-group decision consists of: who it binds, what it prices, the rate,
 * the floor and ceiling, the window, the status and the provenance label. The
 * result is checked against the platform's `changes` contract (ADR-053 § 5)
 * before it is returned.
 *
 * ## Why a copy, and how it is kept honest
 *
 * As `economic-reconciliation-contract.ts`: AGENTS.md A-02 forbids importing
 * economic's source, so the declarations between the markers are copied
 * verbatim, and `commission-rule-change-projection.spec.ts` reads both files as
 * text and fails if any of them differs by more than whitespace and comments.
 * Do not edit between the markers except by re-copying from economic.
 */

// --- BEGIN PINNED COPY of services/economic-service/src/events/events.ts ---

const amountMinor = z.string().regex(/^\d{1,30}$/);

const changeIsCoherent = (change: { change: 'CREATED' | 'UPDATED'; before: unknown }) =>
  (change.change === 'CREATED') === (change.before === null);

const CHANGE_KINDS = ['CREATED', 'UPDATED'] as const;

const commissionRuleTermsV1 = z.object({
  organizationId: z.string().nullable(),
  transactionType: z.string(),
  rateBasisPoints: z.number().int().min(0).max(10_000),
  minAmountMinor: amountMinor.nullable(),
  maxAmountMinor: amountMinor.nullable(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  status: z.string(),
  label: z.string().nullable(),
});

const commissionRuleTermsV2 = z.object({
  organizationId: z.string().nullable(),
  businessLine: z.enum(BUSINESS_LINES).nullable(),
  transactionType: z.string().nullable(),
  rateBasisPoints: z.number().int().min(0).max(10_000),
  minAmountMinor: amountMinor.nullable(),
  maxAmountMinor: amountMinor.nullable(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  status: z.string(),
  label: z.string().nullable(),
});

export const commissionRuleChangedPayloadV1 = z
  .object({
    ruleId: z.string(),
    change: z.enum(CHANGE_KINDS),
    changedBy: z.string(),
    changedAt: z.string(),
    before: commissionRuleTermsV1.nullable(),
    after: commissionRuleTermsV1,
  })
  .refine(changeIsCoherent, 'before is null exactly when the rule was created');

export const commissionRuleChangedPayloadV2 = z
  .object({
    ruleId: z.string(),
    change: z.enum(CHANGE_KINDS),
    changedBy: z.string(),
    changedAt: z.string(),
    before: commissionRuleTermsV2.nullable(),
    after: commissionRuleTermsV2,
  })
  .refine(changeIsCoherent, 'before is null exactly when the rule was created');

// --- END PINNED COPY ---

/** The topic economic publishes on. Delivery metadata, never the envelope. */
export const ECONOMIC_TOPIC = 'rasta.economic.v1';

export const COMMISSION_RULE_CHANGED = 'COMMISSION_RULE_CHANGED';

/** Each published version of the event, as economic declares it (docs/07 § 7.8). */
const BY_VERSION: Readonly<Record<number, z.ZodTypeAny>> = Object.freeze({
  1: commissionRuleChangedPayloadV1,
  2: commissionRuleChangedPayloadV2,
});

/**
 * The terms an auditor compares, in a fixed order. `businessLine` is absent
 * from v1, which had none; it is then simply not reported.
 */
export const RULE_TERM_FIELDS = [
  'organizationId',
  'businessLine',
  'transactionType',
  'rateBasisPoints',
  'minAmountMinor',
  'maxAmountMinor',
  'validFrom',
  'validTo',
  'status',
  'label',
] as const;

type Terms = Partial<Record<(typeof RULE_TERM_FIELDS)[number], string | number | null>>;

/**
 * The validated delta of a commission rule change, or `null` for any other
 * envelope — including this name arriving on another topic, which is not
 * economic's record of anything.
 *
 * Throws {@link UnprocessableEventError} for an unsupported version, a payload
 * that fails economic's contract, or one that describes another rule than the
 * envelope's aggregate.
 */
export function toCommissionRuleChanges(
  envelope: EventEnvelope,
  delivery: EventDelivery,
): AuditChange[] | null {
  if (delivery.topic !== ECONOMIC_TOPIC || envelope.eventName !== COMMISSION_RULE_CHANGED) {
    return null;
  }

  const version = envelope.eventVersion ?? 1;
  const schema = BY_VERSION[version];
  if (!schema) {
    throw new UnprocessableEventError(
      DLQ_REASONS.SCHEMA_VERSION_UNSUPPORTED,
      `${COMMISSION_RULE_CHANGED} v${String(version)} has no commission-rule projection; ` +
        `v${Object.keys(BY_VERSION).join(', v')} are understood`,
    );
  }

  const parsed = schema.safeParse(envelope.payload);
  if (!parsed.success) throw refuse(issuesOf(parsed.error));
  const change = parsed.data as {
    ruleId: string;
    before: Terms | null;
    after: Terms;
  };

  // The record is filed under the envelope's aggregate. A payload about
  // another rule would put one rule's terms under another's history.
  if (change.ruleId !== envelope.aggregateId) {
    throw refuse('ruleId is not the envelope aggregateId');
  }

  const changes: AuditChange[] = [];
  for (const field of RULE_TERM_FIELDS) {
    if (!(field in change.after)) continue;
    const to = change.after[field] ?? null;
    const from = change.before === null ? null : (change.before[field] ?? null);
    if (change.before !== null && from === to) continue;
    changes.push({ field, from, to });
  }

  // The platform's own bounds on `changes` (ADR-053 § 5): a value too long or
  // of the wrong kind is refused here, never truncated into the record.
  const bounded = auditChangesSchema.safeParse(changes);
  if (!bounded.success) throw refuse(issuesOf(bounded.error));
  return bounded.data;
}

/** Schema paths and zod issue codes only — never a value (S-09). */
function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}:${issue.code}`)
    .join(', ');
}

function refuse(why: string): UnprocessableEventError {
  return new UnprocessableEventError(
    DLQ_REASONS.VALIDATION_FAILED,
    `${COMMISSION_RULE_CHANGED} does not match the commission-rule projection (${why})`,
  );
}
