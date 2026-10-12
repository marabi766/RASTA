import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import type { Milestone } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';

export interface MilestoneInput {
  readonly id: string;
  readonly organizationId: string;
  readonly contractId: string;
  readonly title: string;
  /** `YYYY-MM-DD`. */
  readonly plannedDate: string;
  readonly plannedShareBp: number | null;
  readonly actor: string;
  readonly correlationId: string;
  readonly at: Date;
}

export interface MilestoneChange {
  readonly organizationId: string;
  readonly contractId: string;
  readonly id: string;
  readonly version: number;
  readonly title?: string;
  readonly plannedDate?: string;
  /** `null` clears the share. */
  readonly plannedShareBp?: number | null;
  readonly actor: string;
  readonly at: Date;
}

/** A calendar day as the Date a `date` column takes: midnight UTC of that day. */
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/**
 * Every statement this service runs against `milestone`.
 *
 * A milestone is read by the two parties of its contract and written by the employer, and the
 * contractor is another tenant: each statement crosses the tenant boundary **on purpose and says
 * so**, naming the contract's `organizationId` and `contractId` explicitly — taken from a contract
 * row the service has already shown the caller to be a party to, never from a request. Writes run
 * under the contract's row lock (`ContractRepository.lockContract`).
 */
@Injectable()
export class MilestoneRepository {
  constructor(private readonly prisma: PrismaService) {}

  findOne(
    organizationId: string,
    contractId: string,
    id: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<Milestone | null> {
    return runUnscoped(
      'a party reads one milestone of a contract it is a party to, by the contract’s organization and id',
      () => client.milestone.findFirst({ where: { organizationId, contractId, id } }),
    );
  }

  /** By planned day, then id: the contract's plan in the order it is carried out. */
  list(organizationId: string, contractId: string): Promise<Milestone[]> {
    return runUnscoped(
      'a party lists the milestones of a contract it is a party to, by the contract’s organization and id',
      () =>
        this.prisma.client.milestone.findMany({
          where: { organizationId, contractId },
          orderBy: [{ plannedDate: 'asc' }, { id: 'asc' }],
        }),
    );
  }

  count(tx: ExtendedPrismaClient, organizationId: string, contractId: string): Promise<number> {
    return runUnscoped(
      'the milestones of a contract are counted under the lock of the contract they belong to',
      () => tx.milestone.count({ where: { organizationId, contractId } }),
    );
  }

  insert(tx: ExtendedPrismaClient, input: MilestoneInput): Promise<Milestone> {
    return runUnscoped(
      'a milestone is written for the contract’s own organization, named explicitly',
      () =>
        tx.milestone.create({
          data: {
            id: input.id,
            organizationId: input.organizationId,
            contractId: input.contractId,
            title: input.title,
            plannedDate: day(input.plannedDate),
            plannedShareBp: input.plannedShareBp,
            createdAt: input.at,
            createdBy: input.actor,
            createdCorrelationId: input.correlationId,
            updatedAt: input.at,
            updatedBy: input.actor,
          },
        }),
    );
  }

  /** Takes the milestone's row lock and reads it as it now stands (after the contract's). */
  async lock(
    tx: ExtendedPrismaClient,
    organizationId: string,
    contractId: string,
    id: string,
  ): Promise<Milestone | null> {
    await tx.$queryRaw`SELECT 1 FROM milestone WHERE organization_id = ${organizationId} AND contract_id = ${contractId} AND id = ${id} FOR UPDATE`;
    return this.findOne(organizationId, contractId, id, tx);
  }

  /**
   * The one way a milestone changes: a compare-and-set on `organization_id`, `contract_id`, `id`,
   * its `version` and "no statement refers to it", which it increments. `false` when the row is no
   * longer that — the caller turns it into `409 OPTIMISTIC_LOCK_FAILED`.
   */
  async change(tx: ExtendedPrismaClient, input: MilestoneChange): Promise<boolean> {
    const { count } = await runUnscoped(
      'an edit changes the milestone it holds the lock of, matched on its organization, contract, id and version',
      () =>
        tx.milestone.updateMany({
          where: {
            organizationId: input.organizationId,
            contractId: input.contractId,
            id: input.id,
            version: input.version,
            firstReferencedAt: null,
          },
          data: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.plannedDate === undefined ? {} : { plannedDate: day(input.plannedDate) }),
            ...(input.plannedShareBp === undefined ? {} : { plannedShareBp: input.plannedShareBp }),
            updatedAt: input.at,
            updatedBy: input.actor,
            version: { increment: 1 },
          },
        }),
    );
    return count === 1;
  }
}
