import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import type { ReadingParties } from '../access/access';
import type { Contract, ContractSignature } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { INITIAL_CONTRACT_STATE, type ContractStateName } from './contract.state-machine';
import type { SignatureFact } from './views';

/** One side's acceptance, as it is written. */
export interface SignatureInput {
  readonly id: string;
  /** The contract's organization — the employer's — for both sides. */
  readonly organizationId: string;
  readonly contractId: string;
  readonly side: 'EMPLOYER' | 'CONTRACTOR';
  /** The organization the signer acted for. */
  readonly signerOrganizationId: string;
  readonly signedBy: string;
  readonly signedByIssuer: string | null;
  readonly signedBySubject: string | null;
  readonly authorityRole: string;
  /** The policy that authorised the employer's side (id and version); null for the contractor's. */
  readonly policyId: string | null;
  readonly policyVersion: number | null;
  /**
   * What the hierarchy said when a union-written policy authorised the employer's side (D-050);
   * null for the contractor's side and for a platform-written policy, which needs none.
   */
  readonly hierarchyEvidence: HierarchyEvidence | null;
  readonly correlationId: string;
  readonly at: Date;
}

/** The organization-service answer a signature rested on, and the window it could have committed in. */
export interface HierarchyEvidence {
  /** The author organization asked about. */
  readonly authorOrganizationId: string;
  /** The employer's hierarchy version in the tree the answer came from (organization-service). */
  readonly hierarchyVersion: number;
  /** When the question was asked (the database's clock). */
  readonly readAt: Date;
  /** The latest instant the signing transaction could commit at: its own deadline. */
  readonly commitDeadline: Date;
}

