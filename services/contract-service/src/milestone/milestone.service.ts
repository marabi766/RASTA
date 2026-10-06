import { Inject, Injectable } from '@nestjs/common';
import { RastaError, currentActor, getContext } from '@rasta/nest-common';
import type { Contract } from '../generated/prisma';
import { ContractAccess, assertPartyOf, sideOf, type ContractSideName } from '../access/access';
import { SERVICE_NAME, type ContractEnv } from '../config/env';
import { ContractRepository } from '../contract/contract.repository';
import type { CursorPage } from '../contract/dto';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { contractCommandsTotal } from '../observability/metrics';
import { PrismaService } from '../prisma/prisma.service';
import { transactionNow } from '../shared/clock';
import type { ClaimFence } from '../shared/idempotency';
import { forbiddenRefusal, ruleRefusal } from '../shared/refusal';
import { AuthorityRefusals } from '../signing/authority-refusals';
import { ENV } from '../tokens';
import type { ChangeMilestoneDto, MilestoneView, PlanMilestoneDto } from './dto';
import { MilestoneRepository } from './milestone.repository';
import { dayOf, toMilestoneView } from './views';

type MilestoneCommand = 'plan_milestone' | 'change_milestone';

/**
 * A contract's planned milestones (ADR-068 § 9; CON-003 PR 3): the employer plans and edits them
 * on a SIGNED contract while no statement refers to them; both parties read them.
 *
 * Built like the amendment commands, without the signatures: the contract is found as a party
 * first (a stranger gets the `404` of a missing contract and nothing is audited), the employer's
 * role is judged next — a refusal of a party is audited (`CONTRACT_AUTHORITY_REFUSED`) — and
 * everything else is decided under the contract's row lock, in the transaction that writes the
 * change and its event.
 *
 * A milestone a statement refers to is frozen: `first_referenced_at` is set by the statement
 * change of PR 4, never here, and the database refuses to change a referenced milestone as well as
 * this class does (`MILESTONE_REFERENCED`). A milestone is never deleted (Q-100).
 */
@Injectable()
export class MilestoneService {
  constructor(
    private readonly repository: MilestoneRepository,
    private readonly contracts: ContractRepository,
    private readonly refusals: AuthorityRefusals,
    private readonly access: ContractAccess,
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
    @Inject(ENV) private readonly env: ContractEnv,
  ) {}

  // -- reads ----------------------------------------------------------------------------

  async get(contractId: string, milestoneId: string): Promise<MilestoneView> {
    const contract = await this.readableContract(contractId);
    const row = await this.repository.findOne(contract.organizationId, contract.id, milestoneId);
    if (!row) throw RastaError.notFound('Milestone', milestoneId);
    return toMilestoneView(row);
  }

  /** The contract's plan in the order it is carried out. At most CONTRACT_MILESTONE_LIMIT, so one page. */
  async list(contractId: string): Promise<CursorPage<MilestoneView>> {
    const contract = await this.readableContract(contractId);
    const rows = await this.repository.list(contract.organizationId, contract.id);
    return { items: rows.map(toMilestoneView), nextCursor: null, hasMore: false };
  }

  /** Whether the caller may still see this contract's milestones (replay of a command). */
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

  // -- plan -----------------------------------------------------------------------------

