import { Inject, Injectable } from '@nestjs/common';
import {
  RastaError,
  actorIdentityUnknown,
  assertDistinctActors,
  compareActors,
  currentActor,
  getContext,
} from '@rasta/nest-common';
import { ERROR_CODES, type CursorPage } from '@rasta/contracts';
import type { Approval, TenderApprovalRequest } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { ProjectAccess, assertOwnTender } from '../access/access';
import { transactionNow } from '../shared/clock';
import { storedActor } from '../shared/stable-actor';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import { versionConflictsTotal } from '../observability/metrics';
import { ApprovalRepository } from '../approval/approval.repository';
import {
  assertDecidable,
  type ApprovalStateName,
  type TenderWorkflowKey,
} from '../approval/approval.state-machine';
import type { ApprovalBindingView, DecisionDto } from '../approval/dto';
import { refusalCodeOf } from './bid-access-audit';
import { approvalStale } from './tender-approval.errors';
import { OwnerIdentity } from './owner-identity';
import { TenderRepository } from './tender.repository';
import { TenderApprovalAudit } from './tender-approval.audit';
import { TenderApprovalRepository } from './tender-approval.repository';
import {
  toBindingView,
  toRequestView,
  type ListTenderApprovalsQuery,
  type TenderApprovalRequestView,
} from './tender-approval.dto';

/** The outcome of the decision transaction: committed, or committed having found the request stale. */
type Decided = 'DECIDED' | 'STALE';

/**
 * The authority's side of a tender approval (CON-002 PR 11), and the owner's reads of it.
 *
 * The step is the project module's own (`approval`, `assertDecidable`, the same states and the same
 * `decision` route); what differs is what a grant means. Granting the last step of a tender round does not
 * move a state: it **allows one command** — the one the request is bound to — to be executed once, by
 * the owner, on exactly what was asked (`TenderApprovalGate`). Rejecting a step ends the round.
 *
 * ## Under the tender's lock, on what the request was made on
 *
 * Every decision takes the tender row `FOR UPDATE`, the lock every owner command takes, so a decision and a
 * change of the tender serialise: a decision that finds the tender moved on from the version the request
 * was made on does not grant — it ends the request as stale (audited) and answers 409. A change that
 * comes after a grant is met at execution, which re-checks the same (`TenderApprovalGate.resolve`).
 *
 * ## Who may decide, and who may not
 *
 * The policy names the organization and the role (`ProjectAccess.assertIsAuthority`, before anything
 * here); the code names nobody. On top of that, through the shared helper (`assertDistinctActors`, #188):
 * **the person who made the request never grants it** — one person under two user ids, or another issuer,
 * is one person; a request whose requester cannot be told from the approver is refused (422
 * `ACTOR_IDENTITY_UNKNOWN`), never taken as another person. (A person may reject their own request: that
 * is withdrawing it.) For an **award** the approver is also judged as the awarder is: none of the roles
 * the bid side excludes, not a member of any organization that bid (403 `CONFLICT_OF_INTEREST`, on
 * identity-service's word as of now), and — with `AWARDER_NOT_EVALUATOR` — none of the people who took
 * part in the evaluation. Every refusal on the caller's own authority is audited.
 */