export interface TransitionInput {
  readonly organizationId: string;
  readonly id: string;
  readonly from: ContractStateName;
  readonly to: ContractStateName;
  readonly version: number;
  readonly actor: string;
  readonly at: Date;
  readonly cancellation?: { readonly reasonCode: string; readonly note?: string | undefined };
}

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

  // -- the commands (sign, cancel): both parties, one contract, written under its lock ------
  //
  // The caller of a command may be the contractor, whose organization is not the contract's
  // tenant, so these statements cross the boundary on purpose — and each says so. Every one
  // names the contract's `organizationId` and `id` explicitly, taken from a row the service has
  // already shown the caller to be a party to (`assertPartyOf`); none takes either from a request.

  /**
   * Takes the contract's row lock and reads it as it now stands. Every command on one contract
   * runs under it, one at a time: two signatures at once are ordered, so the second sees the
   * first's and is the one that completes the contract, and a cancellation cannot interleave
   * with a signature. `null` when there is no such contract in that organization.
   */
  async lockContract(
    tx: ExtendedPrismaClient,
    organizationId: string,
    id: string,
  ): Promise<Contract | null> {
    await tx.$queryRaw`SELECT 1 FROM contract WHERE organization_id = ${organizationId} AND id = ${id} FOR UPDATE`;
    return runUnscoped(
      'a command reads the contract it holds the lock of, by the organization and id of a row its caller is a party to',
      () => tx.contract.findFirst({ where: { organizationId, id } }),
    );
  }

  /** The signatures of one contract, as they stand in the transaction that holds its lock. */
  listSignatures(
    tx: ExtendedPrismaClient,
    organizationId: string,
    contractId: string,
  ): Promise<(ContractSignature & { review?: { id: string } | null })[]> {
    return runUnscoped(
      'a command reads the signatures of the contract it holds the lock of, by its organization and id',
      () =>
        tx.contractSignature.findMany({
          where: { organizationId, contractId },
          include: { review: { select: { id: true } } },
        }),
    );
  }

  insertSignature(tx: ExtendedPrismaClient, input: SignatureInput): Promise<ContractSignature> {
    return runUnscoped(
      'the contractor’s signature is written for the contract’s own organization, named explicitly',
      () =>
        tx.contractSignature.create({
          data: {
            id: input.id,
            organizationId: input.organizationId,
            contractId: input.contractId,
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
   * Flags the employer signatures under `policyId` that a move raced (D-050): the tree they
   * rested on is older than the move's — the hierarchy version they recorded is LOWER than the
   * move's, a number organization-service stamps in the move's own transaction, so no clock
   * orders it — **and** the move's instant is at or before the signature's commit deadline
   * (`moved_at ≤ hierarchy_commit_deadline`, exactly D-050): a signature that committed before the
   * move was prepared cannot have raced it. The version decides which tree was read; the window
   * only bounds which signatures are looked at, and its clock skew errs towards flagging. A
   * signature without a deadline (from before evidence) cannot be bounded and is looked at.
   * A signature that read the tree after the move recorded the move's version or more, and is not
   * flagged.
   * Never revokes: it writes one append-only review row each, once
   * (`ux_signature_authority_review_signature`), and returns the ones it newly flagged. Runs under
   * the policy slot's lock, so no signature is recorded under the policy meanwhile.
   */
  async flagRacedSignatures(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      policyId: string;
      /** The move proven to be the cause; null (with `movedAt`) when none is (`detectedBy` MOVE_RECHECK). */
      causeEventId: string | null;
      movedAt: Date | null;
      detectedBy: 'ORGANIZATION_MOVED' | 'MOVE_RECHECK';
      /** The move's hierarchy version; null for an event that predates versions. */
      movedVersion: number | null;
      /** The move's own instant: the D-050 bound on which signatures could have raced it. Not recorded. */
      moveInstant: Date;
      at: Date;
    },
  ): Promise<{ contractId: string; policyVersion: number }[]> {
    return runUnscoped(
      'the reconciliation of a move flags the signatures of the policy it stranded, named by its organization and id',
      async () => {
        const raced = await tx.contractSignature.findMany({
          where: {
            organizationId: input.organizationId,
            policyId: input.policyId,
            side: 'EMPLOYER',
            // The version decides which tree was read: a signature rests on a tree older than the
            // move's when it recorded a lower version, or none (a signature from before versions
            // cannot show it read the moved tree). A move with no version (an event from before
            // them) orders nothing, so the version test is dropped: flagging too many is safe,
            // flagging too few is not.
            // The window (D-050) only bounds which signatures are looked at: one whose commit
            // deadline precedes the move's instant committed before the move and cannot have
            // raced it. No deadline, no bound.
            AND: [
              ...(input.movedVersion === null
                ? []
                : [
                    {
                      OR: [
                        { hierarchyVersion: null },
                        { hierarchyVersion: { lt: BigInt(input.movedVersion) } },
                      ],
                    },
                  ]),
              {
                OR: [
                  { hierarchyCommitDeadline: null },
                  { hierarchyCommitDeadline: { gte: input.moveInstant } },
                ],
              },
            ],
            review: null,
          },
          orderBy: { id: 'asc' },
        });
        const flagged: { contractId: string; policyVersion: number }[] = [];
        for (const signature of raced) {
          await tx.signatureAuthorityReview.create({
            data: {
              id: `SAR_${ulid()}`,
              organizationId: signature.organizationId,
              contractId: signature.contractId,
              side: 'EMPLOYER',
              policyId: input.policyId,
              reason: 'AUTHORITY_CHANGED_DURING_SIGNING',
              causeEventId: input.causeEventId,
              movedAt: input.movedAt,
              detectedBy: input.detectedBy,
              movedVersion: input.movedVersion === null ? null : BigInt(input.movedVersion),
              recordedVersion: signature.hierarchyVersion,
              flaggedAt: input.at,
            },
          });
          flagged.push({
            contractId: signature.contractId,
            policyVersion: signature.policyVersion ?? 1,
          });
        }
        return flagged;
      },
    );
  }

  /**
   * The one way a contract changes status: a compare-and-set on `organization_id`, `id`, the
   * status it was read in and its `version`, which it increments. `false` when the row is no
   * longer that — the caller turns it into `409 OPTIMISTIC_LOCK_FAILED`.
   */
  async transition(tx: ExtendedPrismaClient, input: TransitionInput): Promise<boolean> {
    const { count } = await runUnscoped(
      'a command moves the contract it holds the lock of, matched on its organization, id, status and version',
      () =>
        tx.contract.updateMany({
          where: {
            organizationId: input.organizationId,
            id: input.id,
            status: input.from,
            version: input.version,
          },
          data: {
            status: input.to,
            statusChangedAt: input.at,
            statusChangedBy: input.actor,
            updatedAt: input.at,
            version: { increment: 1 },
            ...(input.cancellation
              ? {
                  cancelReasonCode: input.cancellation.reasonCode,
                  cancelNote: input.cancellation.note ?? null,
                }
              : {}),
          },
        }),
    );
    return count === 1;
  }

  /**
   * When each side accepted, for contracts the caller has been shown to be a party to — by
   * explicit (organization, contract) pairs, whichever side the caller is.
   */
  async signatureFacts(contracts: readonly Contract[]): Promise<Map<string, SignatureFact[]>> {
    const facts = new Map<string, SignatureFact[]>();
    if (contracts.length === 0) return facts;
    const rows = await runUnscoped(
      'a party sees when each side accepted its contract, by the organization and id of contracts it is a party to',
      () =>
        this.prisma.client.contractSignature.findMany({
          where: {
            OR: contracts.map((contract) => ({
              organizationId: contract.organizationId,
              contractId: contract.id,
            })),
          },
          select: {
            contractId: true,
            side: true,
            signedAt: true,
            review: { select: { id: true } },
          },
        }),
    );
    for (const row of rows) {
      const list = facts.get(row.contractId) ?? [];
      list.push({ side: row.side, signedAt: row.signedAt, reviewRequired: row.review !== null });
      facts.set(row.contractId, list);
    }
    return facts;
  }

  /**
   * The contract, found as the employer (through the tenant guard) or as the winning contractor;
   * `null` for everyone else, a contract that does not exist included. The one door a command on
   * a contract's children (amendments, milestones) comes through.
   */
  async findParty(organizationId: string, id: string): Promise<Contract | null> {
    const row = (await this.findOwn(id)) ?? (await this.findAsContractor(organizationId, id));
    if (!row) return null;
    return row.organizationId === organizationId || row.contractorOrganizationId === organizationId
      ? row
      : null;
  }

  /**
   * The contract a reader may see: as the employer when the caller's roles read for it, else as the
   * winning contractor. The caller applies `assertPartyOf` to what comes back.
   */
  async findReadable(parties: ReadingParties, id: string): Promise<Contract | null> {
    let row: Contract | null = null;
    if (parties.employer) row = await this.findOwn(id);
    if (!row && parties.contractor) row = await this.findAsContractor(parties.organizationId, id);
    return row;
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
