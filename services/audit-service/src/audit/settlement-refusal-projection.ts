import { z } from 'zod';
import {
  BUSINESS_LINES,
  DLQ_REASONS,
  auditChangesSchema,
  type AuditChange,
  type EventEnvelope,
} from '@rasta/contracts';
import { UnprocessableEventError, type EventDelivery } from '@rasta/nest-common';
import { ECONOMIC_TOPIC } from './commission-rule-change-projection';

/**
 * The allow-listed projection of economic-service's `SETTLEMENT_REFUSED` onto
 * the audit row (docs/24 Q-29; review of #364 round 1, F3).
 *
 * A settlement refused because no active commission rule covers the
 * transaction's business line is *published* — the event is the durable record
 * of the refusal — so the path-A default of "an event on a topic is a success
 * under its own name" is wrong for it: `outcome=REFUSED` searches missed every
 * one, and nothing said which line needed a rule. It is stored as `REFUSED`
 * under its own name, with the closed reason in `reason` and the two facts an
 * operator configures from — the business line and the transaction type — in
 * `changes`. A refusal changes nothing, so each is reported unchanged
 * (`from` = `to`): what the transaction was, and still is.
 *
 * ## Allow-list, validated, bounded
 *
 * The payload is parsed in full against economic's own contract — the pinned
 * copy below — and one economic could never have published is refused to the
 * dead-letter topic rather than stored in part. Only `reason`, `businessLine`
 * and `transactionType` are read, each from a closed list; no amount travels
 * with the event, and the payer, payee and actor are already the row's
 * organization, resource and actor, or are not audit-row material. The
 * `changes` are checked against the platform's contract (ADR-053 § 5) before
 * they are returned.
 *
 * ## Why a copy, and how it is kept honest
 *
 * As `commission-rule-change-projection.ts`: AGENTS.md A-02 forbids importing
 * economic's source, so the declarations between the markers are copied
 * verbatim, and `settlement-refusal-projection.spec.ts` reads both files as
 * text and fails if any of them differs by more than whitespace and comments.
 * Do not edit between the markers except by re-copying from economic.
 */

// --- BEGIN PINNED COPY of services/economic-service/src/events/events.ts ---

export const SETTLEMENT_REFUSAL_REASONS = ['NO_ACTIVE_RULE'] as const;

export const SETTLEMENT_REFUSAL_TRANSACTION_TYPES = [
  'MARKETPLACE_ORDER',
  'MAINTENANCE_SERVICE',
  'LOGISTICS',
  'CONSTRUCTION_STATEMENT',
  'PROCUREMENT_ORDER',
] as const;

export const settlementRefusedPayload = z
  .object({
    transactionId: z.string(),
    organizationId: z.string(),
    payerOrganizationId: z.string(),
    payeeOrganizationId: z.string(),
    transactionType: z.enum(SETTLEMENT_REFUSAL_TRANSACTION_TYPES),
    businessLine: z.enum(BUSINESS_LINES),
    reason: z.enum(SETTLEMENT_REFUSAL_REASONS),
    refusedBy: z.string(),
    refusedAt: z.string(),
  })
  .strict();

// --- END PINNED COPY ---

export const SETTLEMENT_REFUSED = 'SETTLEMENT_REFUSED';

/** The one version economic publishes (`ECONOMIC_EVENT_VERSIONS`: absent, so 1). */
const VERSION = 1;

/** The diagnostic fields kept, in a fixed order. */
export const SETTLEMENT_REFUSAL_FIELDS = ['businessLine', 'transactionType'] as const;

export interface SettlementRefusalProjection {
  readonly reason: (typeof SETTLEMENT_REFUSAL_REASONS)[number];
  readonly changes: AuditChange[];
}

/**
 * The refusal an envelope records, or `null` for any other envelope —
 * including this name arriving on another topic, which is not economic's
 * record of anything.
 *
 * Throws {@link UnprocessableEventError} for an unsupported version, a payload
 * that fails economic's contract, or one about another transaction or tenant
 * than the envelope's.
 */
export function toSettlementRefusalProjection(
  envelope: EventEnvelope,
  delivery: EventDelivery,
): SettlementRefusalProjection | null {
  if (delivery.topic !== ECONOMIC_TOPIC || envelope.eventName !== SETTLEMENT_REFUSED) return null;

  const version = envelope.eventVersion ?? 1;
  if (version !== VERSION) {
    throw new UnprocessableEventError(
      DLQ_REASONS.SCHEMA_VERSION_UNSUPPORTED,
      `${SETTLEMENT_REFUSED} v${String(version)} has no settlement-refusal projection; ` +
        `v${String(VERSION)} is understood`,
    );
  }

  const parsed = settlementRefusedPayload.safeParse(envelope.payload);
  if (!parsed.success) throw refuse(issuesOf(parsed.error));
  const refusal = parsed.data;

  // Filed under the envelope's aggregate and tenant: a payload about another
  // transaction, or another payer, would put one refusal in another's history.
  if (refusal.transactionId !== envelope.aggregateId) {
    throw refuse('transactionId is not the envelope aggregateId');
  }
  if (refusal.organizationId !== envelope.tenantId) {
    throw refuse('organizationId is not the envelope tenantId');
  }

  const changes: AuditChange[] = SETTLEMENT_REFUSAL_FIELDS.map((field) => ({
    field,
    from: refusal[field],
    to: refusal[field],
  }));
  const bounded = auditChangesSchema.safeParse(changes);
  if (!bounded.success) throw refuse(issuesOf(bounded.error));
  return { reason: refusal.reason, changes: bounded.data };
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
    `${SETTLEMENT_REFUSED} does not match the settlement-refusal projection (${why})`,
  );
}
