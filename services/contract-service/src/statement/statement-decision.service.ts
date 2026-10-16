import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@rasta/contracts';
import { RastaError, currentActor, getContext } from '@rasta/nest-common';
import type { Contract } from '../generated/prisma';
import { ContractAccess, sideOf } from '../access/access';
import { SERVICE_NAME } from '../config/env';
import { ContractRepository } from '../contract/contract.repository';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { contractCommandsTotal } from '../observability/metrics';
import type { StatementChain } from '../policy/policy.state-machine';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { databaseClock } from '../shared/clock';
import type { ClaimFence } from '../shared/idempotency';
import { forbiddenRefusal, refusal, ruleRefusal, type ReasonOf } from '../shared/refusal';
import { storedActor } from '../shared/stable-actor';
import { AuthorityRefusals, type AuthorityRefusal } from '../signing/authority-refusals';
import {
  judgeStep,
  separationOf,
  withinApprovedCap,
  type DecisionOutcome,
  type StepRefusal,
} from './decisions';
import type { DecideStatementDto, StatementView } from './dto';
import { StatementRepository } from './statement.repository';
import type { StatementStateName } from './statement.state-machine';
import { toStatementView } from './views';

const COMMAND = 'decide_statement';

/** A person, with the stable identity a separation of duties compares. */
interface Decider {
  readonly userId: string;
  readonly issuer: string;
  readonly subject: string;
}

/** Who the caller is to the statement: a party, or an organization its chains name. */
type DeciderSide = AuthorityRefusal['side'];

/**
 * A decision refused for want of authority or for separation of duties, thrown from inside the
 * decision's transaction — which rolls back — and recorded once it has (`AuthorityRefusals`).
 */
class DecisionRefused extends Error {
  constructor(
    readonly refused: AuthorityRefusal,
    readonly answer: RastaError,
  ) {
    super('The decision was refused for want of authority or for separation of duties');
  }
}

/** The answer to each refusal of the statement's state: answered, never audited. */
const STEP_REFUSALS: Readonly<Record<StepRefusal, { message: string; conflict?: true }>> = {
  STATEMENT_NOT_SUBMITTED: { message: 'A draft statement is not decided: it is submitted first' },
  STATEMENT_DECIDED: { message: 'An approved or rejected statement is never decided again' },
  STEP_NOT_IN_CHAIN: { message: 'The statement’s approval chains have no such step' },
  STEP_DECIDED: { message: 'This step has already been decided', conflict: true },
  CHAIN_NOT_OPEN: {
    message: 'The financial chain opens only once the technical chain is approved',
  },
  STEP_NOT_NEXT: { message: 'An earlier step of this chain is still undecided' },
};

/**
 * The decisions on a submitted statement's two approval chains (ADR-068 § 5; CON-003 PR 6).
 *
 * - **Object-level authorization first.** The statement is found, by the contract and statement
 *   ids, only for a party to its contract or an organization one of its chain's steps names — a
 *   supervising consultant, say (Q-96 (1)). Anyone else gets the `404` a missing contract gets
 *   (S-03), and nothing is audited. The platform administrator never decides.
 * - **One lock, then the state.** The contract's row lock first — the one every command of a
 *   contract takes — then the statement's; everything else is judged under them: the contract still
 *   SIGNED, the named step the next undecided step of the open chain (`judgeStep`: technical, then
 *   financial, Q-96 (2)), and the version. Two approvers of one step racing are ordered by the lock:
 *   the second is told the step was decided (`409`).
 * - **Authority is the snapshot's.** The step names an organization and a role: the caller acts for
 *   that organization and holds that role, or the decision is refused (`403`, audited). A policy
 *   changed since the submission changes nothing (ADR-068 § 5).
 * - **Separation of duties** (Q-96 (3), #188): never a member of the contractor's organization;
 *   never the submitter; at most once per statement across both chains — compared on the stable
 *   identity (`separationOf` → `compareActors`). A pair that cannot be told apart is
 *   `422 ACTOR_IDENTITY_UNKNOWN`. Each is audited; the database holds the same
 *   (`statement_decision_guard`, `ux_statement_decision_person`).
 * - **The financial chain's last approval** makes the statement APPROVED and immutable, and adds its
 *   gross to the contract's `approved_total_minor` under the contract's row lock: past the price and
 *   the effective amendments — judged in bigint first, the largest bigint included
 *   (`withinApprovedCap`), and held by the database's `ck_contract_approved_cap` — the decision
 *   is `422 APPROVED_TOTAL_EXCEEDS_CAP` with nothing written (Q-96 (5)). A rejection, at any step,
 *   is final for that number (Q-96 (7)). No timer and no default: a step waits (ADR-043).
 * - **Every decision has its event in the same transaction** (`STATEMENT_DECISION_RECORDED`, and
 *   `STATEMENT_TECHNICALLY_APPROVED`, `STATEMENT_APPROVED` or `STATEMENT_REJECTED` with a
 *   transition): identifiers only, no amount (Q-97 (2)). Approval is a fact, not a payment
 *   (ADR-068 § 6): nothing here moves money.
 */
