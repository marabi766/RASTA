import { Injectable, Logger } from '@nestjs/common';
import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import { transactionNow } from '../shared/clock';
import { SERVICE_NAME } from '../config/env';
import { ApprovalRepository } from './approval.repository';
import {
  PolicyReconciliationRepository,
  type TaskOwnership,
} from './policy-reconciliation.repository';
import { assertPolicyTransition, type PolicyStateName } from './approval.state-machine';

/** `suspendedBy` on a policy the system suspended: nobody's user id. */
export const SYSTEM_ACTOR = `system:${SERVICE_NAME}`;

/** The id prefix of a reconciliation task. */
export const RECONCILIATION_TASK_ID_PREFIX = 'PRT';

/** Why a policy was suspended: a closed code, on the row and on the event. */
export type SuspensionReason = 'ORGANIZATION_MOVED' | 'ROUND_OPENING_RECHECK';

/** What made the system look: a move, or a round being opened on the policy. */
export type SuspensionCause =
  | {
      reason: 'ORGANIZATION_MOVED';
      /** The ORGANIZATION_MOVED event, for the record. */
      eventId: string;
      /** The organization that moved — a trigger, never the answer. */
      movedOrganizationId: string;
      correlationId: string;
      callerService: string;
    }
  | { reason: 'ROUND_OPENING_RECHECK'; correlationId: string; callerService: string };

/** `NOT_OWNER`: the sweeper's lease was lost; nothing was read or written. */
export type SuspendResult = 'SUSPENDED' | 'NOTHING' | 'NOT_OWNER';

export interface MoveCause {
  eventId: string;
  movedOrganizationId: string;
  correlationId: string;
}

export interface EnqueueOutcome {
  /** Union-written policies the move could have stranded. */
  candidates: number;
  /** Tasks created; the rest coalesced into a task already open. */
  queued: number;
}

/**
 * Approval policies follow an ORGANIZATION_MOVED (Q-70 (7), Q-83 — provisional,
 * the owner's call).
 *
 * `PolicyService` confirms "the union governs this organization" when a policy
 * is written, submitted and approved, and `ApprovalService` when a round opens.
 * None of that runs when the hierarchy changes underneath a policy already in
 * force. This closes that: a policy whose union no longer governs its
 * organization is **suspended** — not deleted, not transferred.
 *
 * ## Two halves, joined by a durable queue (docs/23 D-041)
 *
 * **The Kafka handler** (`OrganizationMovedConsumer` → `enqueueMove`) does
 * database work only: in one transaction it queues a task for every ACTIVE or
 * PENDING_PLATFORM_APPROVAL policy a union wrote for another organization, and
 * returns. No network call, so no session timeout, however many policies there
 * are; and nothing is skipped for lack of time.
 *
 * **The sweeper** (`PolicyReconciliationSweeper`) claims due tasks in bounded
 * batches, asks organization-service, and calls `suspend` for the ones whose
 * union has lost the organization. A failed lookup is retried later.
 *
 * A third caller, the round-opening check (`ApprovalService`), calls `suspend`
 * too: a policy found stranded there is suspended, not only refused.
 *
 * ## Level-triggered, never edge-triggered
 *
 * The event says *something moved*; it is not trusted to say what is true now.
 * organization-service's current answer is the only input, for every task, when
 * the task runs. So a first delivery, a redelivery, a `.retry` replay, two
 * moves in a row and a move back all converge on the same result, whatever
 * order they are handled in. A replay while a task is open coalesces into it;
 * a replay after it is done queues a fresh look.
 *
 * ## Why asking before the transaction is safe
 *
 * The answer is fetched before the suspension transaction, so no lock is held
 * across a network call. It can be stale by the time the transaction commits;
 * the design tolerates that in both directions:
 *
 *   - **Stale "outside", now inside** (the organization moved back in between).
 *     The policy is suspended although its union governs again: the safe
 *     direction, and what Q-83 (B) says anyway — a move back does not revive a
 *     suspended policy.
 *   - **Stale "inside", now outside** (a second move landed in between). Not
 *     suspended by this task — but that move's event is published in the
 *     move's own committed transaction, so its tasks are created after the move
 *     is visible and are answered against a state that includes it.
 *
 * Inside the transaction the write is conditional: under the policy-slot lock
 * (the lock `approve`, `retire` and round opening take), the row is re-read and
 * moved by compare-and-set from the status it has. A policy already retired,
 * replaced or suspended by someone else matches no row and writes nothing, so a
 * redelivery, a concurrent approval and two sweepers each leave one consistent
 * state and one event.
 *
 * ## What a suspension does not touch
 *
 * A round already open keeps the steps it copied (`docs/08` § 8.9); nothing
 * here reads or writes an approval. A DRAFT policy is left alone: it becomes
 * ACTIVE only through submit and approve, and each re-confirms the union. A
 * policy the platform administrator wrote never depends on the hierarchy and is
 * never queued.
 */
