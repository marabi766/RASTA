import { z } from 'zod';
import { amountMinorSchema, currencySchema, organizationIdSchema } from '@rasta/contracts';
import { booleanEnv } from '@rasta/config';

/**
 * Request and response shapes for transactions.
 *
 * Every amount is a **string in minor units** on the way in and on the way
 * out. Accepting a JSON number would silently truncate a rial figure past
 * `Number.MAX_SAFE_INTEGER`, and the truncation would happen in the client's
 * JSON parser where no validation can see it (ADR-022).
 *
 * Schemas are Zod rather than class-validator because validation happens at
 * the boundary through `zodPipe`, and because the same schema is what
 * generates the OpenAPI body (`openapi/zod-schema.ts`) — one definition,
 * rather than a decorated class and a hand-written document that drift.
 */

export const TRANSACTION_TYPES = [
  'MARKETPLACE_ORDER',
  'MAINTENANCE_SERVICE',
  'LOGISTICS',
  'CONSTRUCTION_STATEMENT',
  'PROCUREMENT_ORDER',
] as const;

export const TRANSACTION_STATUSES = [
  'CREATED',
  'HELD',
  'PENDING_SETTLEMENT',
  'DISPUTED',
  'SETTLED',
  'REFUNDED',
  'CANCELLED',
  'FAILED',
] as const;

export const createTransactionSchema = z
  .object({
    /**
     * `WALLET_TOP_UP` is absent on purpose: money entering a wallet goes
     * through the payment provider and `POST /v1/wallets/{id}/top-up`, which
     * records its own transaction. Accepting it here would let a caller
     * conjure a credit with no payment behind it.
     */
    transactionType: z.enum(TRANSACTION_TYPES),
    counterpartyOrganizationId: organizationIdSchema.optional(),
    grossAmountMinor: amountMinorSchema,
    currency: currencySchema.default('IRR'),
    /**
     * When the underlying business event happened.
     *
     * The commission rule is selected against this, not against now, so a
     * transaction recorded late is still charged the rate that was in force
     * when it occurred (docs/10 § 10.7). Defaults to now.
     */
    occurredAt: z.string().datetime().optional(),
    /** The owning service's identifier space — an order id, a statement id. */
    sourceType: z.string().trim().min(1).max(64).optional(),
    sourceReference: z.string().trim().min(1).max(128).optional(),
    /**
     * Reserve the funds immediately.
     *
     * What an order needs: the obligation and the hold have to be created
     * together, or there is a window in which the money is still spendable
     * (docs/10 § 10.5).
     */
    holdFunds: z.boolean().default(false),
    /** Mirrors the `Idempotency-Key` header onto the row, for tracing. */
    idempotencyKey: z.string().trim().min(8).max(128).optional(),
  })
  .strict();

export type CreateTransactionDto = z.infer<typeof createTransactionSchema>;

export const listTransactionsQuerySchema = z
  .object({
    status: z.enum(TRANSACTION_STATUSES).optional(),
    transactionType: z.enum([...TRANSACTION_TYPES, 'WALLET_TOP_UP']).optional(),
    sourceReference: z.string().trim().min(1).max(128).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    /**
     * Include transactions where this organization is the payee.
     *
     * Off by default: the common view is "what I owe". A supplier asking what
     * it is owed opts in, and that read crosses the tenant guard with a
     * written reason, narrowed to the caller's own id.
     *
     * `booleanEnv` rather than `z.coerce.boolean()`. The coercion applies
     * JavaScript's `Boolean()`, under which every non-empty string is true, so
     * `?includeIncoming=false` opted the caller *into* the guard-crossing
     * payee view. The crossing was always narrowed to the caller's own id and
     * so never leaked another tenant's rows, but a read that widens scope must
     * happen because someone asked for it, not because the parser could not
     * read the word "false".
     */
    includeIncoming: booleanEnv(false),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;

export const disputeTransactionSchema = z
  .object({
    /**
     * Required, and at least a sentence.
     *
     * A dispute stops settlement completely and indefinitely (docs/10 § 10.5).
     * Whoever has to resolve it needs to know what it is about, and a
     * one-word reason is how a dispute becomes permanent by neglect.
     */
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();

export type DisputeTransactionDto = z.infer<typeof disputeTransactionSchema>;

export const resolveDisputeSchema = z
  .object({
    resolution: z.string().trim().min(10).max(1000),
  })
  .strict();

export type ResolveDisputeDto = z.infer<typeof resolveDisputeSchema>;

export const cancelTransactionSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export type CancelTransactionDto = z.infer<typeof cancelTransactionSchema>;

export const refundTransactionSchema = cancelTransactionSchema;
export type RefundTransactionDto = z.infer<typeof refundTransactionSchema>;

export const settleTransactionSchema = z
  .object({
    transactionId: z.string().trim().min(1).max(64),
  })
  .strict();

export type SettleTransactionDto = z.infer<typeof settleTransactionSchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface TransactionView {
  id: string;
  organizationId: string;
  counterpartyOrganizationId: string | null;
  transactionType: string;
  status: string;
  grossAmountMinor: string;
  commissionAmountMinor: string;
  netAmountMinor: string;
  currency: string;
  occurredAt: string;
  sourceType: string | null;
  sourceReference: string | null;
  disputedAt: string | null;
  disputeReason: string | null;
  settledAt: string | null;
  failureReason: string | null;
  createdAt: string;
  createdBy: string;
}

export interface TransactionDetailView extends TransactionView {
  legs: { role: string; organizationId: string; amountMinor: string; currency: string }[];
  commission: {
    id: string;
    rateBasisPoints: number;
    amountMinor: string;
    /** False when no rule matched — zero because unconfigured, not free. */
    ruleId: string | null;
  } | null;
  settlement: { id: string; journalId: string; settledAt: string } | null;
}