@Injectable()
export class TenderApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalRepository,
    private readonly requests: TenderApprovalRepository,
    private readonly audit: TenderApprovalAudit,
    private readonly tenders: TenderRepository,
    private readonly access: ProjectAccess,
    private readonly identity: OwnerIdentity,
    @Inject(ENV) private readonly env: ConstructionEnv,
  ) {}

  /** The decision on one PENDING step of a tender round. `step` was located and its authority already shown. */
  async decide(step: Approval, dto: DecisionDto, actor: string): Promise<void> {
    const workflowKey = step.workflowKey as TenderWorkflowKey;
    const tenderId = step.tenderId as string;
    const organizationId = step.organizationId;
    const context = getContext();
    const act = {
      organizationId,
      tenderId,
      projectId: step.projectId,
      requestId: null as string | null,
      workflowKey,
      action: (dto.decision === 'GRANT' ? 'GRANT' : 'REJECT') as 'GRANT' | 'REJECT',
      stepOrder: step.stepOrder,
      actorUserId: actor,
      actorOrganizationId: context.organizationId ?? step.authorityOrganizationId,
    };

    try {
      let memberOf: readonly string[] = [];
      if (workflowKey === 'tender.award') {
        this.access.assertMayDecideAward();
        memberOf = await this.liveOrganizations(actor);
      }

      const decided = await this.prisma.transaction(async (tx): Promise<Decided> => {
        const at = await transactionNow(tx);
        const locked = await this.tenders.lockTender(tx, organizationId, tenderId);
        if (!locked) throw RastaError.notFound('Approval', step.id);

        const approval = await this.approvals.findApproval(tx, step.id);
        if (!approval) throw RastaError.notFound('Approval', step.id);
        if (approval.version !== dto.expectedVersion) throw this.conflict('Approval', step.id);
        assertDecidable(step.id, approval.status as ApprovalStateName);

        const request = await this.requests.findOfStep(tx, approval);
        if (!request || request.endedAt !== null || request.consumedAt !== null) {
          throw RastaError.businessRule(
            `Approval ${step.id} belongs to a request that is no longer open; it cannot be decided`,
            { approvalId: step.id },
          );
        }
        act.requestId = request.id;

        // What it was asked on has moved: nothing is granted, and the request ends (it commits).
        if (request.tenderVersion !== locked.version) {
          await this.endStale(tx, request, locked, act.actorUserId, act.actorOrganizationId, at);
          return 'STALE';
        }

        if (workflowKey === 'tender.award') {
          await this.assertApproverNotConflicted(tx, organizationId, tenderId, memberOf);
        }
        if (dto.decision === 'GRANT') {
          assertDistinctActors(
            storedActor(request.requestedBy, request.requestedByIssuer, request.requestedBySubject),
            currentActor(),
            'the person who approves a tender request is not the one who made it',
          );
        }

        const granted = dto.decision === 'GRANT';
        const matched = await this.approvals.transitionApproval(tx, {
          organizationId,
          approvalId: step.id,
          from: 'PENDING',
          expectedVersion: dto.expectedVersion,
          data: {
            status: granted ? 'GRANTED' : 'REJECTED',
            decidedAt: at,
            decidedBy: actor,
            decisionNumber: dto.decisionNumber ?? null,
            conditions: granted ? (dto.conditions ?? null) : null,
            reason: granted ? null : (dto.reason ?? null),
          },
        });
        if (matched === 0) throw this.conflict('Approval', step.id);

        const scope = {
          organizationId,
          projectId: step.projectId,
          tenderId,
          workflowKey,
        };
        if (granted) {
          const next = await this.approvals.nextQueued(tx, { ...scope, round: step.round });
          if (next) {
            // The next authority is asked; the round is approved only when the last has granted.
            const asked = await this.approvals.transitionApproval(tx, {
              organizationId,
              approvalId: next.id,
              from: 'QUEUED',
              data: { status: 'PENDING', requestedAt: at },
            });
            if (asked === 0) throw this.conflict('Approval', next.id);
          }
        } else {
          // A refusal ends the round: the rest of its steps are superseded, and so is the request.
          await this.approvals.supersedeOpen(tx, scope, at);
          const ended = await this.requests.end(tx, {
            organizationId,
            id: request.id,
            reason: 'REJECTED',
            at,
          });
          if (ended === 0) throw this.conflict('TenderApprovalRequest', request.id);
        }
        await this.audit.record(tx, {
          ...act,
          requestId: request.id,
          outcome: 'GRANTED',
          at,
        });
        return 'DECIDED';
      });
      if (decided === 'STALE') throw approvalStale(workflowKey);
    } catch (error) {
      // A refusal on an authority's own step is audited, in a transaction of its own (best effort).
      if (error instanceof RastaError) {
        await this.audit.recordRefusal({ ...act, refusalCode: refusalCodeOf(error) });
      }
      throw error;
    }
  }

  /**
   * Ends a request that was made on a tender version that no longer stands, or whose command is not the
   * one approved: audited and announced, its undecided steps superseded. Used by the decision above and by
   * the command (`TenderApprovalGate`).
   */
  async endStale(
    tx: ExtendedPrismaClient,
    request: TenderApprovalRequest,
    tender: { organizationId: string; id: string; projectId: string },
    actorUserId: string,
    actorOrganizationId: string,
    at: Date,
  ): Promise<void> {
    const ended = await this.requests.end(tx, {
      organizationId: request.organizationId,
      id: request.id,
      reason: 'STALE',
      at,
    });
    if (ended === 0) throw this.conflict('TenderApprovalRequest', request.id);
    await this.approvals.supersedeOpen(
      tx,
      {
        organizationId: request.organizationId,
        projectId: request.projectId,
        tenderId: request.tenderId,
        workflowKey: request.workflowKey,
      },
      at,
    );
    await this.audit.record(tx, {
      organizationId: tender.organizationId,
      tenderId: tender.id,
      projectId: tender.projectId,
      requestId: request.id,
      workflowKey: request.workflowKey as TenderWorkflowKey,
      action: 'STALE',
      outcome: 'GRANTED',
      actorUserId,
      actorOrganizationId,
      at,
    });
  }

  // -- reads --------------------------------------------------------------------------------------------

  /**
   * What the steps' requests say, by step id, for the authority's views. `detail` false (a list) shows no
   * bid; `detail` true (one approval the caller has been shown not to be in conflict with) does.
   */
  async bindings(
    steps: readonly Approval[],
    options: { detail: boolean },
  ): Promise<Map<string, ApprovalBindingView>> {
    const found = new Map<string, ApprovalBindingView>();
    const client = this.requests.client;
    const requests = await this.requests.findOfSteps(client, steps);
    const byKey = new Map(
      requests.map((request) => [
        `${request.organizationId}/${request.tenderId}/${request.workflowKey}/${request.round}`,
        request,
      ]),
    );
    const stepsOfRound = new Map<string, Approval[]>();
    for (const step of steps) {
      if (step.tenderId === null) continue;
      const key = `${step.organizationId}/${step.tenderId}/${step.workflowKey}/${step.round}`;
      const request = byKey.get(key);
      if (!request) continue;
      let round = stepsOfRound.get(key);
      if (!round) {
        round = await this.requests.steps(client, request);
        stepsOfRound.set(key, round);
      }
      found.set(step.id, toBindingView(request, round, options.detail));
    }
    return found;
  }

  /** An approver in conflict with the tender is not shown the bid an award approval names (403, audited). */
  async assertMayReadAward(step: Approval): Promise<void> {
    const context = getContext();
    const userId = context.userId;
    if (!userId || context.authType !== 'USER') return;
    const memberOf = await this.liveOrganizations(userId);
    const bidders = await this.requests.bidderOrganizationIds(
      this.requests.client,
      step.organizationId,
      step.tenderId as string,
    );
    try {
      this.assertNoBidderMembership(memberOf, bidders);
    } catch (error) {
      if (error instanceof RastaError) {
        await this.audit.recordRefusal({
          organizationId: step.organizationId,
          tenderId: step.tenderId as string,
          projectId: step.projectId,
          requestId: null,
          workflowKey: 'tender.award',
          action: 'GRANT',
          refusalCode: refusalCodeOf(error),
          stepOrder: step.stepOrder,
          actorUserId: userId,
          actorOrganizationId: context.organizationId ?? step.authorityOrganizationId,
        });
      }
      throw error;
    }
  }

  /** The requests of one of the caller's own tenders, newest first; another organization's tender is a 404. */
  async listForTender(
    tenderId: string,
    query: ListTenderApprovalsQuery,
  ): Promise<CursorPage<TenderApprovalRequestView>> {
    const { organizationId } = this.access.assertCanRead();
    const tender = await this.tenders.findTender(tenderId);
    if (!tender) throw RastaError.notFound('Tender', tenderId);
    assertOwnTender(tender, organizationId);

    const rows = await this.requests.listOfTender(this.requests.client, organizationId, tenderId, {
      ...(query.workflowKey ? { workflowKey: query.workflowKey } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    const items: TenderApprovalRequestView[] = [];
    for (const request of visible) {
      items.push(toRequestView(request, await this.requests.steps(this.requests.client, request)));
    }
    return {
      items,
      nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  // -- the award approver's conflicts ---------------------------------------------------------------------

  /** Every organization the user belongs to as of now (identity-service, fail closed) and the token claims. */
  private async liveOrganizations(userId: string): Promise<string[]> {
    const { memberships } = await this.identity.fetchMemberships(userId);
    return [
      ...new Set([
        ...memberships.map((membership) => membership.organizationId),
        ...(getContext().organizationIds ?? []),
      ]),
    ];
  }

  private async assertApproverNotConflicted(
    tx: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
    memberOf: readonly string[],
  ): Promise<void> {
    this.assertNoBidderMembership(
      memberOf,
      await this.requests.bidderOrganizationIds(tx, organizationId, tenderId),
    );
    if (!this.env.CONSTRUCTION_COI_RULES.includes('AWARDER_NOT_EVALUATOR')) return;
    // `AWARDER_NOT_EVALUATOR`, for the person who approves the award as for the one who makes it: none of
    // the people who took part in the evaluation, on the token's issuer and subject (`compareActors`, #188).
    const approver = currentActor();
    let unknown = false;
    for (const person of await this.requests.evaluationPeople(tx, organizationId, tenderId)) {
      const comparison = compareActors(approver, person);
      if (comparison === 'SAME') {
        throw this.refuse(
          ERROR_CODES.FORBIDDEN,
          'APPROVER_IS_EVALUATOR',
          'The person who approves an award is none of those who evaluated the bids',
        );
      }
      if (comparison === 'UNKNOWN') unknown = true;
    }
    if (unknown) {
      throw actorIdentityUnknown(
        'the approver of an award is none of those who evaluated the bids',
      );
    }
  }

  private assertNoBidderMembership(
    memberOf: readonly string[],
    bidderOrganizationIds: readonly string[],
  ): void {
    const bidders = new Set(bidderOrganizationIds);
    if (memberOf.some((organization) => bidders.has(organization))) {
      throw this.refuse(
        ERROR_CODES.FORBIDDEN,
        'CONFLICT_OF_INTEREST',
        'A member of an organization that bid on this tender does not decide or read its award approval',
      );
    }
  }

  // -- errors --------------------------------------------------------------------------------------------

  private refuse(code: typeof ERROR_CODES.FORBIDDEN, reason: string, message: string): RastaError {
    return new RastaError(code, `Approval refused: ${reason}. ${message}`, {
      internalContext: { refusals: [reason] },
    });
  }

  private conflict(aggregate: string, id: string): RastaError {
    versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate });
    return RastaError.optimisticLockFailed(aggregate, id);
  }
}
