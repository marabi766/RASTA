import { Injectable, Logger, Optional } from '@nestjs/common';
import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import { OrganizationDirectory } from '../organization/organization-directory';
import { transactionNow } from '../shared/clock';
import { SERVICE_NAME } from '../config/env';
import { ApprovalRepository } from './approval.repository';
import {
  assertPolicyTransition,
  type PolicyStateName,
  type WorkflowKey,
} from './approval.state-machine';

/** `suspendedBy` on a policy the system suspended: nobody's user id. */
export const SYSTEM_ACTOR = `system:${SERVICE_NAME}`;

/** The one cause of a suspension today: the closed code on the row and on the event. */
export const SUSPENSION_CAUSE = 'ORGANIZATION_MOVED';

export interface MoveCause {
  /** The ORGANIZATION_MOVED event that triggered this, for the record. */
  eventId: string;
  /** The organization that moved — a trigger, never the answer. */
  movedOrganizationId: string;
  correlationId: string;
  /** The producer of the event (`organization-service`), for the system context. */
  callerService: string;
}

/**
 * The work one delivery may do (docs/23 D-041). `EventConsumer` runs the
 * handler inside a Kafka session of 60 s and gives it no heartbeat, so the
 * budget is half of that; the lookup cap keeps a slow answer per pair from
 * eating it. Not configuration: raising them is a decision about the session.
 */
export interface ReconfirmBounds {
  maxLookups: number;
  budgetMs: number;
}

export const DEFAULT_RECONFIRM_BOUNDS: ReconfirmBounds = { maxLookups: 100, budgetMs: 30_000 };

export interface ReconfirmOutcome {
  /** (Union, organization) pairs asked about. */
  checked: number;
  /** Pairs left unasked by the bound: the round-opening check covers them. */
  deferred: number;
  /** The policies suspended by this call. */
  suspended: string[];
}

/**
 * Approval policies follow an ORGANIZATION_MOVED (Q-70 (7), Q-83 — provisional,
 * the owner's call).
 *
 * `PolicyService` confirms "the union governs this organization" when a policy
 * is written, submitted and approved, and `ApprovalService` when a round opens.
 * None of that runs when the hierarchy changes underneath a policy already in
 * force. This service closes that: on a move, every ACTIVE union-written
 * policy is asked again, and one whose union no longer governs its
 * organization is **suspended** — not deleted, not transferred.
 *
 * ## Level-triggered, never edge-triggered
 *
 * The event says *something moved*; it is not trusted to say what is true now.
 * organization-service's current answer (`OrganizationDirectory.isWithin`) is
 * the only input, for every candidate, on every call. So a first delivery, a
 * redelivery, a `.retry` replay after a dead-letter, two moves in a row and a
 * move back all converge on the same result, whatever order they are handled
 * in. No `processed_event` marker is written, on purpose: a marker would make a
 * replay a no-op, and a replay after an outage is exactly when a fresh look is
 * wanted.
 *
 * ## Why the network call before the transaction is safe
 *
 * The hierarchy is asked *before* the transaction, so no lock is held across a
 * network call. The answer can be stale by the time the transaction commits;
 * the design tolerates that in both directions:
 *
 *   - **Stale "outside", now inside** (the organization moved back in between).
 *     The policy is suspended although its union governs again. That is the
 *     safe direction, and it is what Q-83 (B) says anyway: a move back does not
 *     revive a suspended policy.
 *   - **Stale "inside", now outside** (a second move landed in between). Not
 *     suspended by this call — but that second move's event is published in the
 *     move's own committed transaction, so its handler starts after the move is
 *     visible and asks organization-service a question whose answer already
 *     includes it. The last move is therefore always evaluated by a handler
 *     that sees it. And until then a round is still refused at opening
 *     (`ApprovalService.confirmGoverningPolicy`).
 *
 * Inside the transaction the write is conditional: under the policy-slot lock
 * (the lock `approve`, `retire` and round opening take), the row is re-read and
 * moved ACTIVE → SUSPENDED by compare-and-set. A policy already retired,
 * replaced or suspended by someone else matches no row and writes nothing, so a
 * redelivery and a concurrent approval each leave one consistent state, and the
 * transition, the event and the record of who and why commit together.
 *
 * ## Fail closed, but not all-or-nothing
 *
 * A candidate whose union cannot be confirmed (organization-service down) is
 * never suspended on a guess and never assumed fine: the error is rethrown
 * after every other candidate has been handled, so `EventConsumer` retries and
 * then dead-letters the event. Policies already suspended stay suspended.
 *
 * ## What a suspension does not touch
 *
 * A round already open keeps the steps it copied (`docs/08` § 8.9); nothing
 * here reads or writes an approval. A DRAFT policy is left alone: it becomes
 * ACTIVE only through submit and approve, and each re-confirms the union. A
 * PENDING one is suspended too — see `suspend`. A policy the platform
 * administrator wrote never depends on the hierarchy and is never listed.
 */
@Injectable()
export class PolicySuspensionService {
  private readonly logger = new Logger(PolicySuspensionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: ApprovalRepository,
    private readonly events: EventPublisher,
    private readonly directory: OrganizationDirectory,
    // Only a test passes this; Nest finds no provider and the default holds.
    @Optional() private readonly bounds: ReconfirmBounds = DEFAULT_RECONFIRM_BOUNDS,
  ) {}

