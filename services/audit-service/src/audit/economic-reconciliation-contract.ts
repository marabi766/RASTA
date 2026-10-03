import { z } from 'zod';

/**
 * A pinned copy of economic-service's published payload contract for the two
 * payment-reconciliation events audit-service projects (D-046).
 *
 * ## Why a copy, and how it is kept honest
 *
 * The schemas live in `services/economic-service/src/events/events.ts` and are
 * not in `@rasta/contracts`, so AGENTS.md A-02 forbids importing them. Every
 * declaration between the two markers below is therefore **copied verbatim**
 * from that file — same names, same chain of zod calls — and
 * `economic-reconciliation-contract.spec.ts` reads both files as text and fails
 * if any of them differs by more than whitespace and comments. A change in
 * economic's contract cannot reach production without this copy changing with
 * it, in the same review.
 *
 * ## What it is used for
 *
 * Validation only. `payment-reconciliation-projection.ts` parses the
 * **complete** incoming payload against this contract first, and a payload that
 * economic could never have published — a missing `walletId` or `amountMinor`,
 * a `walletId` that is an object — is refused to the dead-letter topic. Only
 * after that is the stored row built, from an explicit allow-list: the amounts,
 * currency and provider are validated here and never stored.
 *
 * Do not edit between the markers except by re-copying from economic.
 */

// --- BEGIN PINNED COPY of services/economic-service/src/events/events.ts ---

const amountMinor = z.string().regex(/^\d{1,30}$/);

const currency = z.string().min(3).max(8);

const reconciliationKind = z.enum(['REFUND', 'UNCREDITED_REFUND']);

const unfinishedRefundMarker = z.enum([
  'REFUND_REQUESTED',
  'REFUND_UNKNOWN',
  'REFUNDED_NOT_REVERSED',
  'REFUND_DECLINED_RELEASE_PENDING',
  'CAPTURED_REFUND_UNKNOWN',
]);

export const EVIDENCE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;

const evidenceReference = z.string().regex(EVIDENCE_REFERENCE_PATTERN);

export const paymentReconciliationResolvedPayload = z.object({
  paymentIntentId: z.string(),
  organizationId: z.string(),
  walletId: z.string(),
  kind: reconciliationKind,
  marker: unfinishedRefundMarker.nullable(),
  providerRefund: z.enum(['REFUNDED', 'DECLINED', 'NOT_FOUND']).nullable(),
  resolution: z.enum([
    'REFUNDED',
    'REFUND_DECLINED',
    'REFUND_NOT_REACHED',
    'UNCREDITED_REFUNDED',
    'UNCREDITED_DECLINED',
    'UNCREDITED_NOT_REACHED',
    'NOTHING_TO_RECONCILE',
  ]),
  resolvedBy: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  amountMinor,
  currency,
  provider: z.string(),
  simulated: z.boolean(),
  resolvedAt: z.string(),
  // An operator resolution (step B3) also names both actors and the evidence:
  // `resolvedBy` is then the approver.
  resolutionId: z.string().optional(),
  proposedBy: z.string().min(1).optional(),
  approvedBy: z.string().min(1).optional(),
  evidenceReference: evidenceReference.optional(),
  fourEyes: z.boolean().optional(),
});

export const paymentReconciliationOperatorActionPayload = z.object({
  paymentIntentId: z.string(),
  organizationId: z.string(),
  walletId: z.string(),
  kind: reconciliationKind,
  action: z.enum(['REQUEUED', 'PROPOSED', 'REJECTED']),
  actor: z.string().min(1),
  /** For `REQUEUED`: the requeue row that keeps the reason (never on the event). */
  requeueId: z.string().nullable(),
  resolutionId: z.string().nullable(),
  providerOutcome: z.enum(['REFUNDED', 'DECLINED', 'NOT_REACHED']).nullable(),
  evidenceReference: evidenceReference.nullable(),
  /** For `REJECTED`: who proposed what was rejected. */
  proposedBy: z.string().min(1).nullable(),
  fourEyes: z.boolean(),
  amountMinor,
  currency,
  provider: z.string(),
  simulated: z.boolean(),
  occurredAt: z.string(),
});

// --- END PINNED COPY ---

/** The two schemas by event name. */
export const ECONOMIC_RECONCILIATION_CONTRACT = {
  PAYMENT_RECONCILIATION_RESOLVED: paymentReconciliationResolvedPayload,
  PAYMENT_RECONCILIATION_OPERATOR_ACTION: paymentReconciliationOperatorActionPayload,
} as const;
