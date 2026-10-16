import { Injectable } from '@nestjs/common';
import type { Currency } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import type { StatementSettlementView } from './dto';
import { StatementRepository, type StatementForSettlement } from './statement.repository';
import type { StatementStateName } from './statement.state-machine';

/**
 * A statement as its owner states it, for the one consumer that makes an obligation of it
 * (ADR-068 § 6 (2), ADR-061 § 4).
 *
 * ## Why this exists
 *
 * `STATEMENT_APPROVED` is a fact, not a payment order, and it carries identifiers only (Q-97 (2)):
 * an event is its publisher's claim, and the topic is read by every service. economic-service
 * builds the settleable obligation itself, so before it does, it asks this service what the
 * statement is: its status, its net and who pays whom. This read is the answer, and this service's
 * database is the only authority for it. The amount is never on the event.
 *
 * ## The lock (maintenance-service's `source-fact.ts`, ADR-061 § 4)
 *
 * - `/v1/internal/…`, a first path segment the gateway routes nowhere.
 * - `@AllowService` on the route admits no other service (403), and {@link assertSettlementReadCaller}
 *   here also refuses every *user* token (403): the auth guard admits a verified user to any
 *   authenticated route, so `@AllowService` alone would not.
 * - The tenant is the one **signed into** the internal token (ADR-035), never a header, and it
 *   must be the employer's — the statement's own `organization_id`. A token with no organization
 *   is refused (403) before any query; a statement of any other organization — the contractor's
 *   included — is not found, so the caller learns nothing about it.
 *
 * ## What it returns
 *
 * The row as it stands, whatever its status: economic decides, and it must refuse anything that
 * is not APPROVED. Money is a decimal string of minor units.
 */

/** The only caller this read answers. */
export const SETTLEMENT_READ_CALLER = 'economic-service';

/**
 * The currency of every contract amount. Nothing on the contract chain stores one: the tender's
 * price, the contract's amount and a statement's lines are rials by the standing answer to Q-73
 * (2) (CON-001 — project amounts are rials, with no currency field; another currency is a column
 * and a field, added with a migration). It is said explicitly here because a settling consumer
 * must never assume one (ADR-022).
 */
export const CONTRACT_CURRENCY: Currency = 'IRR';

export function assertSettlementReadCaller(): void {
  const context = getContext();
  if (context.authType !== 'SERVICE' || context.callerService !== SETTLEMENT_READ_CALLER) {
    throw RastaError.forbidden('This endpoint is reserved for the settlement consumer');
  }
}

/**
 * When the statement was approved: the moment of the decision on the financial chain's last step
 * that approved it. `null` unless the statement is APPROVED.
 */
export function approvedAtOf(row: StatementForSettlement): Date | null {
  if (row.status !== 'APPROVED') return null;
  const last = row.decisions.find(
    (decision) =>
      decision.chain === 'FINANCIAL' &&
      decision.stepOrder === row.financialStepCount &&
      decision.outcome === 'APPROVED',
  );
  // The database keeps an APPROVED statement with exactly that decision
  // (`statement_decisions_consistent`); a row without it is a defect, never a guess.
  if (!last) throw new Error(`APPROVED statement ${row.id} has no final financial approval`);
  return last.decidedAt;
}

export function toStatementSettlementView(row: StatementForSettlement): StatementSettlementView {
  const approvedAt = approvedAtOf(row);
  return {
    statementId: row.id,
    contractId: row.contractId,
    status: row.status as StatementStateName,
    netMinor: row.netMinor.toString(),
    currency: CONTRACT_CURRENCY,
    payerOrganizationId: row.organizationId,
    beneficiaryOrganizationId: row.contract.contractorOrganizationId,
    approvedAt: approvedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class StatementSettlementService {
  constructor(private readonly statements: StatementRepository) {}

  async statementFact(id: string): Promise<StatementSettlementView> {
    assertSettlementReadCaller();
    // Resolved before the read, so a token minted with no organization fails here as a 403 and
    // never reaches a query.
    getOrganizationId();

    const row = await this.statements.findForSettlement(id);
    if (!row) throw RastaError.notFound('Statement', id);
    return toStatementSettlementView(row);
  }
}
