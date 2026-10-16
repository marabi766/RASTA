import { Injectable } from '@nestjs/common';
import { RastaError, currentActor, getContext } from '@rasta/nest-common';
import type { Contract } from '../generated/prisma';
import { ContractAccess, assertPartyOf, sideOf } from '../access/access';
import { SERVICE_NAME } from '../config/env';
import { ContractRepository } from '../contract/contract.repository';
import type { CursorPage } from '../contract/dto';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { contractCommandsTotal } from '../observability/metrics';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { databaseClock } from '../shared/clock';
import type { ClaimFence, RefusalFence } from '../shared/idempotency';
import { forbiddenRefusal, ruleRefusal, type ReasonOf } from '../shared/refusal';
import { AuthorityRefusals } from '../signing/authority-refusals';
import { computeStatementAmounts } from './amounts';
import type { DraftStatementDto, ListStatementsQuery, StatementView } from './dto';
import { StatementRepository } from './statement.repository';
import { toStatementView } from './views';

type StatementCommand = 'draft_statement';

/**
 * A signed contract's statements (ADR-068 § 5; CON-003 PR 4): the contractor drafts one — its lines
 * and the configured deductions it applies — and both parties read them. Submission is not here:
 * it needs the approval policies of both chains and their snapshot at submission (ADR-068 § 5),
 * and comes with them in the next change; until then a statement stays a DRAFT, which the
 * database holds too (`statement_guard`).
 *
 * Built like the amendment and milestone commands:
 *
 * - **Object-level authorization first.** The contract is found as a party; anyone else gets the
 *   `404` a missing contract gets (S-03), and nothing is audited. Only then is the side judged —
 *   the contractor drafts, the employer is `403 AUTHOR_NOT_CONTRACTOR` — and then the `CONTRACTOR`
 *   role. A party's refusal, and the platform administrator's acting for a party, is recorded
 *   (`CONTRACT_AUTHORITY_REFUSED`, `DRAFT_STATEMENT`) through the request's idempotency fence, as
 *   for the other commands; when it cannot be recorded the answer is a retryable `503`.
 * - **One lock, then the state.** The contract's row lock is taken first, and everything is decided
 *   under it: the contract still SIGNED, the deduction rules still in force, and the next number,
 *   so two drafts at once get two consecutive numbers (`ux_statement_number` is the backstop).
 * - **Money is computed once** (`computeStatementAmounts`): bigint, `net = gross − Σ deductions`,
 *   each deduction the configured rate of the gross; the database checks the same at commit.
 * - **Deductions only from configuration** (Q-96 (6)): a rule id that is not one the employer keeps
 *   in force is `422 DEDUCTION_NOT_CONFIGURED`; with none applied the net is the gross.
 * - **The draft has its event in the same transaction** (`STATEMENT_DRAFTED`): identifiers only,
 *   no amount (Q-97 (2)).
 */
@Injectable()
export class StatementService {
  constructor(
    private readonly repository: StatementRepository,
    private readonly contracts: ContractRepository,
    private readonly refusals: AuthorityRefusals,
    private readonly access: ContractAccess,
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
  ) {}

  // -- reads ----------------------------------------------------------------------------

  async get(contractId: string, statementId: string): Promise<StatementView> {
    const contract = await this.readableContract(contractId);
    const row = await this.repository.findOne(contract.organizationId, contract.id, statementId);
    if (!row) throw RastaError.notFound('Statement', statementId);
    return toStatementView(row, contract.contractorOrganizationId);
  }

