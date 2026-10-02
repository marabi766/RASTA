import { z } from 'zod';
import { amountMinorSchema } from '@rasta/contracts';
import { EVIDENCE_REFERENCE_PATTERN } from '../events/events';

/**
 * Payment request shapes (ADR-024).
 *
 * Note what this API does **not** accept: no card number, no account number,
 * no CVV, no expiry. Those must never enter this process (AGENTS.md S-09), and
 * a real provider would be handed a token obtained by the client directly from
 * that provider. The absence is the design.
 */

export const topUpSchema = z
  .object({
    amountMinor: amountMinorSchema.refine((value) => BigInt(value) > 0n, {
      message: 'A top-up must be positive',
    }),
    /**
     * Mirrors the required `Idempotency-Key` header.
     *
     * Passed to the provider as well as stored, so a retry is deduplicated on
     * both sides of the boundary (docs/06 § 6.8).
     */
    idempotencyKey: z.string().trim().min(8).max(128),
    /**
     * Opaque provider instruction.
     *
     * With a real provider this would be a tokenised instrument reference —
     * never the instrument itself. With the simulated provider it is how a
     * test asks for a specific failure (`fail:INSUFFICIENT_FUNDS`,
     * `fail-capture:<code>`), which is what makes the compensation paths
     * reachable deterministically instead of by chance.
     */
    instrument: z.string().trim().max(128).optional(),
  })
  .strict();

export type TopUpDto = z.infer<typeof topUpSchema>;

export const refundPaymentSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export type RefundPaymentDto = z.infer<typeof refundPaymentSchema>;

/** Why an operator acts: kept in this service, never on an event. */
const operatorReason = z.string().trim().min(3).max(500);

/**
 * An operator's proposed resolution of an unfinished refund (ADR-064 § 6,
 * step B3). The evidence is mandatory (Q-82) and a reference — a ticket or a
 * document id the provider's statement is filed under — never the statement
 * itself, and never free text: it travels on the event to audit-service.
 */
export const proposeResolutionSchema = z
  .object({
    providerOutcome: z.enum(['REFUNDED', 'DECLINED', 'NOT_REACHED']),
    evidenceReference: z.string().trim().regex(EVIDENCE_REFERENCE_PATTERN, {
      message: 'An evidence reference is 3–128 letters, digits and . _ : / -',
    }),
    reason: operatorReason,
  })
  .strict();

export type ProposeResolutionDto = z.infer<typeof proposeResolutionSchema>;

/** Approving, rejecting or requeueing: why, in words a second person can check. */
export const operatorDecisionSchema = z.object({ reason: operatorReason }).strict();

export type OperatorDecisionDto = z.infer<typeof operatorDecisionSchema>;

export const listPaymentsQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

export interface PaymentIntentView {
  id: string;
  organizationId: string;
  walletId: string;
  transactionId: string | null;
  provider: string;
  /** Always true in this MVP. Carried explicitly so no caller has to assume. */
  simulated: boolean;
  amountMinor: string;
  currency: string;
  status: string;
  providerReference: string | null;
  failureReason: string | null;
  createdAt: string;
  authorizedAt: string | null;
  capturedAt: string | null;
  failedAt: string | null;
  refundedAt: string | null;
}
