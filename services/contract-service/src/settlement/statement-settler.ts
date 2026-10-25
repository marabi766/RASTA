import type { Statement } from '../generated/prisma';
import { ContractRepository } from '../contract/contract.repository';
import { EventPublisher } from '../events/publisher';
import { PrismaService } from '../prisma/prisma.service';
import { SERVICE_NAME } from '../config/env';
import { transactionNow } from '../shared/clock';
import { isUniqueViolation } from '../shared/prisma-errors';
import {
  contractSettlementDue,
  type ConfirmedSettlement,
  type SettlementClaim,
} from './obligation-confirm';
import { SettlementRepository, type SettlementCandidate } from './settlement.repository';

/** The actor recorded on a contract the settlement settles: the system, never a person. */
export const SETTLING_ACTOR = `service:${SERVICE_NAME}`;

/**
 * What told this service about the settlement, recorded on the statement (`settlement_event_id`):
 * the `SETTLEMENT_COMPLETED` event, or a reconciliation pass that asked economic-service itself
 * (`reconciliation:<run>`), which has no event to name. `causationId` is the event, when there is one.
 */
export interface SettlementSource {
  readonly reference: string;
  readonly causationId?: string;
}

export type SettleResult =
  | { readonly outcome: 'settled' | 'contract_settled' }
  /** Another delivery, or a reconciliation, settled the statement first: the row as it stands. */
  | { readonly outcome: 'already'; readonly statement: Statement };

/**
 * Settles the statement economic-service confirmed, and the contract once every approved statement
 * is (ADR-068 § 6 (3) and (5)), in one transaction — the one write the `SETTLEMENT_COMPLETED`
 * consumer and the settlement reconciliation share. Only ever called with a settlement economic
 * confirmed (`confirmSettlement`): never on an event's word.
 *
 * Under the contract's row lock — the one every command of a contract takes — then the statement's:
 * APPROVED → SETTLED with `STATEMENT_SETTLED` in the outbox; then, if the contract is COMPLETED with
 * no statement open and Σ settled = Σ approved net, COMPLETED → SETTLED with `CONTRACT_SETTLED`. Two
 * writers at once are ordered by the lock: the second finds the statement SETTLED (`already`).
 */
export class StatementSettler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractRepository,
    private readonly settlements: SettlementRepository,
    private readonly publisher: EventPublisher,
  ) {}

  async settle(
    candidate: SettlementCandidate,
    claim: SettlementClaim,
    settlement: ConfirmedSettlement,
    source: SettlementSource,
  ): Promise<SettleResult> {
    const tenant = candidate.organizationId;
    const causation = source.causationId ? { causationId: source.causationId } : {};
    try {
      const outcome = await this.prisma.transaction(async (tx) => {
        const contract = await this.contracts.lockContract(tx, tenant, candidate.contractId);
        if (!contract) throw new Error(`statement ${candidate.id} has no contract`);
        const statement = await this.settlements.lock(tx, tenant, contract.id, candidate.id);
        if (!statement) throw new Error(`statement ${candidate.id} vanished`);
        if (statement.status === 'SETTLED') throw new AlreadySettled(statement);
        // I3: an APPROVED statement changes only to SETTLED, so it is still APPROVED here.
        if (statement.status !== 'APPROVED') {
          throw new Error(`statement ${statement.id} is ${statement.status}, not APPROVED`);
        }

        const at = await transactionNow(tx);
        const moved = await this.settlements.settle(tx, {
          organizationId: tenant,
          id: statement.id,
          version: statement.version,
          settlement,
          eventId: source.reference,
          at,
        });
        // Under both locks nothing else moves it; a miss is a defect, retried and never acted on.
        if (!moved) throw new Error(`statement ${statement.id} moved under its lock`);
        await this.publisher.enqueue(tx, {
          eventName: 'STATEMENT_SETTLED',
          aggregateId: contract.id,
          organizationId: tenant,
          ...causation,
          occurredAt: at,
          payload: {
            contractId: contract.id,
            statementId: statement.id,
            statementNumber: statement.statementNumber,
            organizationId: tenant,
            contractorOrganizationId: contract.contractorOrganizationId,
            obligationId: settlement.obligationId,
            settlementId: settlement.settlementId,
            settledAt: settlement.settledAt.toISOString(),
          },
        });

        // ADR-068 § 6 (3): the contract, once COMPLETED, with no statement open and every approved
        // one settled in full.
        const totals = await this.settlements.totals(tx, tenant, contract.id);
        if (!contractSettlementDue(contract.status, totals)) return 'settled' as const;
        const settled = await this.contracts.transition(tx, {
          organizationId: tenant,
          id: contract.id,
          from: 'COMPLETED',
          to: 'SETTLED',
          version: contract.version,
          actor: SETTLING_ACTOR,
          at,
        });
        if (!settled) throw new Error(`contract ${contract.id} moved under its lock`);
        await this.publisher.enqueue(tx, {
          eventName: 'CONTRACT_SETTLED',
          aggregateId: contract.id,
          organizationId: tenant,
          ...causation,
          occurredAt: at,
          payload: {
            contractId: contract.id,
            projectId: contract.projectId,
            organizationId: tenant,
            contractorOrganizationId: contract.contractorOrganizationId,
            settledAt: at.toISOString(),
          },
        });
        return 'contract_settled' as const;
      });
      return { outcome };
    } catch (error) {
      const winner =
        error instanceof AlreadySettled
          ? error.statement
          : isUniqueViolation(error)
            ? await this.settlements.findSettledBy(tenant, claim.transactionId)
            : null;
      if (!winner) throw error;
      return { outcome: 'already', statement: winner };
    }
  }
}

/** Thrown inside the transaction when another writer settled the statement first. */
class AlreadySettled extends Error {
  constructor(readonly statement: Statement) {
    super('statement already settled');
  }
}
