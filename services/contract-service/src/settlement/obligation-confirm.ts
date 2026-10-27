import { z } from 'zod';
import { isoDateTime } from '@rasta/contracts';
import { CONTRACT_CURRENCY } from '../statement/settlement-fact';

/**
 * Whether economic-service confirms that a statement's obligation was settled in full (ADR-068 § 6
 * (3), I5; ADR-061 § 4, AGENTS.md A-13).
 *
 * Pure functions, so every branch that decides whether a statement is SETTLED can be proved without
 * a network or a database.
 *
 * ## The event is a trigger; economic's answer is the confirmation
 *
 * `SETTLEMENT_COMPLETED` is its publisher's claim, and it does not name the statement: it carries
 * economic's transaction (the obligation), the settlement, the payer, the payee and the gross. So the
 * consumer finds the statements it could be about — the payer's APPROVED statements whose contractor
 * is the payee — and asks economic, statement by statement, for the obligation it holds for each
 * (`GET /v1/internal/obligations/by-source/STATEMENT/{statementId}`). The statement whose obligation
 * **is** the event's transaction is the one: {@link isObligationOf}. Then economic's answer — never
 * the event — is held against this service's own row ({@link confirmSettlement}): the same
 * statement, the employer pays the contractor, rials, the obligation is exactly the statement's net,
 * it is SETTLED and `fullySettled`, by a settlement of the whole amount — the settlement the event
 * names. Anything else is a refusal.
 */

/** The largest value of a PostgreSQL `bigint`: a column cannot hold more. */
const MAX_AMOUNT_MINOR = 9_223_372_036_854_775_807n;

const minor = z.string().regex(/^\d{1,19}$/);

/**
 * What economic-service answers to `GET /v1/internal/obligations/by-source/STATEMENT/{statementId}`
 * (#340's `StatementObligationView`), as this service reads it: declared here (no cross-service
 * imports), required fields only. An extra field is not this service's business — which is why this
 * is not `.strict()` — while a missing or malformed one makes the answer unusable (fail closed).
 */
export const obligationFactSchema = z.object({
  obligationId: z.string().min(1).max(128),
  statementId: z.string().min(1).max(128),
  status: z.string().min(1).max(64),
  amountMinor: minor,
  currency: z.string().min(1).max(8),
  payerOrganizationId: z.string().min(1).max(128),
  beneficiaryOrganizationId: z.string().min(1).max(128),
  settlementId: z.string().min(1).max(128).nullable(),
  settledAt: z
    .string()
    .check(isoDateTime({ offset: true }))
    .nullable(),
  settledAmountMinor: minor.nullable(),
  fullySettled: z.boolean(),
});

export type ObligationFact = z.infer<typeof obligationFactSchema>;

/** What `SETTLEMENT_COMPLETED` claims, as far as this service reads it. */
export interface SettlementClaim {
  /** economic's transaction — for a statement, its obligation. */
  readonly transactionId: string;
  readonly settlementId: string;
}

/** The statement as this service records it: what economic's answer is held against. */
export interface SettlingStatement {
  readonly id: string;
  /** The employer: the statement's tenant, the obligation's payer. */
  readonly organizationId: string;
  /** The contract's winning contractor: the obligation's beneficiary. */
  readonly contractorOrganizationId: string;
  readonly netMinor: bigint;
}

export type SettlementMismatch =
  | 'tenant_mismatch'
  | 'statement_mismatch'
  | 'payer_mismatch'
  | 'beneficiary_mismatch'
  | 'currency_mismatch'
  | 'amount_mismatch'
  | 'not_settled'
  | 'settlement_mismatch';

/** A settlement economic confirmed: what the statement records. */
export interface ConfirmedSettlement {
  readonly obligationId: string;
  readonly settlementId: string;
  readonly settledAt: Date;
  readonly settledAmountMinor: bigint;
}