  async reconfirmAll(cause: MoveCause): Promise<ReconfirmOutcome> {
    const candidates = await this.repository.listUnionPoliciesToReconfirm();
    const pairKey = (c: { authorOrganizationId: string; organizationId: string }) =>
      `${c.authorOrganizationId}\u0000${c.organizationId}`;

    // One question per (union, organization) pair, however many policies use
    // it — and the moved organization's own pairs first, since they are the
    // likeliest to have changed. Only an order: the answer never comes from
    // the event.
    const pairs = new Map<string, (typeof candidates)[number]>();
    for (const candidate of [...candidates].sort(
      (a, b) =>
        Number(b.organizationId === cause.movedOrganizationId) -
        Number(a.organizationId === cause.movedOrganizationId),
    )) {
      if (!pairs.has(pairKey(candidate))) pairs.set(pairKey(candidate), candidate);
    }

    // Bounded per delivery (docs/23 D-041): a lookup count and a time budget,
    // both well inside the consumer's session timeout, which this handler
    // cannot extend (`EventConsumer` hands it no heartbeat). What the bound
    // leaves unasked is not lost: a policy still stranded is refused when a
    // round is opened on it (`ApprovalService.confirmGoverningPolicy`), and
    // the next move asks again.
    const startedAt = Date.now();
    const answers = new Map<string, boolean>();
    let unconfirmed: unknown;
    let asked = 0;
    for (const [key, candidate] of pairs) {
      if (unconfirmed !== undefined) break;
      if (asked >= this.bounds.maxLookups || Date.now() - startedAt >= this.bounds.budgetMs) break;
      asked += 1;
      try {
        answers.set(
          key,
          await this.directory.isWithin(candidate.authorOrganizationId, candidate.organizationId),
        );
      } catch (error) {
        // Stop at the first failure: an unreachable organization-service is
        // asked once per attempt, not once per pair at one timeout each. What
        // was confirmed is still acted on below; the error is rethrown so the
        // event is retried.
        unconfirmed = error;
      }
    }
    const deferred = unconfirmed === undefined ? pairs.size - asked : 0;
    if (deferred > 0) {
      this.logger.warn(
        `Reconfirmed ${asked} of ${pairs.size} (union, organization) pairs for event ` +
          `${cause.eventId}; ${deferred} left to the check at round opening`,
      );
    }

    const suspended: string[] = [];
    for (const candidate of candidates) {
      if (answers.get(pairKey(candidate)) !== false) continue;
      if (await this.suspend(candidate, cause)) suspended.push(candidate.id);
    }

    if (unconfirmed !== undefined) throw unconfirmed;
    return { checked: asked, deferred, suspended };
  }

  /**
   * ACTIVE or PENDING_PLATFORM_APPROVAL → SUSPENDED in one transaction.
   * `false`: nothing was there to suspend.
   *
   * A pending policy is included because approval checks the hierarchy before
   * its own transaction: approval confirms, the move commits, and this runs
   * while the policy is still pending — if only ACTIVE were scanned, approval
   * would then commit a stranded ACTIVE policy nobody re-checks. Taking the
   * slot lock and re-reading the *actual* status makes both orders safe: this
   * first, and `approve` then finds SUSPENDED and refuses; `approve` first,
   * and this finds ACTIVE and suspends that. A DRAFT is not touched: it can
   * only become ACTIVE through submit and approve, and each asks the
   * hierarchy again.
   */
  private async suspend(
    candidate: { id: string; organizationId: string; workflowKey: WorkflowKey },
    cause: MoveCause,
  ): Promise<boolean> {
    // The tenant is the policy's own organization, never the moved one: the
    // event names one organization, the stranded policies belong to others.
    const context = createSystemContext({
      correlationId: cause.correlationId,
      organizationId: candidate.organizationId,
      callerService: cause.callerService,
    });

    return runWithContext(context, () =>
      this.prisma.transaction(async (tx) => {
        const at = await transactionNow(tx);

        // Organization and workflow key never change, so the candidate names
        // the slot; everything else is re-read under the lock, because approve,
        // retire or a replay may have run since the list was read.
        await this.repository.lockPolicySlot(tx, candidate.organizationId, candidate.workflowKey);
        const policy = await this.repository.findPolicy(tx, candidate.id);
        if (policy?.status !== 'ACTIVE' && policy?.status !== 'PENDING_PLATFORM_APPROVAL') {
          return false;
        }
        const from = policy.status as PolicyStateName;
        assertPolicyTransition(policy.id, from, 'SUSPENDED');

        const matched = await this.repository.transitionPolicy(tx, {
          organizationId: policy.organizationId,
          policyId: policy.id,
          from,
          data: {
            status: 'SUSPENDED',
            suspendedAt: at,
            suspendedBy: SYSTEM_ACTOR,
            suspensionReason:
              `${SUSPENSION_CAUSE}: ${policy.authorOrganizationId} no longer governs ` +
              `${policy.organizationId} (event ${cause.eventId}, organization ` +
              `${cause.movedOrganizationId})`,
          },
        });
        if (matched === 0) return false;

        await this.events.enqueue(tx, {
          eventName: 'APPROVAL_POLICY_SUSPENDED',
          aggregateId: policy.id,
          organizationId: policy.organizationId,
          payload: {
            policyId: policy.id,
            organizationId: policy.organizationId,
            authorOrganizationId: policy.authorOrganizationId,
            workflowKey: policy.workflowKey,
            policyVersion: policy.policyVersion,
            fromStatus: from,
            reason: SUSPENSION_CAUSE,
            causeEventId: cause.eventId,
            movedOrganizationId: cause.movedOrganizationId,
            suspendedBy: SYSTEM_ACTOR,
            suspendedAt: at.toISOString(),
          },
          causationId: cause.eventId,
          occurredAt: at,
        });
        this.logger.warn(
          `Suspended approval policy ${policy.id}: ${policy.authorOrganizationId} no longer ` +
            `governs ${policy.organizationId} (event ${cause.eventId})`,
        );
        return true;
      }),
    );
  }
}