@Injectable()
export class PolicySuspensionService {
  private readonly logger = new Logger(PolicySuspensionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: ApprovalRepository,
    private readonly events: EventPublisher,
    private readonly reconciliations: PolicyReconciliationRepository,
  ) {}

  /**
   * Queues the reconciliation of every policy the move could have stranded, in
   * one transaction and with no network call. Idempotent: a policy that already
   * has an open task gets none.
   */
  async enqueueMove(cause: MoveCause): Promise<EnqueueOutcome> {
    const candidates = await this.repository.listUnionPoliciesToReconfirm();
    if (candidates.length === 0) return { candidates: 0, queued: 0 };

    const queued = await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      return this.reconciliations.enqueue(
        tx,
        candidates.map((candidate) => ({
          id: `${RECONCILIATION_TASK_ID_PREFIX}_${ulid()}`,
          organizationId: candidate.organizationId,
          policyId: candidate.id,
          unionId: candidate.authorOrganizationId,
          sourceEventId: cause.eventId,
          movedOrganizationId: cause.movedOrganizationId,
          correlationId: cause.correlationId,
        })),
        at,
      );
    });
    return { candidates: candidates.length, queued };
  }

  /**
   * ACTIVE or PENDING_PLATFORM_APPROVAL → SUSPENDED in one transaction, with the
   * event. `NOTHING`: nothing was there to suspend.
   *
   * With `ownership` (the sweeper's), the task row is locked and its lease
   * verified **first**: a worker whose lease lapsed and was re-claimed gets
   * `NOT_OWNER` before anything is read or written — no policy change, no
   * event. The fence guards the effect, not only the task. An owner's
   * transaction also finishes the task, whatever the outcome, so a task and its
   * policy never disagree.
   *
   * A pending policy is included because approval checks the hierarchy before
   * its own transaction: approval confirms, the move commits, and this runs
   * while the policy is still pending — if only ACTIVE were suspended,
   * approval would then commit a stranded ACTIVE policy nobody re-checks. Taking
   * the slot lock and re-reading the *actual* status makes both orders safe:
   * this first, and `approve` then finds SUSPENDED and refuses; `approve`
   * first, and this finds ACTIVE and suspends that.
   */
  async suspend(
    candidate: { id: string; organizationId: string },
    cause: SuspensionCause,
    ownership?: TaskOwnership,
  ): Promise<SuspendResult> {
    // The tenant is the policy's own organization, never the moved one: the
    // event names one organization, the stranded policies belong to others.
    const context = createSystemContext({
      correlationId: cause.correlationId,
      organizationId: candidate.organizationId,
      callerService: cause.callerService,
    });

    return runWithContext(context, () =>
      this.prisma.transaction(async (tx) => {
        // First: nothing below may run for a worker that no longer owns the task.
        if (ownership && !(await ownership.verify(tx))) return 'NOT_OWNER' as const;
        const suspended = await this.suspendIn(tx, candidate.id, cause);
        await ownership?.finish(tx);
        return suspended ? ('SUSPENDED' as const) : ('NOTHING' as const);
      }),
    );
  }

  private async suspendIn(
    tx: ExtendedPrismaClient,
    policyId: string,
    cause: SuspensionCause,
  ): Promise<boolean> {
    const at = await transactionNow(tx);

    // Organization and workflow key never change, so this read names the slot;
    // everything else is re-read under the lock, because approve, retire or a
    // replay may have run since.
    const found = await this.repository.findPolicy(tx, policyId);
    if (!found) return false;
    await this.repository.lockPolicySlot(
      tx,
      found.organizationId,
      found.workflowKey as Parameters<ApprovalRepository['lockPolicySlot']>[2],
    );
    const policy = await this.repository.findPolicy(tx, policyId);
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
          cause.reason === 'ORGANIZATION_MOVED'
            ? `${cause.reason}: ${policy.authorOrganizationId} no longer governs ` +
              `${policy.organizationId} (event ${cause.eventId}, organization ` +
              `${cause.movedOrganizationId})`
            : `${cause.reason}: ${policy.authorOrganizationId} no longer governs ` +
              `${policy.organizationId}`,
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
        reason: cause.reason,
        causeEventId: cause.reason === 'ORGANIZATION_MOVED' ? cause.eventId : null,
        movedOrganizationId:
          cause.reason === 'ORGANIZATION_MOVED' ? cause.movedOrganizationId : null,
        suspendedBy: SYSTEM_ACTOR,
        suspendedAt: at.toISOString(),
      },
      ...(cause.reason === 'ORGANIZATION_MOVED' ? { causationId: cause.eventId } : {}),
      occurredAt: at,
    });
    this.logger.warn(
      `Suspended approval policy ${policy.id} (${cause.reason}): ${policy.authorOrganizationId} ` +
        `no longer governs ${policy.organizationId}`,
    );
    return true;
  }
}
