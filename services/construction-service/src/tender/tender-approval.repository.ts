import { Injectable } from '@nestjs/common';
import { runUnscoped, type ActorIdentity } from '@rasta/nest-common';
import type { Approval, TenderApprovalRequest } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { storedActor, type StoredIdentity } from '../shared/stable-actor';
import type { TenderWorkflowKey } from '../approval/approval.state-machine';

/**
 * Reads and writes of the tender approval requests and their log (CON-002 PR 11).
 *
 * ## Tenant scope
 *
 * A request and its log live under the **tender owner's** organization. The owner's own commands
 * would pass the tenant guard, but a step is decided by its **authority**, which the policy names
 * and which may be another organization (a union, the platform): its calls cannot run under a guard
 * that would rewrite every predicate with the authority's own organization. So every method here
 * crosses the guard with a written reason and **names the organization in its own predicate** — the
 * tender's, never the caller's. What contains the crossing is the object-level check the service
 * makes first (`ProjectAccess.assertIsAuthority`, or ownership of the tender), not the query.
 */

const REASON =
  'a tender approval is requested and used by the tender owner and decided by the authority its ' +
  "policy names, which may be another organization; every predicate names the tender's organization";

/** How far an alive request has got, from the steps of its round. */
export type RequestProgress = 'PENDING' | 'APPROVED';

export interface RequestInsert {
  id: string;
  organizationId: string;
  tenderId: string;
  projectId: string;
  workflowKey: TenderWorkflowKey;
  round: number;
  tenderVersion: number;
  bidId: string | null;
  bidderOrganizationId: string | null;
  rank: number | null;
  tied: boolean | null;
  justification: string | null;
  matrixDigest: string | null;
  standingVerdict: string | null;
  standingAsOf: Date | null;
  reason: string | null;
  reasonCode: string | null;
  requestedBy: string;
  requestedByIdentity: StoredIdentity;
  requestedAt: Date;
  correlationId: string;
}

export interface LogInsert {
  id: string;
  organizationId: string;
  tenderId: string;
  requestId: string | null;
  workflowKey: TenderWorkflowKey;
  action: 'REQUEST' | 'GRANT' | 'REJECT' | 'EXECUTE' | 'STALE';
  outcome: 'GRANTED' | 'REFUSED';
  refusalCode: string | null;
  stepOrder: number | null;
  actorUserId: string;
  actorOrganizationId: string;
  occurredAt: Date;
}