  /** The employer plans a milestone on a SIGNED contract. */
  async plan(
    contractId: string,
    dto: PlanMilestoneDto,
    fence?: ClaimFence<MilestoneView>,
  ): Promise<MilestoneView> {
    const acting = this.access.assertCanCommandAmendments();
    const row = await this.contracts.findParty(acting.organizationId, contractId);
    const side = row ? sideOf(row, acting.organizationId) : null;
    if (!row || !side) throw RastaError.notFound('Contract', contractId);
    await this.assertMayEdit(row, side, 'PLAN_MILESTONE', null, 'plan_milestone');
    const person = currentActor({ requirePlatformUserId: true });

    return this.prisma.transaction(async (tx) => {
      if (fence) await fence.hold(tx);
      const contract = await this.contracts.lockContract(tx, row.organizationId, row.id);
      if (!contract || sideOf(contract, acting.organizationId) !== 'EMPLOYER') {
        throw RastaError.notFound('Contract', contractId);
      }
      this.assertSigned(contract, 'plan_milestone');
      if (
        (await this.repository.count(tx, contract.organizationId, contract.id)) >=
        this.env.CONTRACT_MILESTONE_LIMIT
      ) {
        throw this.refused(
          'plan_milestone',
          ruleRefusal('This contract holds as many milestones as it may', 'milestone', [
            'MILESTONE_LIMIT_REACHED',
          ]),
        );
      }
      const at = await transactionNow(tx);
      const milestone = await this.repository.insert(tx, {
        id: newId(ID_PREFIX.milestone),
        organizationId: contract.organizationId,
        contractId: contract.id,
        title: dto.title,
        plannedDate: dto.plannedDate,
        plannedShareBp: dto.plannedShareBp ?? null,
        actor: person.userId,
        correlationId: getContext().correlationId,
        at,
      });
      await this.publisher.enqueue(tx, {
        eventName: 'CONTRACT_MILESTONE_PLANNED',
        aggregateId: contract.id,
        organizationId: contract.organizationId,
        occurredAt: at,
        payload: {
          contractId: contract.id,
          milestoneId: milestone.id,
          organizationId: contract.organizationId,
          contractorOrganizationId: contract.contractorOrganizationId,
          plannedBy: person.userId,
          plannedAt: at.toISOString(),
        },
      });
      contractCommandsTotal.inc({
        service: SERVICE_NAME,
        command: 'plan_milestone',
        outcome: 'planned',
      });
      const view = toMilestoneView(milestone);
      return fence ? fence.complete(tx, view) : view;
    });
  }

  // -- change ---------------------------------------------------------------------------

