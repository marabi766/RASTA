import { z } from 'zod';
import {
  amountMinorSchema,
  businessLineSchema,
  currencySchema,
  organizationIdSchema,
  numberInput,
} from '@rasta/contracts';
import { queryBoolean } from '@rasta/config';
import { cursorQueryParameter } from '../shared/cursor';
import { isEconomicRecordedSource, RECORDED_SOURCE_REFUSAL } from './recorded-sources';

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
 * generates the OpenAPI body (`toJsonSchema`, @rasta/nest-common) — one definition,
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

/**
 * The source type of a contract statement's obligation (ADR-068 § 6 (2)):
 * `(STATEMENT, statementId)` is its unique key, and only the
 * `STATEMENT_APPROVED` consumer records one, from contract-service's answer.
 */
export const STATEMENT_SOURCE_TYPE = 'STATEMENT';

export const createTransactionSchema = z
  .object({
    /**
     * `WALLET_TOP_UP` is absent on purpose: money entering a wallet goes
     * through the payment provider and `POST /v1/wallets/{id}/top-up`, which
     * records its own transaction. Accepting it here would let a caller
     * conjure a credit with no payment behind it.
     */
    transactionType: z.enum(TRANSACTION_TYPES),
    /**
     * Why the platform may earn from it (ADR-045 § 1), as the service that
     * owns the fact knows it. Never inferred from the type here: an order may
     * sell parts or broker a service.
     *
     * Optional in the schema while docs/24 Q-130 is open: a transaction
     * without a line is priced only by the type-only rules that predate
     * business lines, and with none its commission is recorded as
     * `NO_ACTIVE_RULE`. Where settlement fails closed (Q-29,
     * `ECONOMIC_SETTLEMENT_REQUIRE_COMMISSION_RULE`) a new obligation must
     * name it — 422 `BUSINESS_LINE_REQUIRED` otherwise — but for the source
     * flows `recorded-sources.ts` names (`LINE_LESS_SOURCE_TYPES`), identified
     * by their verified caller.
     */
    businessLine: businessLineSchema.optional(),
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
    /**
     * The owning service's identifier space — an order id, a statement id.
     * Reserved types are refused below (`recorded-sources.ts`).
     */
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
  .strict()
  // No caller — person or service — may record under a source type
  // economic-service records itself from the owner (`recorded-sources.ts`).
  .superRefine((dto, ctx) => {
    if (dto.sourceType !== undefined && isEconomicRecordedSource(dto.sourceType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceType'],
        message: RECORDED_SOURCE_REFUSAL,
      });
    }
  });

export type CreateTransactionDto = z.infer<typeof createTransactionSchema>;

export const listTransactionsQuerySchema = z
  .object({
    status: z.enum(TRANSACTION_STATUSES).optional(),
    transactionType: z.enum([...TRANSACTION_TYPES, 'WALLET_TOP_UP']).optional(),
    /**
     * Exactly this source type. With `sourceReference`, one source fact: at
     * most one row per payer (`ux_transaction_source_fact`), however many
     * other rows name the same reference under other types.
     */
    sourceType: z.string().trim().min(1).max(64).optional(),
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
     * `queryBoolean` rather than `z.coerce.boolean()`. The coercion applies
     * JavaScript's `Boolean()`, under which every non-empty string is true, so
     * `?includeIncoming=false` opted the caller *into* the guard-crossing
     * payee view. The crossing was always narrowed to the caller's own id and
     * so never leaked another tenant's rows, but a read that widens scope must
     * happen because someone asked for it, not because the parser could not
     * read the word "false".
     */
    includeIncoming: queryBoolean(false),
    cursor: cursorQueryParameter,
    limit: numberInput(z.number().int().min(1).max(100)).default(25),
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
    /**
     * The dispute this resolution decides, as `GET /v1/transactions/{id}`
     * names it (`disputeId`). Optional; when sent, the transaction must still
     * hold that dispute, checked under its row lock, or the command is refused
     * `INVALID_STATE_TRANSITION`. Without it, a decision about one dispute
     * could resolve another raised since (docs/23 D-053).
     */
    disputeId: z.string().trim().min(1).max(64).optional(),
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
  /** Why the platform may earn from it (ADR-045); null where the source sent none. */
  businessLine: string | null;
  status: string;
  grossAmountMinor: string;
  commissionAmountMinor: string;
  netAmountMinor: string;
  currency: string;
  occurredAt: string;
  sourceType: string | null;
  sourceReference: string | null;
  disputedAt: string | null;
  /** Who raised the latest dispute — the person, or this service for a service caller. */
  disputedBy: string | null;
  /** Why it was raised. Kept through the resolution (docs/23 D-060). */
  disputeReason: string | null;
  disputeResolvedAt: string | null;
  disputeResolvedBy: string | null;
  /**
   * What the resolver decided. Null on a transaction resolved before it had a
   * field of its own, whose `disputeReason` holds it instead (docs/23 D-060).
   */
  disputeResolution: string | null;
  settledAt: string | null;
  failureReason: string | null;
  createdAt: string;
  createdBy: string;
}

export interface TransactionDetailView extends TransactionView {
  /**
   * When it was authorised for settlement and, if a service did it, which
   * service and under which `Idempotency-Key` — kept for good, unlike the
   * command's stored answer (docs/23 D-053). Null if never authorised, or
   * recorded already authorised (ADR-032). `service` and `idempotencyKey`
   * are null for a person, and on rows authorised before they were kept.
   */
  settlementAuthorisation: {
    authorisedAt: string;
    service: string | null;
    idempotencyKey: string | null;
  } | null;
  /**
   * The latest dispute's identity: a new one each time the transaction is
   * disputed, kept through its resolution. Null if never disputed. What
   * `resolve-dispute` names to decide exactly this dispute (docs/23 D-053).
   */
  disputeId: string | null;
  /**
   * The dispute the recorded resolution (`disputeResolvedAt`, `disputeResolvedBy`,
   * `disputeResolution`) decided. Equal to `disputeId`: it is the latest
   * dispute's resolution; different: an earlier dispute's, and the latest has
   * none. Null if never resolved, and where the resolution is not attributed
   * by identity: on a transaction resolved before the identity was kept that
   * could not be attributed for certain (or is not yet — the backfill), and in
   * a command's answer stored before the field existed, replayed
   * (`storedTransactionDetailView`). There, which dispute the resolution
   * decided is not recorded, and the times do not establish it either: a
   * re-dispute can be dated before a resolution it waited behind (docs/23 D-060).
   */
  resolvedDisputeId: string | null;
  legs: { role: string; organizationId: string; amountMinor: string; currency: string }[];
  commission: {
    id: string;
    rateBasisPoints: number;
    amountMinor: string;
    /** Null when no rule matched — zero because unconfigured, not free. */
    ruleId: string | null;
    /** `RULE_APPLIED`, or `NO_ACTIVE_RULE` (ADR-045 § 2). */
    outcome: string;
  } | null;
  settlement: { id: string; journalId: string; settledAt: string } | null;
}