@Injectable()
export class TenderApprovalRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The one alive request of a workflow for a tender (undecided, or approved and not yet used). */
  async findLive(
    tx: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
    workflowKey: TenderWorkflowKey,
  ): Promise<TenderApprovalRequest | null> {
    return runUnscoped(REASON, () =>
      tx.tenderApprovalRequest.findFirst({
        where: { organizationId, tenderId, workflowKey, endedAt: null, consumedAt: null },
      }),
    );
  }

  async findById(
    client: ExtendedPrismaClient,
    organizationId: string,
    id: string,
  ): Promise<TenderApprovalRequest | null> {
    return runUnscoped(REASON, () =>
      client.tenderApprovalRequest.findFirst({ where: { organizationId, id } }),
    );
  }

  /** The request a step belongs to: its tender, workflow and round. */
  async findOfStep(
    client: ExtendedPrismaClient,
    step: Pick<Approval, 'organizationId' | 'tenderId' | 'workflowKey' | 'round'>,
  ): Promise<TenderApprovalRequest | null> {
    if (step.tenderId === null) return null;
    return runUnscoped(REASON, () =>
      client.tenderApprovalRequest.findFirst({
        where: {
          organizationId: step.organizationId,
          tenderId: step.tenderId as string,
          workflowKey: step.workflowKey,
          round: step.round,
        },
      }),
    );
  }

  /** The requests of the steps a page shows, in one read: the keys are (tender, workflow, round). */
  async findOfSteps(
    client: ExtendedPrismaClient,
    steps: readonly Pick<Approval, 'organizationId' | 'tenderId' | 'workflowKey' | 'round'>[],
  ): Promise<TenderApprovalRequest[]> {
    const keys = steps.filter((step) => step.tenderId !== null);
    if (keys.length === 0) return [];
    return runUnscoped(REASON, () =>
      client.tenderApprovalRequest.findMany({
        where: {
          OR: keys.map((step) => ({
            organizationId: step.organizationId,
            tenderId: step.tenderId as string,
            workflowKey: step.workflowKey,
            round: step.round,
          })),
        },
      }),
    );
  }

  /** The next round number of a workflow on a tender: its own count, whatever other tenders did. */
  async nextRound(
    tx: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
    workflowKey: TenderWorkflowKey,
  ): Promise<number> {
    const latest = await runUnscoped(REASON, () =>
      tx.tenderApprovalRequest.aggregate({
        where: { organizationId, tenderId, workflowKey },
        _max: { round: true },
      }),
    );
    return (latest._max.round ?? 0) + 1;
  }

  async insert(tx: ExtendedPrismaClient, input: RequestInsert): Promise<void> {
    await runUnscoped(REASON, () =>
      tx.tenderApprovalRequest.create({
        data: {
          id: input.id,
          organizationId: input.organizationId,
          tenderId: input.tenderId,
          projectId: input.projectId,
          workflowKey: input.workflowKey,
          round: input.round,
          tenderVersion: input.tenderVersion,
          bidId: input.bidId,
          bidderOrganizationId: input.bidderOrganizationId,
          rank: input.rank,
          tied: input.tied,
          justification: input.justification,
          matrixDigest: input.matrixDigest,
          standingVerdict: input.standingVerdict,
          standingAsOf: input.standingAsOf,
          reason: input.reason,
          reasonCode: input.reasonCode,
          requestedBy: input.requestedBy,
          requestedByIssuer: input.requestedByIdentity.issuer,
          requestedBySubject: input.requestedByIdentity.subject,
          requestedAt: input.requestedAt,
          requestedCorrelationId: input.correlationId,
        },
      }),
    );
  }

  /** Every step of the request's round, in order. */
  async steps(
    client: ExtendedPrismaClient,
    request: Pick<TenderApprovalRequest, 'organizationId' | 'tenderId' | 'workflowKey' | 'round'>,
  ): Promise<Approval[]> {
    return runUnscoped(REASON, () =>
      client.approval.findMany({
        where: {
          organizationId: request.organizationId,
          tenderId: request.tenderId,
          workflowKey: request.workflowKey,
          round: request.round,
        },
        orderBy: { stepOrder: 'asc' },
      }),
    );
  }

  /** The requests of a tender, newest first, with the page the owner reads. */
  async listOfTender(
    client: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
    filter: { workflowKey?: TenderWorkflowKey; cursor?: string; limit: number },
  ): Promise<TenderApprovalRequest[]> {
    return runUnscoped(REASON, () =>
      client.tenderApprovalRequest.findMany({
        where: {
          organizationId,
          tenderId,
          ...(filter.workflowKey ? { workflowKey: filter.workflowKey } : {}),
          ...(filter.cursor ? { id: { lt: filter.cursor } } : {}),
        },
        orderBy: { id: 'desc' },
        take: filter.limit + 1,
      }),
    );
  }

  /** Ends an alive request: compare-and-set on it being alive. Returns the rows matched: 0 or 1. */
  async end(
    tx: ExtendedPrismaClient,
    input: { organizationId: string; id: string; reason: 'REJECTED' | 'STALE'; at: Date },
  ): Promise<number> {
    const result = await runUnscoped(REASON, () =>
      tx.tenderApprovalRequest.updateMany({
        where: {
          organizationId: input.organizationId,
          id: input.id,
          endedAt: null,
          consumedAt: null,
        },
        data: { endedAt: input.at, endedReason: input.reason, version: { increment: 1 } },
      }),
    );
    return result.count;
  }

  /**
   * Uses an alive request up, once: compare-and-set on it being alive. The database says the same
   * (every step granted, the same transaction as the execution, one use ever), whoever writes.
   */
  async consume(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      id: string;
      by: string;
      identity: StoredIdentity;
      at: Date;
    },
  ): Promise<number> {
    const result = await runUnscoped(REASON, () =>
      tx.tenderApprovalRequest.updateMany({
        where: {
          organizationId: input.organizationId,
          id: input.id,
          endedAt: null,
          consumedAt: null,
        },
        data: {
          consumedAt: input.at,
          consumedBy: input.by,
          consumedByIssuer: input.identity.issuer,
          consumedBySubject: input.identity.subject,
        },
      }),
    );
    return result.count;
  }

  async insertLog(tx: ExtendedPrismaClient, row: LogInsert): Promise<void> {
    await runUnscoped(REASON, () =>
      tx.tenderApprovalLog.create({
        data: {
          id: row.id,
          organizationId: row.organizationId,
          tenderId: row.tenderId,
          requestId: row.requestId,
          workflowKey: row.workflowKey,
          action: row.action,
          outcome: row.outcome,
          refusalCode: row.refusalCode,
          stepOrder: row.stepOrder,
          actorUserId: row.actorUserId,
          actorOrganizationId: row.actorOrganizationId,
          occurredAt: row.occurredAt,
        },
      }),
    );
  }

  /** The log of a tender, oldest first (the suites and the audit read it). */
  async log(client: ExtendedPrismaClient, organizationId: string, tenderId: string) {
    return runUnscoped(REASON, () =>
      client.tenderApprovalLog.findMany({
        where: { organizationId, tenderId },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
    );
  }

  // -- what an award's authority is judged against (the tender is the owner's, the caller is not) ----------

  /** Every organization that bid on the tender, withdrawn bids included: for the conflict of interest. */
  async bidderOrganizationIds(
    client: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
  ): Promise<string[]> {
    const rows = await runUnscoped(REASON, () =>
      client.bid.findMany({
        where: { organizationId, tenderId },
        distinct: ['bidderOrganizationId'],
        select: { bidderOrganizationId: true },
      }),
    );
    return rows.map((row) => row.bidderOrganizationId);
  }

  /**
   * The people who took part in the evaluation — decided on a bid, scored one, stood down from one, or
   * completed it — each with the stable identity the row recorded (#188): what `AWARDER_NOT_EVALUATOR`
   * compares an approver of the award with.
   */
  async evaluationPeople(
    client: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
  ): Promise<ActorIdentity[]> {
    return runUnscoped(REASON, async () => {
      const [decisions, claims, recusals, tender] = await Promise.all([
        client.bidQualification.findMany({
          where: { organizationId, tenderId },
          select: { decidedBy: true, decidedByIssuer: true, decidedBySubject: true },
        }),
        client.bidEvaluation.findMany({
          where: { organizationId, tenderId },
          select: { evaluatorId: true, evaluatorIssuer: true, evaluatorSubject: true },
        }),
        client.bidEvaluationRecusal.findMany({
          where: { organizationId, tenderId },
          select: { evaluatorId: true, evaluatorIssuer: true, evaluatorSubject: true },
        }),
        client.tender.findFirst({
          where: { organizationId, id: tenderId },
          select: { evaluatedBy: true, evaluatedByIssuer: true, evaluatedBySubject: true },
        }),
      ]);
      const people = [
        ...decisions.map((row) =>
          storedActor(row.decidedBy, row.decidedByIssuer, row.decidedBySubject),
        ),
        ...[...claims, ...recusals].map((row) =>
          storedActor(row.evaluatorId, row.evaluatorIssuer, row.evaluatorSubject),
        ),
      ];
      if (tender?.evaluatedBy) {
        people.push(
          storedActor(tender.evaluatedBy, tender.evaluatedByIssuer, tender.evaluatedBySubject),
        );
      }
      return people;
    });
  }

  get client(): ExtendedPrismaClient {
    return this.prisma.client;
  }
}
