import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import type { Amendment, AmendmentSignature } from '../generated/prisma';
import type { HierarchyEvidence } from '../contract/contract.repository';
import type { SignatureFact } from '../contract/views';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { ID_PREFIX } from '../events/publisher';

/** One side's signature of an amendment, as it is written. */
export interface AmendmentSignatureInput {
  readonly id: string;
  /** The contract's organization — the employer's — for both sides. */
  readonly organizationId: string;
  readonly contractId: string;
  readonly amendmentId: string;
  readonly side: 'EMPLOYER' | 'CONTRACTOR';
  readonly signerOrganizationId: string;
  readonly signedBy: string;
  readonly signedByIssuer: string | null;
  readonly signedBySubject: string | null;
  readonly authorityRole: string;
  readonly policyId: string | null;
  readonly policyVersion: number | null;
  readonly hierarchyEvidence: HierarchyEvidence | null;
  readonly correlationId: string;
  readonly at: Date;
}

export interface AmendmentInput {
  readonly id: string;
  readonly organizationId: string;
  readonly contractId: string;
  readonly amendmentNumber: number;
  readonly deltaMinor: bigint;
  readonly reasonCode: string;
  readonly reasonText: string;
  readonly proposedBy: string;
  readonly correlationId: string;
  readonly at: Date;
}

/**
 * Every statement this service runs against `amendment` and `amendment_signature`.
 *
 * ## One way in
 *
 * An amendment is read and written by the two parties of its contract, and the contractor is
 * another tenant. So each statement crosses the tenant boundary **on purpose and says so**, and
 * each names the contract's `organizationId` and `contractId` explicitly — taken from a contract
 * row the service has already shown the caller to be a party to (`ContractRepository.findParty`,
 * `assertPartyOf`), never from a request. A command runs under the contract's row lock
 * (`ContractRepository.lockContract`); these statements assume it.
 */
