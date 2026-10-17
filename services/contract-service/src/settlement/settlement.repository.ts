import { Injectable } from '@nestjs/common';
import type { Statement } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import {
  OPEN_STATEMENT_STATES,
  type StatementStateName,
} from '../statement/statement.state-machine';
import type { ConfirmedSettlement, ContractStatementTotals } from './obligation-confirm';

/** An APPROVED statement the event could be about, with the contractor it is owed to. */
export type SettlementCandidate = Statement & { contract: { contractorOrganizationId: string } };

/**
 * Every statement the `SETTLEMENT_COMPLETED` consumer runs against `statement` (CON-003 PR 6c).
 *
 * The consumer acts for one tenant — the employer, the envelope's tenant proved equal to the payer —
 * and every statement here goes through the tenant guard, naming that organization explicitly as
 * well: a statement of another organization is simply not found (AGENTS.md A-04). Writes run under
 * the contract's row lock (`ContractRepository.lockContract`), then the statement's.
 */
@Injectable()
export class SettlementRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The statement an obligation already settled, if any: the consumer's idempotency probe. */
  findSettledBy(
    organizationId: string,
    obligationId: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<Statement | null> {
    return client.statement.findFirst({
      where: { organizationId, settlementObligationId: obligationId },
    });
  }

  /**
   * The statements a settlement of `payeeOrganizationId` by the employer could be of: APPROVED, of a
   * contract whose contractor is the payee. Those whose net is `amountMinor` first — the obligation is
   * the statement's whole net (Q-97 (4)), so the one asked first is nearly always the one — then by
   * id, so the order is stable.
   */
  async findCandidates(
    organizationId: string,
    payeeOrganizationId: string,
    amountMinor: bigint | null,
  ): Promise<SettlementCandidate[]> {
    const rows = await this.prisma.client.statement.findMany({
      where: {
        organizationId,
        status: 'APPROVED',
        contract: { organizationId, contractorOrganizationId: payeeOrganizationId },
      },
      include: { contract: { select: { contractorOrganizationId: true } } },
      orderBy: { id: 'asc' },
    });
    const first = (row: Statement) => (row.netMinor === amountMinor ? 0 : 1);
    return rows.sort((a, b) => first(a) - first(b));
  }

  /** Takes the statement's row lock and reads it as it now stands (after the contract's lock). */
  async lock(
    tx: ExtendedPrismaClient,
    organizationId: string,
    contractId: string,
    id: string,
  ): Promise<Statement | null> {
    await tx.$queryRaw`SELECT 1 FROM statement WHERE organization_id = ${organizationId} AND contract_id = ${contractId} AND id = ${id} FOR UPDATE`;
    return tx.statement.findFirst({ where: { organizationId, contractId, id } });
  }

  /**
   * APPROVED → SETTLED: a compare-and-set on `organization_id`, `id`, APPROVED and the `version` it
   * was read at, which it increments, recording the settlement economic confirmed. `false` when the
   * row is no longer that. The database holds the rest: only APPROVED > SETTLED, on a contract SIGNED
   * or COMPLETED, the settled amount the net (`statement_guard`, `ck_statement_settlement`), one
   * obligation per statement (`ux_statement_settlement_obligation`).
   */
  async settle(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      id: string;
      version: number;
      settlement: ConfirmedSettlement;
      eventId: string;
      at: Date;
    },
  ): Promise<boolean> {
    const { count } = await tx.statement.updateMany({
      where: {
        organizationId: input.organizationId,
        id: input.id,
        status: 'APPROVED',
        version: input.version,
      },
      data: {
        status: 'SETTLED',
        settledAt: input.settlement.settledAt,
        settlementObligationId: input.settlement.obligationId,
        settlementId: input.settlement.settlementId,
        settledAmountMinor: input.settlement.settledAmountMinor,
        settlementEventId: input.eventId,
        updatedAt: input.at,
        version: { increment: 1 },
      },
    });
    return count === 1;
  }

  /**
   * What the contract's settlement rule reads (ADR-068 § 6 (3)), in the transaction that holds the
   * contract's row lock: how many of its statements are open, the approved net and the sum settled —
   * in arbitrary-precision bigint, never a database sum that could overflow.
   */
  async totals(
    tx: ExtendedPrismaClient,
    organizationId: string,
    contractId: string,
  ): Promise<ContractStatementTotals> {
    const rows = await tx.statement.findMany({
      where: { organizationId, contractId },
      select: { status: true, netMinor: true, settledAmountMinor: true },
    });
    let open = 0;
    let approvedNetMinor = 0n;
    let settledMinor = 0n;
    for (const row of rows) {
      const status = row.status as StatementStateName;
      if (OPEN_STATEMENT_STATES.includes(status)) open += 1;
      if (status === 'APPROVED' || status === 'SETTLED') approvedNetMinor += row.netMinor;
      if (status === 'SETTLED') settledMinor += row.settledAmountMinor ?? 0n;
    }
    return { open, approvedNetMinor, settledMinor };
  }
}
