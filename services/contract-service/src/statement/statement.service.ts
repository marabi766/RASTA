import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@rasta/contracts';
import { RastaError, currentActor, getContext } from '@rasta/nest-common';
import type { Contract } from '../generated/prisma';
import { ContractAccess, assertPartyOf, sideOf } from '../access/access';
import { SERVICE_NAME } from '../config/env';
import { ContractRepository } from '../contract/contract.repository';
import type { CursorPage } from '../contract/dto';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { contractCommandsTotal } from '../observability/metrics';
import { OrganizationDirectory } from '../organization/organization-directory';
import { UNION_ROLE } from '../policy/policy.access';
import { PolicyRepository, type PolicyWithSteps } from '../policy/policy.repository';
import {
  CHAIN_WORKFLOW,
  STATEMENT_CHAINS,
  type StatementChain,
} from '../policy/policy.state-machine';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { databaseClock } from '../shared/clock';
import type { ClaimFence, RefusalFence } from '../shared/idempotency';
import { forbiddenRefusal, refusal, ruleRefusal, type ReasonOf } from '../shared/refusal';
import { AuthorityRefusals } from '../signing/authority-refusals';
import { computeStatementAmounts } from './amounts';
import { snapshotChains } from './approval-chains';
import type {
  DraftStatementDto,
  ListStatementsQuery,
  StatementView,
  SubmitStatementDto,
} from './dto';
import { StatementRepository } from './statement.repository';
import { statementTransitionFor, type StatementStateName } from './statement.state-machine';
import { toStatementView } from './views';

type StatementCommand = 'draft_statement' | 'submit_statement';

/** The refusal audit's closed action for each command (`CONTRACT_AUTHORITY_REFUSED`). */
const AUDITED_ACTION = {
  draft_statement: 'DRAFT_STATEMENT',
  submit_statement: 'SUBMIT_STATEMENT',
} as const satisfies Record<StatementCommand, string>;

/** The policy in force for each chain, as read before the submission's transaction. */
type ChainPolicies = Record<StatementChain, PolicyWithSteps | null>;

/**
 * A signed contract's statements (ADR-068 § 5; CON-003 PR 4 and 5): the contractor drafts one — its
 * lines, each optionally against a milestone of the contract, and the configured deductions it
 * applies — and submits it, which snapshots both approval chains; both parties read them, and so
 * does an organization a step of its chains names. The decisions are `StatementDecisionService`'s.
 *
 * Built like the amendment and milestone commands:
 *
 * - **Object-level authorization first.** The contract is found as a party; anyone else gets the
 *   `404` a missing contract gets (S-03), and nothing is audited. Only then is the side judged —
 *   the contractor drafts and submits, the employer is `403 AUTHOR_NOT_CONTRACTOR` — and then the
 *   `CONTRACTOR` role. A party's refusal, and the platform administrator's acting for a party, is
 *   recorded (`CONTRACT_AUTHORITY_REFUSED`, `DRAFT_STATEMENT` / `SUBMIT_STATEMENT`) through the
 *   request's idempotency fence, as for the other commands; when it cannot be recorded the answer
 *   is a retryable `503`.
 * - **One lock, then the state.** The contract's row lock is taken first, and everything is decided
 *   under it: the contract still SIGNED, the deduction rules still in force, and the next number,
 *   so two drafts at once get two consecutive numbers (`ux_statement_number` is the backstop).
 * - **Money is computed once** (`computeStatementAmounts`): bigint, `net = gross − Σ deductions`,
 *   each deduction the configured rate of the gross; the database checks the same at commit.
 * - **Deductions only from configuration** (Q-96 (6)): a rule id that is not one the employer keeps
 *   in force is `422 DEDUCTION_NOT_CONFIGURED`; with none applied the net is the gross.
 * - **Submission snapshots both chains, whole, or nothing** (ADR-068 § 5, Q-96 (1)): the
 *   policies in force for `contract.statement.technical` and `contract.statement.financial`, read
 *   under their slots' locks, each reduced to the steps that apply to the gross; no policy, or no
 *   step that applies, is `422` — the platform never approves by default. The transition, the
 *   snapshot, the milestones it marks referenced and the event commit together; the database checks
 *   the snapshot at commit (`statement_submission_consistent`).
 * - **Every state change has its event in the same transaction** (`STATEMENT_DRAFTED`,
 *   `STATEMENT_SUBMITTED`): identifiers only, no amount (Q-97 (2)).
 */