@Injectable()
export class StatementDecisionService {
  constructor(
    private readonly repository: StatementRepository,
    private readonly contracts: ContractRepository,
    private readonly refusals: AuthorityRefusals,
    private readonly access: ContractAccess,
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
  ) {}

  async decide(
    contractId: string,
    statementId: string,
    dto: DecideStatementDto,
    fence?: ClaimFence<StatementView>,
  ): Promise<StatementView> {
    const outcome: DecisionOutcome = dto.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const action = dto.decision === 'APPROVE' ? 'APPROVE_STATEMENT' : 'REJECT_STATEMENT';
    const acting = await this.refusals.commandingCaller(
      () => this.access.assertCanDecideStatements(),
      { action, contractId, subjectId: statementId },
      fence,
    );

    // A party, or an organization the statement's chains name; anyone else is told nothing exists.
    const party = await this.contracts.findParty(acting.organizationId, contractId);
    const found = await this.repository.findDecidable(contractId, statementId);
    const named =
      found?.statement.approvalSteps.some(
        (step) => step.authorityOrganizationId === acting.organizationId,
      ) ?? false;
    const side: DeciderSide | null = party
      ? sideOf(party, acting.organizationId)
      : named
        ? 'APPROVER'
        : null;
    if (!side) throw RastaError.notFound('Contract', contractId);
    if (!found) throw RastaError.notFound('Statement', statementId);
    const { contract } = found;
    const refused = {
      action,
      side,
      contractId: contract.id,
      organizationId: contract.organizationId,
      subjectId: found.statement.id,
    } as const;
    const context = { contractId: contract.id, statementId: found.statement.id };

    // Separation of duties that needs no lock: a member of the contractor's organization is judging
    // its own organization's claim, whichever organization it acts for.
    if (side !== 'CONTRACTOR' && this.access.isMemberOf(contract.contractorOrganizationId)) {
      return this.refusals.refuse(
        { ...refused, reason: 'MEMBER_OF_CONTRACTOR' },
        this.refused(
          forbiddenRefusal(
            'Separation of duties: a member of the contractor’s organization does not decide its statement',
            'decision',
            ['MEMBER_OF_CONTRACTOR'],
            context,
          ),
        ),
        fence,
      );
    }
    // A person, with an identity that can be compared to the submitter's and the other deciders'.
    const person = currentActor({ requirePlatformUserId: true });
    if (person.issuer === null || person.subject === null) {
      return this.refusals.refuse(
        { ...refused, reason: 'ACTOR_IDENTITY_UNKNOWN' },
        this.identityUnknown(context),
        fence,
      );
    }
    const decider: Decider = {
      userId: person.userId,
      issuer: person.issuer,
      subject: person.subject,
    };

    try {
      return await this.prisma.transaction(async (tx) => {
        if (fence) await fence.hold(tx);
        const view = await this.decideLocked(tx, contract, found.statement.id, {
          acting: acting.organizationId,
          decider,
          dto,
          outcome,
          refused,
        });
        return fence ? fence.complete(tx, view) : view;
      });
    } catch (error) {
      if (!(error instanceof DecisionRefused)) throw error;
      return this.refusals.refuse(error.refused, error.answer, fence);
    }
  }

