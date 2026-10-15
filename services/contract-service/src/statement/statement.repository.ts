import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import type { DeductionRule } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { StatementAmounts } from './amounts';
import type { StatementWithParts } from './views';

export interface StatementInput {
  readonly id: string;
  readonly organizationId: string;
  readonly contractId: string;
  readonly statementNumber: number;
  readonly lines: readonly { id: string; description: string; amountMinor: bigint }[];
  readonly amounts: StatementAmounts;
  /** One id per applied deduction, in the order of `amounts.deductions`. */
  readonly deductionIds: readonly string[];
  readonly actor: string;
  readonly correlationId: string;
  readonly at: Date;
}

const WITH_PARTS = { lines: true, deductions: true } as const;

/**
 * Every statement this service runs against `statement`, `statement_line`, `statement_deduction`
 * and `deduction_rule`.
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
   * at commit that the totals are the sums of the parts (`statement_totals_consistent`).
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

  /** Takes the statement's row lock and reads it as it now stands (after the contract's). */
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
   * its `version`, which it increments, recording who submitted it with their stable identity.
   * `false` when the row is no longer that.
   */
  async submit(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      id: string;
      version: number;
      person: { userId: string; issuer: string; subject: string };
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
            updatedAt: input.at,
            version: { increment: 1 },
          },
        }),
    );
    return count === 1;
  }
}