@Injectable()
export class StatementService {
  constructor(
    private readonly repository: StatementRepository,
    private readonly contracts: ContractRepository,
    private readonly policies: PolicyRepository,
    private readonly directory: OrganizationDirectory,
    private readonly refusals: AuthorityRefusals,
    private readonly access: ContractAccess,
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
  ) {}

  // -- reads ----------------------------------------------------------------------------

  /**
   * One statement, for a party to its contract — or, failing that, for an organization a step of its
   * approval chains names, acting with that step's role (CON-003 PR 6): an approver reads what it
   * decides, whether or not it is a party, and only that statement — never the contract, the other
   * statements or the list. Anyone else gets the party read's refusal: `404`, or the `403` a caller
   * with no reading role gets before anything is looked up.
   */
  async get(contractId: string, statementId: string): Promise<StatementView> {
    let refusal: RastaError;
    try {
      const contract = await this.readableContract(contractId);
      const row = await this.repository.findOne(contract.organizationId, contract.id, statementId);
      if (row) return toStatementView(row, contract.contractorOrganizationId);
      refusal = RastaError.notFound('Statement', statementId);
    } catch (error) {
      if (!(error instanceof RastaError)) throw error;
      refusal = error;
    }
    const reader = this.access.approverReader();
    const approver = reader
      ? await this.repository.findAsApprover(
          reader.organizationId,
          reader.roles,
          contractId,
          statementId,
        )
      : null;
    if (approver) {
      return toStatementView(approver.statement, approver.contract.contractorOrganizationId);
    }
    throw refusal;
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

  /** Whether the caller may still read this statement — as a party or as its approver (a decision's replay). */
  async assertStatementVisible(contractId: string, statementId: string): Promise<void> {
    await this.get(contractId, statementId);
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
    const found = await this.contractorsContract(contractId, 'draft_statement', null, fence);
    const person = currentActor({ requirePlatformUserId: true });
    const ruleIds = dto.deductions.map((entry) => entry.deductionRuleId);
    const milestoneIds = [
      ...new Set(dto.lines.flatMap((line) => (line.milestoneId ? [line.milestoneId] : []))),
    ];

    return this.prisma.transaction(async (tx) => {
      if (fence) await fence.hold(tx);
      const contract = await this.lockAsContractor(tx, found);
      this.assertSigned(contract, 'draft_statement');

      // A line is against a milestone of this contract or none (Q-100 (4)); the database checks the
      // same (`ck_statement_line_milestone`).
      const milestones = await this.repository.milestonesOf(
        tx,
        contract.organizationId,
        contract.id,
        milestoneIds,
      );
      if (milestones.length !== milestoneIds.length) {
        throw this.rule(
          'draft_statement',
          'A line refers only to a planned milestone of this contract',
          'MILESTONE_NOT_OF_CONTRACT',
          contract.id,
        );
      }

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
          milestoneId: line.milestoneId ?? null,
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

  // -- submit ---------------------------------------------------------------------------

  /**
   * The contractor submits a draft (`DRAFT → SUBMITTED`), recording who, with their stable identity,
   * and snapshotting both approval chains from the policies in force — in one transaction with the
   * transition, the milestones its lines refer to and `STATEMENT_SUBMITTED`.
   *
   * The policies are read twice. First outside any transaction, to ask organization-service whether
   * the union that wrote each union-written one still governs the employer (Q-70 (7): asked again
   * whenever an approval round opens; "no" is `422 POLICY_AUTHOR_NOT_GOVERNING`, "could not
   * confirm" an upstream error — never a submission). Then under the locks — the contract's row,
   * the statement's row, then each chain's policy slot (`PolicyRepository.lockPolicySlot`, the one
   * lock order), so no policy of either chain is put in force or retired until this commits. A
   * policy in force under the lock that is not the one confirmed is `409 CONFLICT`: nothing was
   * written and the caller retries, so no chain is ever snapshotted from a policy whose author was
   * not asked about.
   */
  async submit(
    contractId: string,
    statementId: string,
    dto: SubmitStatementDto,
    fence?: ClaimFence<StatementView>,
  ): Promise<StatementView> {
    const found = await this.contractorsContract(
      contractId,
      'submit_statement',
      statementId,
      fence,
    );
    const person = currentActor({ requirePlatformUserId: true });
    if (person.issuer === null || person.subject === null) {
      throw this.refused(
        'submit_statement',
        refusal(
          ERROR_CODES.ACTOR_IDENTITY_UNKNOWN,
          'The submitter names no stable identity, so no approval could be kept from them',
          'statement',
          ['ACTOR_IDENTITY_UNKNOWN'],
          { contractId: found.id },
        ),
      );
    }
    const submitter = { userId: person.userId, issuer: person.issuer, subject: person.subject };
    const confirmed = await this.confirmedChainPolicies(found);

    return this.prisma.transaction(async (tx) => {
      if (fence) await fence.hold(tx);
      const contract = await this.lockAsContractor(tx, found);
      const statement = await this.repository.lock(
        tx,
        contract.organizationId,
        contract.id,
        statementId,
      );
      if (!statement) throw RastaError.notFound('Statement', statementId);
      this.assertSigned(contract, 'submit_statement');
      if (!statementTransitionFor(statement.status as StatementStateName, 'submit')) {
        throw this.rule(
          'submit_statement',
          'Only a draft statement is submitted',
          'STATEMENT_NOT_DRAFT',
          contract.id,
        );
      }
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== statement.version) {
        throw RastaError.optimisticLockFailed('Statement', statement.id);
      }

      // Technical, then financial: every submission takes the two slots in the same order.
      const inForce: ChainPolicies = { TECHNICAL: null, FINANCIAL: null };
      for (const chain of STATEMENT_CHAINS) {
        await this.policies.lockPolicySlot(tx, contract.organizationId, CHAIN_WORKFLOW[chain]);
        inForce[chain] = await this.policies.findActivePolicyOf(
          tx,
          contract.organizationId,
          CHAIN_WORKFLOW[chain],
        );
        if ((inForce[chain]?.id ?? null) !== (confirmed[chain]?.id ?? null)) {
          throw new RastaError(
            'CONFLICT',
            'An approval policy of this statement was put in force or taken out of force at the ' +
              'same time; nothing was submitted. Retry',
            { internalContext: { chain, statementId: statement.id } },
          );
        }
      }
      const snapshot = snapshotChains(
        inForce,
        statement.grossMinor,
        contract.contractorOrganizationId,
      );
      if (!snapshot.ok) {
        throw this.refused(
          'submit_statement',
          ruleRefusal(
            'The employer’s approval policies give this statement no complete approval chain; ' +
              'the platform never approves by default',
            'statement',
            snapshot.refusals,
            { contractId: contract.id, statementId: statement.id },
          ),
        );
      }

      // Read under the locks: never before a draft or a policy change that held them first.
      const at = await databaseClock(tx);
      const moved = await this.repository.submit(tx, {
        organizationId: contract.organizationId,
        id: statement.id,
        version: statement.version,
        person: submitter,
        technicalStepCount: snapshot.chains.TECHNICAL.steps.length,
        financialStepCount: snapshot.chains.FINANCIAL.steps.length,
        at,
      });
      if (!moved) throw RastaError.optimisticLockFailed('Statement', statement.id);
      await this.repository.insertApprovalSteps(
        tx,
        statement,
        STATEMENT_CHAINS.flatMap((chain) =>
          snapshot.chains[chain].steps.map((step) => ({
            id: newId(ID_PREFIX.statementApprovalStep),
            chain,
            stepOrder: step.stepOrder,
            policyId: snapshot.chains[chain].policyId,
            policyVersion: snapshot.chains[chain].policyVersion,
            authorityOrganizationId: step.authorityOrganizationId,
            authorityRole: step.authorityRole,
            authorityLabel: step.authorityLabel,
          })),
        ),
        at,
      );
      const milestoneIds = [
        ...new Set(statement.lines.flatMap((line) => (line.milestoneId ? [line.milestoneId] : []))),
      ].sort();
      await this.repository.markMilestonesReferenced(
        tx,
        contract.organizationId,
        contract.id,
        milestoneIds,
        at,
      );
      await this.publisher.enqueue(tx, {
        eventName: 'STATEMENT_SUBMITTED',
        aggregateId: contract.id,
        organizationId: contract.organizationId,
        occurredAt: at,
        payload: {
          contractId: contract.id,
          statementId: statement.id,
          statementNumber: statement.statementNumber,
          organizationId: contract.organizationId,
          contractorOrganizationId: contract.contractorOrganizationId,
          technicalPolicyId: snapshot.chains.TECHNICAL.policyId,
          technicalPolicyVersion: snapshot.chains.TECHNICAL.policyVersion,
          financialPolicyId: snapshot.chains.FINANCIAL.policyId,
          financialPolicyVersion: snapshot.chains.FINANCIAL.policyVersion,
          milestoneIds,
          submittedBy: submitter.userId,
          submittedAt: at.toISOString(),
        },
      });
      contractCommandsTotal.inc({
        service: SERVICE_NAME,
        command: 'submit_statement',
        outcome: 'submitted',
      });
      const submitted = await this.repository.findOne(
        contract.organizationId,
        contract.id,
        statement.id,
        tx,
      );
      if (!submitted) throw RastaError.notFound('Statement', statement.id);
      const view = toStatementView(submitted, contract.contractorOrganizationId);
      return fence ? fence.complete(tx, view) : view;
    });
  }

  /**
   * The policy in force for each chain, with the union that wrote each union-written one confirmed
   * by organization-service to govern the employer still (Q-70 (7)). A platform-written policy needs
   * no hierarchy. Read outside any transaction: the question holds no lock while it waits.
   */
  private async confirmedChainPolicies(contract: Contract): Promise<ChainPolicies> {
    const policies: ChainPolicies = { TECHNICAL: null, FINANCIAL: null };
    for (const chain of STATEMENT_CHAINS) {
      policies[chain] = await this.policies.findActivePolicyOf(
        this.prisma.client,
        contract.organizationId,
        CHAIN_WORKFLOW[chain],
      );
    }
    const unions = [
      ...new Set(
        Object.values(policies).flatMap((policy) =>
          policy && policy.authorRole === UNION_ROLE ? [policy.authorOrganizationId] : [],
        ),
      ),
    ];
    const answers = await Promise.all(
      unions.map((union) => this.directory.isWithin(union, contract.organizationId)),
    );
    if (answers.some((within) => !within)) {
      throw this.rule(
        'submit_statement',
        'The union that wrote an approval policy of this statement no longer governs the employer',
        'POLICY_AUTHOR_NOT_GOVERNING',
        contract.id,
      );
    }
    return policies;
  }

  // -- shared ---------------------------------------------------------------------------

  /**
   * The contract named, found as a party (anyone else: `404`, not audited), and the caller the
   * contractor's person with the `CONTRACTOR` role. A party refused — the employer
   * (`403 AUTHOR_NOT_CONTRACTOR`, audited `NOT_CONTRACTOR`), the contractor's people without the
   * role (`403 INSUFFICIENT_ROLE`, audited `ROLE_NOT_PERMITTED`) — and the platform administrator
   * acting for a party (`PLATFORM_ADMINISTRATOR`) are recorded before they are answered, through
   * the request's `fence`: the same refusal repeated under the same key is recorded once.
   * `subjectId` is the statement a submission names (null for a draft, which names none yet).
   */
  private async contractorsContract(
    contractId: string,
    command: StatementCommand,
    subjectId: string | null,
    fence: RefusalFence | undefined,
  ): Promise<Contract> {
    const action = AUDITED_ACTION[command];
    const acting = await this.refusals.commandingCaller(
      () => this.access.assertCanCommandStatements(),
      { action, contractId, subjectId },
      fence,
    );
    const row = await this.contracts.findParty(acting.organizationId, contractId);
    const side = row ? sideOf(row, acting.organizationId) : null;
    if (!row || !side) throw RastaError.notFound('Contract', contractId);
    const refused = {
      action,
      side,
      contractId: row.id,
      organizationId: row.organizationId,
      subjectId,
    } as const;
    if (side !== 'CONTRACTOR') {
      await this.refusals.refuse(
        { ...refused, reason: 'NOT_CONTRACTOR' },
        this.refused(
          command,
          forbiddenRefusal(
            command === 'draft_statement'
              ? 'Only the contractor drafts a statement'
              : 'Only the contractor submits a statement',
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

  /** Statements are drafted and submitted on a SIGNED contract only (ADR-068 § 5). */
  private assertSigned(contract: Contract, command: StatementCommand): void {
    if (contract.status !== 'SIGNED') {
      throw this.rule(
        command,
        'Statements are drafted and submitted on a signed contract',
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