  /**
   * The employer edits a milestone no statement refers to. A change that changes nothing answers
   * with the milestone as it is and writes nothing — no version, no event.
   */
  async change(
    contractId: string,
    milestoneId: string,
    dto: ChangeMilestoneDto,
    fence?: ClaimFence<MilestoneView>,
  ): Promise<MilestoneView> {
    const acting = this.access.assertCanCommandAmendments();
    const row = await this.contracts.findParty(acting.organizationId, contractId);
    const side = row ? sideOf(row, acting.organizationId) : null;
    if (!row || !side) throw RastaError.notFound('Contract', contractId);
    await this.assertMayEdit(row, side, 'CHANGE_MILESTONE', milestoneId, 'change_milestone');
    const person = currentActor({ requirePlatformUserId: true });

    return this.prisma.transaction(async (tx) => {
      if (fence) await fence.hold(tx);
      const contract = await this.contracts.lockContract(tx, row.organizationId, row.id);
      if (!contract || sideOf(contract, acting.organizationId) !== 'EMPLOYER') {
        throw RastaError.notFound('Contract', contractId);
      }
      const milestone = await this.repository.lock(
        tx,
        contract.organizationId,
        contract.id,
        milestoneId,
      );
      if (!milestone) throw RastaError.notFound('Milestone', milestoneId);

      if (milestone.firstReferencedAt !== null) {
        throw this.refused(
          'change_milestone',
          ruleRefusal('A milestone a statement refers to is never changed', 'milestone', [
            'MILESTONE_REFERENCED',
          ]),
        );
      }
      this.assertSigned(contract, 'change_milestone');
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== milestone.version) {
        throw RastaError.optimisticLockFailed('Milestone', milestone.id);
      }

      const titleChanged = dto.title !== undefined && dto.title !== milestone.title;
      const dateChanged =
        dto.plannedDate !== undefined && dto.plannedDate !== dayOf(milestone.plannedDate);
      const shareChanged =
        dto.plannedShareBp !== undefined && dto.plannedShareBp !== milestone.plannedShareBp;
      if (!titleChanged && !dateChanged && !shareChanged) {
        contractCommandsTotal.inc({
          service: SERVICE_NAME,
          command: 'change_milestone',
          outcome: 'unchanged',
        });
        const view = toMilestoneView(milestone);
        return fence ? fence.complete(tx, view) : view;
      }

      const at = await transactionNow(tx);
      const changed = await this.repository.change(tx, {
        organizationId: contract.organizationId,
        contractId: contract.id,
        id: milestone.id,
        version: milestone.version,
        ...(titleChanged ? { title: dto.title as string } : {}),
        ...(dateChanged ? { plannedDate: dto.plannedDate as string } : {}),
        ...(shareChanged ? { plannedShareBp: dto.plannedShareBp as number | null } : {}),
        actor: person.userId,
        at,
      });
      if (!changed) throw RastaError.optimisticLockFailed('Milestone', milestone.id);
      await this.publisher.enqueue(tx, {
        eventName: 'CONTRACT_MILESTONE_CHANGED',
        aggregateId: contract.id,
        organizationId: contract.organizationId,
        occurredAt: at,
        payload: {
          contractId: contract.id,
          milestoneId: milestone.id,
          organizationId: contract.organizationId,
          contractorOrganizationId: contract.contractorOrganizationId,
          version: milestone.version + 1,
          changedBy: person.userId,
          changedAt: at.toISOString(),
        },
      });
      contractCommandsTotal.inc({
        service: SERVICE_NAME,
        command: 'change_milestone',
        outcome: 'changed',
      });
      const view = toMilestoneView({
        ...milestone,
        ...(titleChanged ? { title: dto.title as string } : {}),
        ...(dateChanged
          ? { plannedDate: new Date(`${dto.plannedDate as string}T00:00:00.000Z`) }
          : {}),
        ...(shareChanged ? { plannedShareBp: dto.plannedShareBp as number | null } : {}),
        updatedAt: at,
        updatedBy: person.userId,
        version: milestone.version + 1,
      });
      return fence ? fence.complete(tx, view) : view;
    });
  }

  // -- shared ---------------------------------------------------------------------------

  /**
   * The employer's people with a role `CONTRACT_MILESTONE_ROLES` names plan and edit; a party that
   * is not allowed is refused — and audited.
   */
  private async assertMayEdit(
    contract: Contract,
    side: ContractSideName,
    action: 'PLAN_MILESTONE' | 'CHANGE_MILESTONE',
    subjectId: string | null,
    command: MilestoneCommand,
  ): Promise<void> {
    const base = {
      action,
      side,
      contractId: contract.id,
      organizationId: contract.organizationId,
      subjectId,
    } as const;
    if (side !== 'EMPLOYER') {
      await this.refusals.refuse(
        { ...base, reason: 'NOT_EMPLOYER' },
        this.refused(
          command,
          forbiddenRefusal('Only the employer plans or changes a milestone', 'milestone', [
            'EDITOR_NOT_EMPLOYER',
          ]),
        ),
      );
    }
    if (!this.access.mayPlanMilestones()) {
      await this.refusals.refuse(
        { ...base, reason: 'ROLE_NOT_PERMITTED' },
        this.refused(
          command,
          RastaError.insufficientRole(this.access.milestoneRoles(), getContext().roles),
        ),
      );
    }
  }

  /** Milestones are planned on a SIGNED contract only. */
  private assertSigned(contract: Contract, command: MilestoneCommand): void {
    if (contract.status !== 'SIGNED') {
      throw this.refused(
        command,
        ruleRefusal(
          'Milestones are planned and changed on a signed contract',
          'milestone',
          ['CONTRACT_NOT_SIGNED'],
          { contractId: contract.id },
        ),
      );
    }
  }

  /** Counts the refusal; the error is thrown by the caller. */
  private refused(command: MilestoneCommand, error: RastaError): RastaError {
    contractCommandsTotal.inc({ service: SERVICE_NAME, command, outcome: 'refused' });
    return error;
  }
}