  private async decideLocked(
    tx: ExtendedPrismaClient,
    found: Contract,
    statementId: string,
    input: {
      acting: string;
      decider: Decider;
      dto: DecideStatementDto;
      outcome: DecisionOutcome;
      refused: Omit<AuthorityRefusal, 'reason'>;
    },
  ): Promise<StatementView> {
    const { decider, dto, outcome, refused } = input;
    const contract = await this.contracts.lockContract(tx, found.organizationId, found.id);
    if (!contract) throw RastaError.notFound('Contract', found.id);
    const statement = await this.repository.lock(
      tx,
      contract.organizationId,
      contract.id,
      statementId,
    );
    if (!statement) throw RastaError.notFound('Statement', statementId);
    const context = { contractId: contract.id, statementId: statement.id };

    if (contract.status !== 'SIGNED') {
      throw this.refused(
        ruleRefusal(
          'Statements are decided on a signed contract',
          'decision',
          ['CONTRACT_NOT_SIGNED'],
          context,
        ),
      );
    }
    const from = statement.status as StatementStateName;
    const judged = judgeStep(
      from,
      statement.approvalSteps.map((step) => ({ ...step, chain: step.chain as StatementChain })),
      statement.decisions.map((decision) => ({
        chain: decision.chain as StatementChain,
        stepOrder: decision.stepOrder,
        outcome: decision.outcome as DecisionOutcome,
      })),
      { chain: dto.chain, stepOrder: dto.stepOrder },
      outcome,
    );
    if (!judged.ok) {
      const answer = STEP_REFUSALS[judged.reason];
      throw this.refused(
        answer.conflict
          ? refusal(ERROR_CODES.CONFLICT, answer.message, 'decision', [judged.reason], context)
          : ruleRefusal(answer.message, 'decision', [judged.reason], context),
      );
    }
    if (dto.expectedVersion !== undefined && dto.expectedVersion !== statement.version) {
      throw RastaError.optimisticLockFailed('Statement', statement.id);
    }

    // The step's authority, as the snapshot names it: the organization, then the role.
    const { step } = judged;
    if (step.authorityOrganizationId !== input.acting) {
      throw new DecisionRefused(
        { ...refused, reason: 'NOT_STEP_AUTHORITY' },
        this.refused(
          forbiddenRefusal(
            'Only the organization the step names decides it',
            'decision',
            ['NOT_STEP_AUTHORITY'],
            context,
          ),
        ),
      );
    }
    if (!this.access.holdsRole(step.authorityRole)) {
      throw new DecisionRefused(
        { ...refused, reason: 'ROLE_NOT_PERMITTED' },
        this.refused(RastaError.insufficientRole([step.authorityRole], getContext().roles)),
      );
    }

    // Separation of duties across both chains (Q-96 (3)): never the submitter, once per person.
    const separation = separationOf(
      decider,
      storedActor(
        statement.submittedBy ?? '',
        statement.submittedByIssuer,
        statement.submittedBySubject,
      ),
      statement.decisions.map((decision) =>
        storedActor(decision.decidedBy, decision.decidedByIssuer, decision.decidedBySubject),
      ),
    );
    if (separation === 'SUBMITTER') {
      throw this.separationRefused(refused, 'SUBMITTER_MAY_NOT_DECIDE', context);
    }
    if (separation === 'ALREADY_DECIDED') {
      throw this.separationRefused(refused, 'ALREADY_DECIDED_STATEMENT', context);
    }
    if (separation === 'UNKNOWN') {
      throw new DecisionRefused(
        { ...refused, reason: 'ACTOR_IDENTITY_UNKNOWN' },
        this.identityUnknown(context),
      );
    }

    // One instant for the decision, its statement's move and its events, read under the locks.
    const at = await databaseClock(tx);
    await this.repository.insertDecision(tx, {
      id: newId(ID_PREFIX.statementDecision),
      organizationId: contract.organizationId,
      contractId: contract.id,
      statementId: statement.id,
      chain: step.chain,
      stepOrder: step.stepOrder,
      outcome,
      deciderOrganizationId: input.acting,
      deciderRole: step.authorityRole,
      person: decider,
      correlationId: getContext().correlationId,
      at,
    });
    const moved = await this.repository.recordDecision(tx, {
      organizationId: contract.organizationId,
      id: statement.id,
      version: statement.version,
      from,
      to: judged.to,
      at,
    });
    if (!moved) throw RastaError.optimisticLockFailed('Statement', statement.id);

    const facts = {
      contractId: contract.id,
      statementId: statement.id,
      statementNumber: statement.statementNumber,
      organizationId: contract.organizationId,
      contractorOrganizationId: contract.contractorOrganizationId,
    };
    const enqueue = (
      eventName:
        | 'STATEMENT_DECISION_RECORDED'
        | 'STATEMENT_TECHNICALLY_APPROVED'
        | 'STATEMENT_APPROVED'
        | 'STATEMENT_REJECTED',
      payload: Record<string, unknown>,
    ) =>
      this.publisher.enqueue(tx, {
        eventName,
        aggregateId: contract.id,
        organizationId: contract.organizationId,
        occurredAt: at,
        payload: { ...facts, ...payload },
      });
    await enqueue('STATEMENT_DECISION_RECORDED', {
      chain: step.chain,
      stepOrder: step.stepOrder,
      outcome,
      deciderOrganizationId: input.acting,
      deciderRole: step.authorityRole,
      decidedBy: decider.userId,
      decidedAt: at.toISOString(),
    });

    // A transition's event only for a transition (`judged.command`): a step short of its chain's
    // last leaves the status where it was — TECHNICALLY_APPROVED under a financial step too — and
    // is recorded, nothing more.
    if (judged.command === 'approve_financial') {
      // The cap (ADR-068 § 5): the gross added under the contract's row lock, held by the database.
      await this.addToApprovedTotal(tx, contract, statement.grossMinor, at, context);
      await enqueue('STATEMENT_APPROVED', { approvedAt: at.toISOString() });
    } else if (judged.command === 'approve_technical') {
      await enqueue('STATEMENT_TECHNICALLY_APPROVED', {
        technicallyApprovedAt: at.toISOString(),
      });
    } else if (judged.command === 'reject') {
      await enqueue('STATEMENT_REJECTED', {
        chain: step.chain,
        stepOrder: step.stepOrder,
        rejectedAt: at.toISOString(),
      });
    }
    contractCommandsTotal.inc({
      service: SERVICE_NAME,
      command: COMMAND,
      outcome: judged.command ?? 'recorded',
    });

    const decided = await this.repository.findOne(
      contract.organizationId,
      contract.id,
      statement.id,
      tx,
    );
    if (!decided) throw RastaError.notFound('Statement', statement.id);
    return toStatementView(decided, contract.contractorOrganizationId);
  }

