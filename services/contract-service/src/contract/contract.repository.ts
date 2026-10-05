import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import type { Contract } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { INITIAL_CONTRACT_STATE, type ContractStateName } from './contract.state-machine';

export interface ContractListFilter {
  readonly status?: ContractStateName;
  readonly cursor?: string;
  readonly limit: number;
}

/** Everything a draft is made of: the verified award, and who and when. */
export interface DraftInput {
  readonly id: string;
  /** The employer: the tender's owner. */
  readonly organizationId: string;
  readonly tenderId: string;
  readonly projectId: string;
  readonly winningBidId: string;
  readonly contractorOrganizationId: string;
  readonly amountMinor: bigint;
  readonly matrixDigest: string;
  readonly awardedBy: string;
  readonly awardedAt: Date;
  readonly sourceEventId: string;
  readonly actor: string;
  readonly correlationId: string;
  /** One instant for the row and the event (`transactionNow`, D-5). */
  readonly at: Date;
}

/**
 * Every statement this service runs against `contract`.
 *
 * ## Two ways in, and only two
 *
 * The employer's side goes through the tenant guard: no `organizationId` is written
 * in a predicate below, because the guard writes it, and a contract of another
 * organization is simply not found (AGENTS.md A-04). The contractor's side crosses the
 * tenant boundary **on purpose** and says so: each statement is a reasoned
 * `runUnscoped` with `contractorOrganizationId` — the organization the caller's signed
 * token names — written in the predicate (ADR-068 § 7). The consumer's two statements
 * name the employer's organization explicitly, taken from the verified event.
 */
@Injectable()
export class ContractRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -- the consumer's side ----------------------------------------------------

  /** The contract made from a tender, if any: the consumer's idempotency probe. */
  findByTender(
    organizationId: string,
    tenderId: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<Contract | null> {
    return client.contract.findFirst({ where: { organizationId, tenderId } });
  }

  async insertDraft(tx: ExtendedPrismaClient, input: DraftInput): Promise<Contract> {
    return tx.contract.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        tenderId: input.tenderId,
        projectId: input.projectId,
        winningBidId: input.winningBidId,
        contractorOrganizationId: input.contractorOrganizationId,
        amountMinor: input.amountMinor,
        matrixDigest: input.matrixDigest,
        awardedBy: input.awardedBy,
        awardedAt: input.awardedAt,
        status: INITIAL_CONTRACT_STATE,
        statusChangedAt: input.at,
        statusChangedBy: input.actor,
        sourceEventId: input.sourceEventId,
        createdAt: input.at,
        createdBy: input.actor,
        createdCorrelationId: input.correlationId,
        updatedAt: input.at,
      },
    });
  }

  // -- the employer's side (through the tenant guard) --------------------------

  findOwn(id: string): Promise<Contract | null> {
    return this.prisma.client.contract.findFirst({ where: { id } });
  }

  listOwn(filter: ContractListFilter): Promise<Contract[]> {
    return this.prisma.client.contract.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.cursor ? { id: { lt: filter.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: filter.limit + 1,
    });
  }

  // -- the contractor's side (across the boundary, on purpose) ------------------

  findAsContractor(contractorOrganizationId: string, id: string): Promise<Contract | null> {
    return runUnscoped(
      'the winning contractor reads one contract it is a party to, found by id and its own organization',
      () =>
        this.prisma.client.contract.findFirst({
          where: { id, contractorOrganizationId },
        }),
    );
  }

  listAsContractor(
    contractorOrganizationId: string,
    filter: ContractListFilter,
  ): Promise<Contract[]> {
    return runUnscoped(
      'the winning contractor lists the contracts it is a party to, by its own organization',
      () =>
        this.prisma.client.contract.findMany({
          where: {
            contractorOrganizationId,
            ...(filter.status ? { status: filter.status } : {}),
            ...(filter.cursor ? { id: { lt: filter.cursor } } : {}),
          },
          orderBy: { id: 'desc' },
          take: filter.limit + 1,
        }),
    );
  }
}