export type SettlementVerdict =
  | { confirmed: true; settlement: ConfirmedSettlement }
  | { confirmed: false; mismatch: SettlementMismatch };

const refuted = (mismatch: SettlementMismatch): SettlementVerdict => ({
  confirmed: false,
  mismatch,
});

/**
 * The envelope's tenant, the payload's organization and its payer are one and the same — the
 * employer — before anything is read or asked (ADR-061 § 5). A missing tenant is a mismatch, never
 * a pass.
 */
export function confirmSettlementTenant(
  envelopeTenantId: string | undefined,
  organizationId: string,
  payerOrganizationId: string,
): boolean {
  return (
    !!envelopeTenantId &&
    envelopeTenantId === organizationId &&
    envelopeTenantId === payerOrganizationId
  );
}

/** Whether economic's obligation for a statement is the transaction the event settled. */
export function isObligationOf(claim: SettlementClaim, fact: ObligationFact | null): boolean {
  return fact !== null && fact.obligationId === claim.transactionId;
}

/** A decimal string of minor units as a `bigint`, or `null` when no `bigint` column holds it. */
export function minorOf(value: string | null): bigint | null {
  if (value === null || !/^\d{1,19}$/.test(value)) return null;
  const amount = BigInt(value);
  return amount <= MAX_AMOUNT_MINOR ? amount : null;
}

/**
 * Whether economic's answer for the event's obligation confirms that `statement` was settled in
 * full, by the settlement the event names. Every figure is economic's; the event contributes only
 * which obligation and which settlement it claims.
 */
export function confirmSettlement(
  statement: SettlingStatement,
  claim: SettlementClaim,
  fact: ObligationFact,
): SettlementVerdict {
  if (fact.statementId !== statement.id) return refuted('statement_mismatch');
  if (fact.payerOrganizationId !== statement.organizationId) return refuted('payer_mismatch');
  if (fact.beneficiaryOrganizationId !== statement.contractorOrganizationId) {
    return refuted('beneficiary_mismatch');
  }
  if (fact.currency !== CONTRACT_CURRENCY) return refuted('currency_mismatch');
  // The obligation is the statement's whole net (Q-97 (4)); any other amount is not this statement's.
  if (minorOf(fact.amountMinor) !== statement.netMinor) return refuted('amount_mismatch');
  if (fact.status !== 'SETTLED' || !fact.fullySettled) return refuted('not_settled');
  const settledAt = fact.settledAt === null ? Number.NaN : Date.parse(fact.settledAt);
  if (fact.settlementId === null || !Number.isFinite(settledAt)) return refuted('not_settled');
  // Settled in full: the settlement took the whole obligation from the payer.
  const settledAmountMinor = minorOf(fact.settledAmountMinor);
  if (settledAmountMinor !== statement.netMinor) return refuted('amount_mismatch');
  if (fact.settlementId !== claim.settlementId) return refuted('settlement_mismatch');
  return {
    confirmed: true,
    settlement: {
      obligationId: fact.obligationId,
      settlementId: fact.settlementId,
      settledAt: new Date(settledAt),
      settledAmountMinor,
    },
  };
}

/** What the contract's settlement rule reads of its statements, under its row lock. */
export interface ContractStatementTotals {
  /** Statements DRAFT, SUBMITTED, TECHNICALLY_APPROVED or APPROVED. */
  readonly open: number;
  /** Σ net of the APPROVED and SETTLED statements. */
  readonly approvedNetMinor: bigint;
  /** Σ settled amount of the SETTLED statements. */
  readonly settledMinor: bigint;
}

/**
 * ADR-068 § 6 (3): a COMPLETED contract is settled when no statement is open and the sum settled is
 * the sum of the approved net. The database holds the same rule (`contract_guard`).
 */
export function contractSettlementDue(status: string, totals: ContractStatementTotals): boolean {
  return (
    status === 'COMPLETED' && totals.open === 0 && totals.settledMinor === totals.approvedNetMinor
  );
}