@Injectable()
export class AmendmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -- reads (a party's, outside any transaction) ----------------------------------------------

  findOne(
    organizationId: string,
    contractId: string,
    id: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<Amendment | null> {
    return runUnscoped(
      'a party reads one amendment of a contract it is a party to, by the contract’s organization and id',
      () => client.amendment.findFirst({ where: { organizationId, contractId, id } }),
    );
  }

  /** Oldest first: the amendment number is the order they were proposed in. */
  list(
    organizationId: string,
    contractId: string,
    after: number | undefined,
    limit: number,
  ): Promise<Amendment[]> {
    return runUnscoped(
      'a party lists the amendments of a contract it is a party to, by the contract’s organization and id',
      () =>
        this.prisma.client.amendment.findMany({
          where: {
            organizationId,
            contractId,
            ...(after === undefined ? {} : { amendmentNumber: { gt: after } }),
          },
          orderBy: { amendmentNumber: 'asc' },
          take: limit + 1,
        }),
    );
  }

  /** When each side signed each amendment, and whether a signature is flagged, by amendment id. */
  async signatureFacts(
    organizationId: string,
    contractId: string,
    amendmentIds: readonly string[],
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<Map<string, SignatureFact[]>> {
    const facts = new Map<string, SignatureFact[]>();
    if (amendmentIds.length === 0) return facts;
    const rows = await runUnscoped(
      'a party sees when each side signed the amendments of a contract it is a party to',
      () =>
        client.amendmentSignature.findMany({
          where: { organizationId, contractId, amendmentId: { in: [...amendmentIds] } },
          select: {
            amendmentId: true,
            side: true,
            signedAt: true,
            review: { select: { id: true } },
          },
        }),
    );
    for (const row of rows) {
      const list = facts.get(row.amendmentId) ?? [];
      list.push({ side: row.side, signedAt: row.signedAt, reviewRequired: row.review !== null });
      facts.set(row.amendmentId, list);
    }
    return facts;
  }

  // -- the commands (under the contract's lock) -----------------------------------------------

  /** The number the next amendment gets: one above the last, read under the contract's lock. */
  async nextNumber(
    tx: ExtendedPrismaClient,
    organizationId: string,
    contractId: string,
  ): Promise<number> {
    const last = await runUnscoped(
      'the next amendment number is read under the lock of the contract it belongs to',
      () =>
        tx.amendment.aggregate({
          where: { organizationId, contractId },
          _max: { amendmentNumber: true },
        }),
    );
    return (last._max.amendmentNumber ?? 0) + 1;
  }

  insert(tx: ExtendedPrismaClient, input: AmendmentInput): Promise<Amendment> {
    return runUnscoped(
      'an amendment is written for the contract’s own organization, named explicitly',
      () =>
        tx.amendment.create({
          data: {
            id: input.id,
            organizationId: input.organizationId,
            contractId: input.contractId,
            amendmentNumber: input.amendmentNumber,
            deltaMinor: input.deltaMinor,
            reasonCode: input.reasonCode,
            reasonText: input.reasonText,
            status: 'PROPOSED',
            proposedBy: input.proposedBy,
            proposedAt: input.at,
            proposedCorrelationId: input.correlationId,
            updatedAt: input.at,
          },
        }),
    );
  }

  /** Takes the amendment's row lock and reads it as it now stands (after the contract's). */
  async lock(
    tx: ExtendedPrismaClient,
    organizationId: string,
    contractId: string,
    id: string,
  ): Promise<Amendment | null> {
    await tx.$queryRaw`SELECT 1 FROM amendment WHERE organization_id = ${organizationId} AND contract_id = ${contractId} AND id = ${id} FOR UPDATE`;
    return this.findOne(organizationId, contractId, id, tx);
  }

  listSignatures(
    tx: ExtendedPrismaClient,
    organizationId: string,
    amendmentId: string,
  ): Promise<(AmendmentSignature & { review?: { id: string } | null })[]> {
    return runUnscoped(
      'a command reads the signatures of the amendment it holds the lock of, by its organization and id',
      () =>
        tx.amendmentSignature.findMany({
          where: { organizationId, amendmentId },
          include: { review: { select: { id: true } } },
        }),
    );
  }

  insertSignature(
    tx: ExtendedPrismaClient,
    input: AmendmentSignatureInput,
  ): Promise<AmendmentSignature> {
    return runUnscoped(
      'the contractor’s signature is written for the contract’s own organization, named explicitly',
      () =>
        tx.amendmentSignature.create({
          data: {
            id: input.id,
            organizationId: input.organizationId,
            contractId: input.contractId,
            amendmentId: input.amendmentId,
            side: input.side,
            signerOrganizationId: input.signerOrganizationId,
            signedBy: input.signedBy,
            signedByIssuer: input.signedByIssuer,
            signedBySubject: input.signedBySubject,
            authorityRole: input.authorityRole,
            policyId: input.policyId,
            policyVersion: input.policyVersion,
            ...(input.hierarchyEvidence
              ? {
                  hierarchyAuthorOrganizationId: input.hierarchyEvidence.authorOrganizationId,
                  hierarchyAnswer: 'WITHIN',
                  hierarchyVersion: BigInt(input.hierarchyEvidence.hierarchyVersion),
                  hierarchyReadAt: input.hierarchyEvidence.readAt,
                  hierarchyCommitDeadline: input.hierarchyEvidence.commitDeadline,
                }
              : {}),
            signedAt: input.at,
            correlationId: input.correlationId,
          },
        }),
    );
  }

  /**
   * PROPOSED → EFFECTIVE: a compare-and-set on `organization_id`, `id`, the status it was read in
   * and its `version`, which it increments. `false` when the row is no longer that.
   */
  async makeEffective(
    tx: ExtendedPrismaClient,
    input: { organizationId: string; id: string; version: number; at: Date },
  ): Promise<boolean> {
    const { count } = await runUnscoped(
      'the second signature makes the amendment it holds the lock of effective, matched on its organization, id, status and version',
      () =>
        tx.amendment.updateMany({
          where: {
            organizationId: input.organizationId,
            id: input.id,
            status: 'PROPOSED',
            version: input.version,
          },
          data: {
            status: 'EFFECTIVE',
            effectiveAt: input.at,
            updatedAt: input.at,
            version: { increment: 1 },
          },
        }),
    );
    return count === 1;
  }

  /**
   * Adds an effective amendment's delta to the contract's total: a compare-and-set on the contract's
   * `organization_id`, `id`, status SIGNED and `version`, which it increments. `false` when the
   * contract is no longer that. The database accepts the new total only when it equals the sum of
   * the effective amendments (`contract_guard`), so the amendment is made effective first.
   */
  async addToContractTotal(
    tx: ExtendedPrismaClient,
    input: { organizationId: string; contractId: string; version: number; delta: bigint; at: Date },
  ): Promise<boolean> {
    const { count } = await runUnscoped(
      'an effective amendment moves the amendments total of the contract it holds the lock of, matched on its organization, id, status and version',
      () =>
        tx.contract.updateMany({
          where: {
            organizationId: input.organizationId,
            id: input.contractId,
            status: 'SIGNED',
            version: input.version,
          },
          data: {
            amendmentsTotalMinor: { increment: input.delta },
            updatedAt: input.at,
            version: { increment: 1 },
          },
        }),
    );
    return count === 1;
  }

  /**
   * Flags the employer amendment signatures under `policyId` that a move raced (D-050), as
   * `ContractRepository.flagRacedSignatures` does for the contract's own: the version they recorded
   * is LOWER than the move's (or none) — **by the version alone**, no timestamp takes part (round 5
   * of #231: two services' clocks cannot order a move); a move with no version flags every
   * unreviewed one. Never revokes: one append-only review row each, once.
   */
  async flagRacedSignatures(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      policyId: string;
      causeEventId: string;
      movedAt: Date;
      movedVersion: number | null;
      at: Date;
    },
  ): Promise<{ contractId: string; amendmentId: string; policyVersion: number }[]> {
    return runUnscoped(
      'the reconciliation of a move flags the amendment signatures of the policy it stranded, named by its organization and id',
      async () => {
        const raced = await tx.amendmentSignature.findMany({
          where: {
            organizationId: input.organizationId,
            policyId: input.policyId,
            side: 'EMPLOYER',
            ...(input.movedVersion === null
              ? {}
              : {
                  OR: [
                    { hierarchyVersion: null },
                    { hierarchyVersion: { lt: BigInt(input.movedVersion) } },
                  ],
                }),
            review: null,
          },
          orderBy: { id: 'asc' },
        });
        const flagged: { contractId: string; amendmentId: string; policyVersion: number }[] = [];
        for (const signature of raced) {
          await tx.amendmentSignatureReview.create({
            data: {
              id: `${ID_PREFIX.amendmentReview}_${ulid()}`,
              organizationId: signature.organizationId,
              contractId: signature.contractId,
              amendmentId: signature.amendmentId,
              side: 'EMPLOYER',
              policyId: input.policyId,
              reason: 'AUTHORITY_CHANGED_DURING_SIGNING',
              causeEventId: input.causeEventId,
              movedAt: input.movedAt,
              movedVersion: input.movedVersion === null ? null : BigInt(input.movedVersion),
              recordedVersion: signature.hierarchyVersion,
              flaggedAt: input.at,
            },
          });
          flagged.push({
            contractId: signature.contractId,
            amendmentId: signature.amendmentId,
            policyVersion: signature.policyVersion ?? 1,
          });
        }
        return flagged;
      },
    );
  }
}
