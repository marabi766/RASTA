import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import type { Contract, DeductionRule, StatementStatus } from '../generated/prisma';
import type { StatementChain } from '../policy/policy.state-machine';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { StatementAmounts } from './amounts';
import type { StatementWithParts } from './views';

export interface StatementInput {
  readonly id: string;
  readonly organizationId: string;
  readonly contractId: string;
  readonly statementNumber: number;
  readonly lines: readonly {
    id: string;
    description: string;
    amountMinor: bigint;
    milestoneId: string | null;
  }[];
  readonly amounts: StatementAmounts;
  /** One id per applied deduction, in the order of `amounts.deductions`. */
  readonly deductionIds: readonly string[];
  readonly actor: string;
  readonly correlationId: string;
  readonly at: Date;
}

/** One snapshotted chain step, as the submission writes it. */
export interface ApprovalStepInput {
  readonly id: string;
  readonly chain: StatementChain;
  readonly stepOrder: number;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly authorityOrganizationId: string;
  readonly authorityRole: string;
  readonly authorityLabel: string;
}

/** One decision on a step of a statement's chains, as the decision command writes it. */
export interface DecisionInput {
  readonly id: string;
  readonly organizationId: string;
  readonly contractId: string;
  readonly statementId: string;
  readonly chain: StatementChain;
  readonly stepOrder: number;
  readonly outcome: 'APPROVED' | 'REJECTED';
  readonly deciderOrganizationId: string;
  readonly deciderRole: string;
  readonly person: { userId: string; issuer: string; subject: string };
  readonly correlationId: string;
  readonly at: Date;
}

const WITH_PARTS = {
  lines: true,
  deductions: true,
  approvalSteps: true,
  decisions: true,
} as const;

/**
 * Every statement this service runs against `statement`, `statement_line`, `statement_deduction`,
 * `statement_approval_step`, `statement_decision` and `deduction_rule`.
 *
 * A statement is read by the two parties of its contract and written by the contractor, which is
 * another tenant: each statement crosses the tenant boundary **on purpose and says so**, naming the
 * contract's `organizationId` and `contractId` explicitly — taken from a contract row the service
 * has already shown the caller to be a party to, never from a request. A command runs under the
 * contract's row lock (`ContractRepository.lockContract`); these statements assume it.
 */