  /**
   * Adds the approved gross to the contract's total. Past the cap — judged first on the contract
   * read under its row lock (`withinApprovedCap`), so a sum past the largest bigint is the same
   * refusal and never the database's arithmetic error — this command is `422`, and the transaction
   * rolls back with it, so nothing of the decision is written. The database holds the same
   * (`ck_contract_approved_cap`), and its refusal is answered alike.
   */
  private async addToApprovedTotal(
    tx: ExtendedPrismaClient,
    contract: Contract,
    gross: bigint,
    at: Date,
    context: Record<string, unknown>,
  ): Promise<void> {
    const pastCap = () =>
      this.refused(
        ruleRefusal(
          'Approving this statement would take the approved total past the contract’s price and its effective amendments',
          'decision',
          ['APPROVED_TOTAL_EXCEEDS_CAP'],
          context,
        ),
      );
    if (!withinApprovedCap(contract, gross)) throw pastCap();
    let added: boolean;
    try {
      added = await this.repository.addToApprovedTotal(tx, {
        organizationId: contract.organizationId,
        contractId: contract.id,
        version: contract.version,
        gross,
        at,
      });
    } catch (error) {
      if (!isApprovedCapViolation(error)) throw error;
      throw pastCap();
    }
    if (!added) throw RastaError.optimisticLockFailed('Contract', contract.id);
  }

  private separationRefused(
    refused: Omit<AuthorityRefusal, 'reason'>,
    reason: 'SUBMITTER_MAY_NOT_DECIDE' | 'ALREADY_DECIDED_STATEMENT',
    context: Record<string, unknown>,
  ): DecisionRefused {
    return new DecisionRefused(
      { ...refused, reason },
      this.refused(
        ruleRefusal(
          reason === 'SUBMITTER_MAY_NOT_DECIDE'
            ? 'Separation of duties: the person who submitted a statement does not decide it'
            : 'Separation of duties: one person decides a statement at most once, across both chains',
          'decision',
          [reason satisfies ReasonOf<'decision'>],
          context,
        ),
      ),
    );
  }

  private identityUnknown(context: Record<string, unknown>): RastaError {
    return this.refused(
      refusal(
        ERROR_CODES.ACTOR_IDENTITY_UNKNOWN,
        'Separation of duties cannot be shown: the decider and the submitter or an earlier decider cannot be told apart',
        'decision',
        ['ACTOR_IDENTITY_UNKNOWN'],
        context,
      ),
    );
  }

  /** Counts the refusal; the error is thrown by the caller. */
  private refused(error: RastaError): RastaError {
    contractCommandsTotal.inc({ service: SERVICE_NAME, command: COMMAND, outcome: 'refused' });
    return error;
  }
}

/** The database refused the approved total past the cap (`ck_contract_approved_cap`). */
function isApprovedCapViolation(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.includes('ck_contract_approved_cap');
}
