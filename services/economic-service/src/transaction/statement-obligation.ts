import { Injectable } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { formatMinor } from '../shared/money';
import { TransactionRepository } from './transaction.repository';

/**
 * A contract statement's obligation as economic-service holds it, for the one
 * service that marks the statement SETTLED (ADR-068 § 6 (3), ADR-061 § 4).
 *
 * ## Why this exists
 *
 * A statement is SETTLED in contract-service only on economic-service's
 * confirmation that its obligation was paid in full (I5). An event is its
 * publisher's claim and the topic is read by every service, so before that
 * transition contract-service asks here — by the statement's id — what the
 * obligation is: its status, its amount and whether that amount was settled.
 * This read is the answer, and this service's database is the only authority
 * for it.
 *
 * ## The lock (contract-service's `settlement-fact.ts`, ADR-061 § 4)
 *
 * - `/v1/internal/…`, a first path segment the gateway routes nowhere.
 * - `@AllowService` on the route admits no other service (403), and
 *   {@link assertStatementObligationReadCaller} here also refuses every *user*
 *   token (403): the auth guard admits a verified user to any authenticated
 *   route, so `@AllowService` alone would not.
 * - The tenant is the one **signed into** the internal token (ADR-035), never
 *   a header, and it must be the payer's — the employer, the statement's own
 *   organization and the obligation's `organization_id`. A token with no
 *   organization is refused (403) before any query; an obligation of any other
 *   payer — the beneficiary's included — is not found, exactly as one that
 *   does not exist, so the caller learns nothing about it.
 *
 * ## What it returns
 *
 * The row as it stands, whatever its status: contract-service decides, and it
 * must not settle a statement unless `fullySettled` is true. Money is a
 * decimal string of minor units.
 */

/** The only caller this read answers. */
export const STATEMENT_OBLIGATION_READ_CALLER = 'contract-service';

export function assertStatementObligationReadCaller(): void {
  const context = getContext();
  if (
    context.authType !== 'SERVICE' ||
    context.callerService !== STATEMENT_OBLIGATION_READ_CALLER
  ) {
    throw RastaError.forbidden('This endpoint is reserved for the statement settlement reader');
  }
}

/** What `GET /v1/internal/obligations/by-source/STATEMENT/{statementId}` answers. */
export interface StatementObligationView {
  /** The obligation — economic-service's transaction id (`TXN_…`). */
  obligationId: string;
  /** The statement it was recorded for: its source reference. */
  statementId: string;
  /** Its lifecycle status (docs/10 § 10.5); only `SETTLED` is paid. */
  status: string;
  /** What the payer owes: the statement's whole net, as recorded from the owner's answer. */
  amountMinor: string;
  currency: string;
  payerOrganizationId: string;
  beneficiaryOrganizationId: string;
  /** The settlement that discharged it; null until one did. */
  settlementId: string | null;
  settledAt: string | null;
  /** The amount that settlement took from the payer; null until one did. */
  settledAmountMinor: string | null;
  /** True only when the whole `amountMinor` was settled. */
  fullySettled: boolean;
}

/** The row this view is built from: the obligation and its settlement, if any. */
export interface StatementObligationRow {
  id: string;
  organizationId: string;
  counterpartyOrganizationId: string | null;
  status: string;
  grossAmountMinor: bigint;
  currency: string;
  sourceReference: string | null;
  settlement: { id: string; grossAmountMinor: bigint; settledAt: Date } | null;
}

/**
 * Whether the obligation was settled in full — and a refusal of a row that
 * contradicts itself.
 *
 * A settlement discharges an obligation whole, in the same database
 * transaction that moves it to `SETTLED` (`SettlementService`): there is no
 * partial payment (docs/24 Q-97 (4)), and `SETTLED` is terminal. So `SETTLED`
 * with exactly one settlement of the whole amount is "paid in full", any other
 * status with no settlement is "not paid", and anything else — `SETTLED`
 * without a settlement, a settlement of another amount, a settlement under a
 * status that is not `SETTLED` — is a defect, never a guess: it fails loudly
 * rather than tell contract-service a statement is paid, or is not.
 */
export function fullySettledOf(row: StatementObligationRow): boolean {
  const { settlement } = row;
  if (row.status === 'SETTLED') {
    if (!settlement || settlement.grossAmountMinor !== row.grossAmountMinor) {
      throw new Error(`SETTLED obligation ${row.id} has no settlement of its whole amount`);
    }
    return true;
  }
  if (settlement) {
    throw new Error(`Obligation ${row.id} has a settlement but is ${row.status}`);
  }
  return false;
}

export function toStatementObligationView(row: StatementObligationRow): StatementObligationView {
  // The consumer records a STATEMENT row only with a beneficiary and a source
  // reference, and `ck_transaction_statement_obligation` holds it; a row
  // without them is a defect.
  if (!row.counterpartyOrganizationId || !row.sourceReference) {
    throw new Error(`STATEMENT obligation ${row.id} names no beneficiary or no statement`);
  }
  const fullySettled = fullySettledOf(row);
  return {
    obligationId: row.id,
    statementId: row.sourceReference,
    status: row.status,
    amountMinor: formatMinor(row.grossAmountMinor),
    currency: row.currency,
    payerOrganizationId: row.organizationId,
    beneficiaryOrganizationId: row.counterpartyOrganizationId,
    settlementId: row.settlement?.id ?? null,
    settledAt: row.settlement?.settledAt.toISOString() ?? null,
    settledAmountMinor: row.settlement ? formatMinor(row.settlement.grossAmountMinor) : null,
    fullySettled,
  };
}

@Injectable()
export class StatementObligationService {
  constructor(private readonly transactions: TransactionRepository) {}

  async statementObligation(statementId: string): Promise<StatementObligationView> {
    assertStatementObligationReadCaller();
    // Resolved before the read, so a token minted with no organization fails
    // here as a 403 and never reaches a query.
    const payer = getOrganizationId();

    const row = await this.transactions.findStatementObligation(payer, statementId);
    // Fixed words: the id is in the logged path, and a 404 says only "not here".
    if (!row) throw RastaError.notFound('Obligation');
    return toStatementObligationView(row);
  }
}