@Injectable()
export class StatementRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -- reads (a party's) -----------------------------------------------------------------------

  findOne(
    organizationId: string,
    contractId: string,
    id: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<StatementWithParts | null> {
    return runUnscoped(
      'a party reads one statement of a contract it is a party to, by the contract’s organization and id',
      () =>
        client.statement.findFirst({
          where: { organizationId, contractId, id },
          include: WITH_PARTS,
        }),
    );
  }

  /** Oldest first: the statement number is the order they were drafted in. */
  list(
    organizationId: string,
    contractId: string,
    after: number | undefined,
    limit: number,
  ): Promise<StatementWithParts[]> {
    return runUnscoped(
      'a party lists the statements of a contract it is a party to, by the contract’s organization and id',
      () =>
        this.prisma.client.statement.findMany({
          where: {
            organizationId,
            contractId,
            ...(after === undefined ? {} : { statementNumber: { gt: after } }),
          },
          orderBy: { statementNumber: 'asc' },
          take: limit + 1,
          include: WITH_PARTS,
        }),
    );
  }

  // -- reads (an approver's, CON-003 PR 6) ------------------------------------------------------

  /**
   * The statement `statementId` of contract `contractId` and that contract, by those ids alone, for
   * the decision command to judge who the caller is to it: a party, an organization one of its
   * chain's steps names, or nobody (then `404`). Nothing of it reaches a caller before that judgement.
   */
  async findDecidable(
    contractId: string,
    statementId: string,
  ): Promise<{ contract: Contract; statement: StatementWithParts } | null> {
    return runUnscoped(
      'a decision finds the statement it names, by contract and statement id, to judge whether the caller is a party or an authority its chains name',
      async () => {
        const statement = await this.prisma.client.statement.findFirst({
          where: { contractId, id: statementId },
          include: WITH_PARTS,
        });
        if (!statement) return null;
        const contract = await this.prisma.client.contract.findFirst({
          where: { organizationId: statement.organizationId, id: contractId },
        });
        return contract ? { contract, statement } : null;
      },
    );
  }

  /**
   * The statement as one of its approvers reads it: only when a step of its snapshot names the
   * caller's organization with a role the caller holds — whether or not that step is open or
   * decided. `null` for any other caller, who is told the contract does not exist.
   */
  async findAsApprover(
    organizationId: string,
    roles: readonly string[],
    contractId: string,
    statementId: string,
  ): Promise<{ contract: Contract; statement: StatementWithParts } | null> {
    if (roles.length === 0) return null;
    return runUnscoped(
      'an organization a submitted statement’s chain names reads that statement, matched on its step’s organization and role',
      async () => {
        const statement = await this.prisma.client.statement.findFirst({
          where: {
            contractId,
            id: statementId,
            approvalSteps: {
              some: { authorityOrganizationId: organizationId, authorityRole: { in: [...roles] } },
            },
          },
          include: WITH_PARTS,
        });
        if (!statement) return null;
        const contract = await this.prisma.client.contract.findFirst({
          where: { organizationId: statement.organizationId, id: contractId },
        });
        return contract ? { contract, statement } : null;
      },
    );
  }

  // -- the commands (under the contract's lock) -----------------------------------------------

  /** The number the next statement gets: one above the last, read under the contract's lock. */
  async nextNumber(
    tx: ExtendedPrismaClient,
    organizationId: string,
    contractId: string,
  ): Promise<number> {
    const last = await runUnscoped(
      'the next statement number is read under the lock of the contract it belongs to',
      () =>
        tx.statement.aggregate({
          where: { organizationId, contractId },
          _max: { statementNumber: true },
        }),
    );
    return (last._max.statementNumber ?? 0) + 1;
  }

  /** The ids among `ids` that are milestones of this contract (Q-100 (4)); any other is not here. */
  async milestonesOf(
    tx: ExtendedPrismaClient,
    organizationId: string,
    contractId: string,
    ids: readonly string[],
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await runUnscoped(
      'a statement line refers to a milestone of its own contract, named by that contract’s organization and id',
      () =>
        tx.milestone.findMany({
          where: { organizationId, contractId, id: { in: [...ids] } },
          select: { id: true },
        }),
    );
    return rows.map((row) => row.id);
  }

  /** The employer's deduction rules in force among `ids` (Q-96 (6)); any other id is not here. */
  rulesInForce(
    tx: ExtendedPrismaClient,
    organizationId: string,
    ids: readonly string[],
  ): Promise<DeductionRule[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return runUnscoped(
      'a statement applies the deduction rules its contract’s employer configured, named by that organization',
      () =>
        tx.deductionRule.findMany({
          where: { organizationId, id: { in: [...ids] }, retiredAt: null },
        }),
    );
  }

  /**
   * The statement with its lines and deductions, in the caller's transaction. The database checks
   * at commit that the totals are the sums of the parts and that there are exactly as many parts
   * as the statement says (`statement_totals_consistent`).
   */
  async insert(tx: ExtendedPrismaClient, input: StatementInput): Promise<StatementWithParts> {
    const { organizationId, contractId } = input;
    return runUnscoped(
      'the contractor’s statement is written for the contract’s own organization, named explicitly',
      async () => {
        await tx.statement.create({
          data: {
            id: input.id,
            organizationId,
            contractId,
            statementNumber: input.statementNumber,
            status: 'DRAFT',
            grossMinor: input.amounts.grossMinor,
            deductionsMinor: input.amounts.deductionsMinor,
            netMinor: input.amounts.netMinor,
            // What it is written with, checked at commit with the totals: nothing is added later.
            lineCount: input.lines.length,
            deductionCount: input.amounts.deductions.length,
            createdAt: input.at,
            createdBy: input.actor,
            createdCorrelationId: input.correlationId,
            updatedAt: input.at,
          },
        });
        await tx.statementLine.createMany({
          data: input.lines.map((line, index) => ({
            id: line.id,
            organizationId,
            contractId,
            statementId: input.id,
            lineNumber: index + 1,
            description: line.description,
            amountMinor: line.amountMinor,
            milestoneId: line.milestoneId,
          })),
        });
        if (input.amounts.deductions.length > 0) {
          await tx.statementDeduction.createMany({
            data: input.amounts.deductions.map((deduction, index) => ({
              id: input.deductionIds[index] as string,
              organizationId,
              contractId,
              statementId: input.id,
              deductionRuleId: deduction.id,
              name: deduction.name,
              rateBp: deduction.rateBp,
              base: deduction.base,
              amountMinor: deduction.amountMinor,
            })),
          });
        }
        return tx.statement.findFirstOrThrow({
          where: { organizationId, id: input.id },
          include: WITH_PARTS,
        });
      },
    );
  }

  /** Takes the statement's row lock and reads it as it now stands (after the contract's lock). */
  async lock(
    tx: ExtendedPrismaClient,
    organizationId: string,
    contractId: string,
    id: string,
  ): Promise<StatementWithParts | null> {
    await tx.$queryRaw`SELECT 1 FROM statement WHERE organization_id = ${organizationId} AND contract_id = ${contractId} AND id = ${id} FOR UPDATE`;
    return this.findOne(organizationId, contractId, id, tx);
  }

  /**
   * DRAFT → SUBMITTED: a compare-and-set on `organization_id`, `id`, the status it was read in and
   * its `version`, which it increments, recording who submitted it with their stable identity and
   * how many steps each chain is snapshotted with. `false` when the row is no longer that. The
   * snapshot itself is written next, in the same transaction (`insertApprovalSteps`); the database
   * checks the two agree at commit (`statement_submission_consistent`).
   */
  async submit(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      id: string;
      version: number;
      person: { userId: string; issuer: string; subject: string };
      technicalStepCount: number;
      financialStepCount: number;
      at: Date;
    },
  ): Promise<boolean> {
    const { count } = await runUnscoped(
      'the contractor submits the statement it holds the lock of, matched on its organization, id, status and version',
      () =>
        tx.statement.updateMany({
          where: {
            organizationId: input.organizationId,
            id: input.id,
            status: 'DRAFT',
            version: input.version,
          },
          data: {
            status: 'SUBMITTED',
            submittedAt: input.at,
            submittedBy: input.person.userId,
            submittedByIssuer: input.person.issuer,
            submittedBySubject: input.person.subject,
            technicalStepCount: input.technicalStepCount,
            financialStepCount: input.financialStepCount,
            updatedAt: input.at,
            version: { increment: 1 },
          },
        }),
    );
    return count === 1;
  }

  /** Both chains' snapshot, written after the transition, in its transaction. */
  async insertApprovalSteps(
    tx: ExtendedPrismaClient,
    statement: { organizationId: string; contractId: string; id: string },
    steps: readonly ApprovalStepInput[],
    at: Date,
  ): Promise<void> {
    await runUnscoped(
      'a submitted statement’s approval chains are written for the contract’s own organization, named explicitly',
      () =>
        tx.statementApprovalStep.createMany({
          data: steps.map((step) => ({
            ...step,
            organizationId: statement.organizationId,
            contractId: statement.contractId,
            statementId: statement.id,
            createdAt: at,
          })),
        }),
    );
  }

  /**
   * One decision on a step, in the caller's transaction. The database checks that it is the next
   * undecided step of the open chain, by its authority, by neither the submitter nor anyone who
   * decided the statement before (`statement_decision_guard`, `ux_statement_decision_person`).
   */
  async insertDecision(tx: ExtendedPrismaClient, input: DecisionInput): Promise<void> {
    await runUnscoped(
      'a step’s authority records its decision on the contract’s own organization’s statement, named explicitly',
      () =>
        tx.statementDecision.create({
          data: {
            id: input.id,
            organizationId: input.organizationId,
            contractId: input.contractId,
            statementId: input.statementId,
            chain: input.chain,
            stepOrder: input.stepOrder,
            outcome: input.outcome,
            deciderOrganizationId: input.deciderOrganizationId,
            deciderRole: input.deciderRole,
            decidedBy: input.person.userId,
            decidedByIssuer: input.person.issuer,
            decidedBySubject: input.person.subject,
            decidedAt: input.at,
            correlationId: input.correlationId,
          },
        }),
    );
  }

  /**
   * The statement after a decision: a compare-and-set on `organization_id`, `id`, the status it was
   * read in and its `version`, which it increments, moving the status to `to` (the same one when the
   * decision completes nothing). `false` when the row is no longer that. The database checks at
   * commit that the status is what the decisions say (`statement_decisions_consistent`).
   */
  async recordDecision(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      id: string;
      version: number;
      from: StatementStatus;
      to: StatementStatus;
      at: Date;
    },
  ): Promise<boolean> {
    const { count } = await runUnscoped(
      'a decision moves the statement it holds the lock of, matched on its organization, id, status and version',
      () =>
        tx.statement.updateMany({
          where: {
            organizationId: input.organizationId,
            id: input.id,
            status: input.from,
            version: input.version,
          },
          data: { status: input.to, updatedAt: input.at, version: { increment: 1 } },
        }),
    );
    return count === 1;
  }

  /**
   * Adds an approved statement's gross to its contract's approved total, under the contract's row
   * lock, the contract still SIGNED and at the version it was read in. The database accepts the new
   * total only as the exact sum of the approved gross (`contract_guard`) and within the price and
   * the effective amendments (`ck_contract_approved_cap`): past the cap the statement throws, and the
   * caller's transaction rolls back.
   */
  async addToApprovedTotal(
    tx: ExtendedPrismaClient,
    input: { organizationId: string; contractId: string; version: number; gross: bigint; at: Date },
  ): Promise<boolean> {
    const { count } = await runUnscoped(
      'an approved statement moves the approved total of the contract it holds the lock of, matched on its organization, id, status and version',
      () =>
        tx.contract.updateMany({
          where: {
            organizationId: input.organizationId,
            id: input.contractId,
            status: 'SIGNED',
            version: input.version,
          },
          data: {
            approvedTotalMinor: { increment: input.gross },
            updatedAt: input.at,
            version: { increment: 1 },
          },
        }),
    );
    return count === 1;
  }

  /**
   * Marks the milestones the submitted statement's lines refer to as referenced, the first time
   * only (Q-100 (4)): from then on the employer cannot change them. Returns how many it marked.
   */
  async markMilestonesReferenced(
    tx: ExtendedPrismaClient,
    organizationId: string,
    contractId: string,
    ids: readonly string[],
    at: Date,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await runUnscoped(
      'a submitted statement marks the milestones of its own contract it refers to, named by that contract’s organization and id',
      () =>
        tx.milestone.updateMany({
          where: { organizationId, contractId, id: { in: [...ids] }, firstReferencedAt: null },
          data: { firstReferencedAt: at, version: { increment: 1 } },
        }),
    );
    return count;
  }
}