  /** The contract's statements, oldest first. */
  async list(contractId: string, query: ListStatementsQuery): Promise<CursorPage<StatementView>> {
    const contract = await this.readableContract(contractId);
    const rows = await this.repository.list(
      contract.organizationId,
      contract.id,
      query.cursor === undefined ? undefined : Number(query.cursor),
      query.limit,
    );
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: visible.map((row) => toStatementView(row, contract.contractorOrganizationId)),
      nextCursor: hasMore ? String(visible[visible.length - 1]?.statementNumber ?? '') : null,
      hasMore,
    };
  }

  /** Whether the caller may still see this contract's statements (replay of a command). */
  async assertContractVisible(contractId: string): Promise<void> {
    await this.readableContract(contractId);
  }

  private async readableContract(contractId: string): Promise<Contract> {
    const parties = this.access.assertCanRead();
    const row = await this.contracts.findReadable(parties, contractId);
    if (!row) throw RastaError.notFound('Contract', contractId);
    assertPartyOf(row, parties);
    return row;
  }

  // -- draft ----------------------------------------------------------------------------

  /** The contractor drafts a statement of a SIGNED contract: DRAFT, with the next number. */
  async draft(
    contractId: string,
    dto: DraftStatementDto,
    fence?: ClaimFence<StatementView>,
  ): Promise<StatementView> {
    const found = await this.contractorsContract(contractId, 'draft_statement', fence);
    const person = currentActor({ requirePlatformUserId: true });
    const ruleIds = dto.deductions.map((entry) => entry.deductionRuleId);

    return this.prisma.transaction(async (tx) => {
      if (fence) await fence.hold(tx);
      const contract = await this.lockAsContractor(tx, found);
      this.assertSigned(contract, 'draft_statement');

      const rules = await this.repository.rulesInForce(tx, contract.organizationId, ruleIds);
      // In the order the request named them; every one a rule in force, or none is applied.
      const configured = ruleIds.flatMap((ruleId) => rules.filter((rule) => rule.id === ruleId));
      if (configured.length !== ruleIds.length) {
        throw this.rule(
          'draft_statement',
          'A deduction is applied only from a rule the employer has configured and keeps in force',
          'DEDUCTION_NOT_CONFIGURED',
          contract.id,
        );
      }
      const amounts = computeStatementAmounts(
        dto.lines.map((line) => BigInt(line.amountMinor)),
        configured.map((rule) => ({
          id: rule.id,
          name: rule.name,
          rateBp: rule.rateBp,
          base: rule.base,
        })),
      );
      if (typeof amounts === 'string') {
        throw this.rule(
          'draft_statement',
          amounts === 'STATEMENT_NET_NEGATIVE'
            ? 'The deductions would take more than the gross'
            : 'The lines sum past the largest amount that can be stored',
          amounts,
          contract.id,
        );
      }

      // Read under the lock, so a statement drafted later is never dated before an earlier number.
      const at = await databaseClock(tx);
      const statementNumber = await this.repository.nextNumber(
        tx,
        contract.organizationId,
        contract.id,
      );
      const statement = await this.repository.insert(tx, {
        id: newId(ID_PREFIX.statement),
        organizationId: contract.organizationId,
        contractId: contract.id,
        statementNumber,
        lines: dto.lines.map((line) => ({
          id: newId(ID_PREFIX.statementLine),
          description: line.description,
          amountMinor: BigInt(line.amountMinor),
        })),
        amounts,
        deductionIds: amounts.deductions.map(() => newId(ID_PREFIX.statementDeduction)),
        actor: person.userId,
        correlationId: getContext().correlationId,
        at,
      });
      await this.publisher.enqueue(tx, {
        eventName: 'STATEMENT_DRAFTED',
        aggregateId: contract.id,
        organizationId: contract.organizationId,
        occurredAt: at,
        payload: {
          contractId: contract.id,
          statementId: statement.id,
          statementNumber,
          organizationId: contract.organizationId,
          contractorOrganizationId: contract.contractorOrganizationId,
          draftedBy: person.userId,
          draftedAt: at.toISOString(),
        },
      });
      contractCommandsTotal.inc({
        service: SERVICE_NAME,
        command: 'draft_statement',
        outcome: 'drafted',
      });
      const view = toStatementView(statement, contract.contractorOrganizationId);
      return fence ? fence.complete(tx, view) : view;
    });
  }

  // -- shared ---------------------------------------------------------------------------

  /**
   * The contract named, found as a party (anyone else: `404`, not audited), and the caller the
   * contractor's person with the `CONTRACTOR` role. A party refused — the employer
   * (`403 AUTHOR_NOT_CONTRACTOR`, audited `NOT_CONTRACTOR`), the contractor's people without the
   * role (`403 INSUFFICIENT_ROLE`, audited `ROLE_NOT_PERMITTED`) — and the platform administrator
   * acting for a party (`PLATFORM_ADMINISTRATOR`) are recorded before they are answered, through
   * the request's `fence`: the same refusal repeated under the same key is recorded once.
   */
  private async contractorsContract(
    contractId: string,
    command: StatementCommand,
    fence: RefusalFence | undefined,
  ): Promise<Contract> {
    const acting = await this.refusals.commandingCaller(
      () => this.access.assertCanCommandStatements(),
      { action: 'DRAFT_STATEMENT', contractId, subjectId: null },
      fence,
    );
    const row = await this.contracts.findParty(acting.organizationId, contractId);
    const side = row ? sideOf(row, acting.organizationId) : null;
    if (!row || !side) throw RastaError.notFound('Contract', contractId);
    const refused = {
      action: 'DRAFT_STATEMENT',
      side,
      contractId: row.id,
      organizationId: row.organizationId,
      subjectId: null,
    } as const;
    if (side !== 'CONTRACTOR') {
      await this.refusals.refuse(
        { ...refused, reason: 'NOT_CONTRACTOR' },
        this.refused(
          command,
          forbiddenRefusal(
            'Only the contractor drafts a statement',
            'statement',
            ['AUTHOR_NOT_CONTRACTOR'],
            { contractId: row.id },
          ),
        ),
        fence,
      );
    }
    if (!this.access.isContractor()) {
      await this.refusals.refuse(
        { ...refused, reason: 'ROLE_NOT_PERMITTED' },
        this.refused(
          command,
          RastaError.insufficientRole([this.access.contractorRole()], getContext().roles),
        ),
        fence,
      );
    }
    return row;
  }

  /** The contract's row lock, and the caller still its contractor as it stands under the lock. */
  private async lockAsContractor(tx: ExtendedPrismaClient, found: Contract): Promise<Contract> {
    const contract = await this.contracts.lockContract(tx, found.organizationId, found.id);
    if (!contract || sideOf(contract, getContext().organizationId ?? '') !== 'CONTRACTOR') {
      throw RastaError.notFound('Contract', found.id);
    }
    return contract;
  }

  /** Statements are drafted on a SIGNED contract only (ADR-068 § 5). */
  private assertSigned(contract: Contract, command: StatementCommand): void {
    if (contract.status !== 'SIGNED') {
      throw this.rule(
        command,
        'Statements are drafted on a signed contract',
        'CONTRACT_NOT_SIGNED',
        contract.id,
      );
    }
  }

  private rule(
    command: StatementCommand,
    message: string,
    reason: ReasonOf<'statement'>,
    contractId: string,
  ): RastaError {
    return this.refused(command, ruleRefusal(message, 'statement', [reason], { contractId }));
  }

  /** Counts the refusal; the error is thrown by the caller. */
  private refused(command: StatementCommand, error: RastaError): RastaError {
    contractCommandsTotal.inc({ service: SERVICE_NAME, command, outcome: 'refused' });
    return error;
  }
}
