import { Inject, Injectable, Logger } from '@nestjs/common';
import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { SERVICE_NAME, type ContractEnv } from '../config/env';
import { ContractRepository } from '../contract/contract.repository';
import { EventPublisher } from '../events/publisher';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { transactionNow } from '../shared/clock';
import { ENV } from '../tokens';
import { UNION_ROLE } from './policy.access';
import {
  PolicyReconciliationRepository,
  type TaskOwnership,
} from './policy-reconciliation.repository';
import { PolicyRepository } from './policy.repository';
import {
  assertPolicyTransition,
  type PolicyStateName,
  type WorkflowKey,
} from './policy.state-machine';

/** `suspendedBy` on a policy the system suspended: nobody's user id. */
export const SYSTEM_ACTOR = `system:${SERVICE_NAME}`;

/** The id prefix of a reconciliation task. */
export const RECONCILIATION_TASK_ID_PREFIX = 'PRT';

/** Why a policy was suspended: a closed code, on the row and on the event. */
export type SuspensionReason = 'ORGANIZATION_MOVED' | 'MOVE_RECHECK' | 'SIGNING_RECHECK';

/**
 * What made the system look: a move's re-check, or a signature being attempted under the policy.
 *
 * The sweeper never names a cause (round 9, final): the event stream gives no cross-aggregate
 * order, so which move took the employer out of the union cannot be proven from the hierarchy as
 * it is now (docs/23 D-051). A move only *queued* the re-check; the detection is recorded as
 * `MOVE_RECHECK` with no event id and no instant on the review.
 */
export type SuspensionCause =
  | {
      reason: 'MOVE_RECHECK';
      /** The basis signatures are compared with; null for an event without a version. */
      movedVersion: number | null;
      /**
       * The EARLIEST instant over the moves queued (coalesced) into the task — only the bound on
       * which signatures could have committed after a move was prepared (D-050); never recorded
       * as a cause.
       */
      earliestMovedAt: Date;
      correlationId: string;
      callerService: string;
    }
  | { reason: 'SIGNING_RECHECK'; correlationId: string; callerService: string };

/** `NOT_OWNER`: the sweeper's lease was lost; nothing was read or written. */
export type SuspendResult = 'SUSPENDED' | 'NOTHING' | 'NOT_OWNER' | 'STALE';

export interface MoveCause {
  eventId: string;
  movedOrganizationId: string;
  /** When the move took effect: the event's `occurredAt`. */
  movedAt: Date;
  /** The move's hierarchy version; null for an event that carries none. */
  movedVersion: number | null;
  correlationId: string;
}

export interface EnqueueOutcome {
  /** Union-written policies the move could have stranded. */
  candidates: number;
  /** Tasks created; the rest coalesced into a task already open. */
  queued: number;
}

/**
 * Signing policies follow an ORGANIZATION_MOVED (Q-70 (7), Q-83 — provisional, the owner's call):
 * construction-service's mechanism (`PolicySuspensionService` there), for the `contract.signature`
 * policy of an employer.
 *
 * `PolicyService` confirms "the union governs this organization" when a policy is written,
 * submitted and approved, and `ContractService.sign` when a signature is recorded under it. None of
 * that runs when the hierarchy changes underneath a policy already in force. This closes that: a
 * policy whose union no longer governs its organization is **suspended** — not deleted, not
 * transferred — and a suspended policy authorises nobody.
 *
 * ## Two halves, joined by a durable queue (docs/23 D-041)
 *
 * **The Kafka handler** (`OrganizationMovedConsumer` → `enqueueMove`) does database work only: in
 * one transaction it queues a task for every ACTIVE or PENDING_PLATFORM_APPROVAL policy a union
 * wrote for another organization, and returns. No network call, so no session timeout, however
 * many policies there are; and nothing is skipped for lack of time.
 *
 * **The sweeper** (`PolicyReconciliationSweeper`) claims due tasks in bounded batches, asks
 * organization-service, and calls `suspend` for the ones whose union has lost the organization. A
 * failed lookup is retried later.
 *
 * A third caller, the signing-time check (`ContractService.sign`), calls `suspend` too: a policy
 * found stranded when a signature is attempted is suspended, not only refused. That check is the
 * authority — it reads the hierarchy under the policy slot's lock, so a signature is never
 * recorded under a policy whose union has already lost the employer, whatever the queue has or has
 * not yet done.
 *
 * ## Level-triggered, never edge-triggered
 *
 * The event says *something moved*; it is not trusted to say what is true now. organization-
 * service's current answer is the only input, for every task, when the task runs. So a first
 * delivery, a redelivery, a `.retry` replay, two moves in a row and a move back all converge on the
 * same result, whatever order they are handled in.
 *
 * ## Why asking before the transaction is safe
 *
 * The answer is fetched before the suspension transaction, so no lock is held across a network
 * call. It can be stale by the time the transaction commits; the design tolerates that in both
 * directions: "outside" that is now inside suspends a policy whose union governs again — the safe
 * direction, and what Q-83 (B) says anyway (a move back does not revive it); "inside" that is now
 * outside is not suspended by this task, but that move's own event queues a task created after the
 * move is visible, and signing re-asks under the lock regardless.
 *
 * Inside the transaction the write is conditional: under the policy-slot lock (the lock `approve`,
 * `retire` and signing take), the row is re-read and moved by compare-and-set from the status it
 * has. A policy already retired, replaced or suspended by someone else matches no row and writes
 * nothing, so a redelivery, a concurrent approval and two sweepers each leave one consistent state
 * and one event.
 *
 * ## What a suspension does not touch
 *
 * A signature already recorded keeps the policy it was made under; nothing here reads or writes
 * one. A DRAFT policy is left alone: it becomes ACTIVE only through submit and approve, and each
 * re-confirms the union. A policy the platform administrator wrote never depends on the hierarchy
 * and is never queued.
 */
@Injectable()
export class PolicySuspensionService {
  private readonly logger = new Logger(PolicySuspensionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: PolicyRepository,
    private readonly events: EventPublisher,
    private readonly reconciliations: PolicyReconciliationRepository,
    private readonly contracts: ContractRepository,
    @Inject(ENV) private readonly env: ContractEnv,
  ) {}

  /**
   * Queues the reconciliation of every policy the move could have stranded, in one transaction and
   * with no network call. Idempotent: a policy that already has an open task gets none.
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
        cause.movedAt,
        at,
        cause.movedVersion,
      );
    });
    return { candidates: candidates.length, queued };
  }

  /**
   * ACTIVE or PENDING_PLATFORM_APPROVAL → SUSPENDED in one transaction, with the event. `NOTHING`:
   * nothing was there to suspend.
   *
   * With `ownership` (the sweeper's), the task row is locked and its lease verified **first**: a
   * worker whose lease lapsed and was re-claimed gets `NOT_OWNER` before anything is read or
   * written — no policy change, no event. The fence guards the effect, not only the task. An
   * owner's transaction also finishes the task, whatever the outcome, so a task and its policy
   * never disagree.
   *
   * A pending policy is included because approval checks the hierarchy before its own transaction:
   * approval confirms, the move commits, and this runs while the policy is still pending — if only
   * ACTIVE were suspended, approval would then commit a stranded ACTIVE policy nobody re-checks.
   * Taking the slot lock and re-reading the *actual* status makes both orders safe: this first,
   * and `approve` then finds SUSPENDED and refuses; `approve` first, and this finds ACTIVE and
   * suspends that.
   */
  async suspend(
    candidate: { id: string; organizationId: string },
    cause: SuspensionCause,
    ownership?: TaskOwnership,
    /**
     * The current answer is "within": nothing is suspended, but the race window is still
     * reviewed (D-050) — the answer decides suspension only, never whether a signature that
     * committed while authority was absent is looked at (round 12).
     */
    options: { within?: boolean } = {},
  ): Promise<SuspendResult> {
    // The tenant is the policy's own organization, never the moved one: the event names one
    // organization, the stranded policies belong to others.
    const context = createSystemContext({
      correlationId: cause.correlationId,
      organizationId: candidate.organizationId,
      callerService: cause.callerService,
    });

    return runWithContext(context, () =>
      this.prisma.transaction(async (tx) => {
        // First: nothing below may run for a worker that no longer owns the task.
        let effective = cause;
        if (ownership) {
          const check = await ownership.verify(tx);
          if (check.kind === 'NOT_OWNER') return 'NOT_OWNER' as const;
          // A later move coalesced after the claim: nothing is written, the caller gives the
          // task back and looks again (round 5).
          if (check.kind === 'STALE') return 'STALE' as const;
          // The move's version and instant as the locked row holds them now — never the copy
          // taken at the claim.
          if (cause.reason === 'MOVE_RECHECK') {
            effective = {
              ...cause,
              movedVersion: check.movedVersion,
              earliestMovedAt: check.earliestMovedAt,
            };
          }
        }
        const suspended = options.within
          ? await this.reviewRaceIn(tx, candidate.id, effective)
          : await this.suspendIn(tx, candidate.id, effective);
        await ownership?.finish(tx);
        return suspended ? ('SUSPENDED' as const) : ('NOTHING' as const);
      }),
    );
  }

  /**
   * A re-check whose answer is "within": no status changes, but a signature that committed while
   * the employer was out of the union (out, signed, back before the sweep) is reviewed all the same
   * — same predicate, same `MOVE_RECHECK` attribution as a suspension (D-050). Always `false`:
   * nothing was suspended.
   */
  private async reviewRaceIn(
    tx: ExtendedPrismaClient,
    policyId: string,
    cause: SuspensionCause,
  ): Promise<boolean> {
    if (cause.reason === 'SIGNING_RECHECK') return false;
    const at = await transactionNow(tx);
    const found = await this.repository.findPolicy(tx, policyId);
    if (!found) return false;
    await this.repository.lockPolicySlot(
      tx,
      found.organizationId,
      found.workflowKey as WorkflowKey,
    );
    const policy = await this.repository.findPolicy(tx, policyId);
    if (!policy || policy.authorRole !== UNION_ROLE) return false;
    await this.flagRaced(tx, policy, cause, at);
    return false;
  }

  private async suspendIn(
    tx: ExtendedPrismaClient,
    policyId: string,
    cause: SuspensionCause,
  ): Promise<boolean> {
    const at = await transactionNow(tx);

    // Organization and workflow key never change, so this read names the slot; everything else is
    // re-read under the lock, because approve, retire or a replay may have run since.
    const found = await this.repository.findPolicy(tx, policyId);
    if (!found) return false;
    await this.repository.lockPolicySlot(
      tx,
      found.organizationId,
      found.workflowKey as WorkflowKey,
    );
    const policy = await this.repository.findPolicy(tx, policyId);
    if (!policy) return false;
    // A policy the platform wrote never depends on the hierarchy: not suspended by a move.
    if (policy.authorRole !== UNION_ROLE) return false;
    if (policy.status === 'SUSPENDED' || policy.status === 'RETIRED') {
      // Out of force already — a signature attempt found it stranded first, or it was replaced —
      // but a signature that raced this very move may rest on it all the same (D-050).
      if (cause.reason !== 'SIGNING_RECHECK') await this.flagRaced(tx, policy, cause, at);
      return false;
    }
    if (policy.status !== 'ACTIVE' && policy.status !== 'PENDING_PLATFORM_APPROVAL') return false;
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
          `${cause.reason}: ${policy.authorOrganizationId} no longer governs ` +
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
        causeEventId: null,
        movedOrganizationId: null,
        suspendedBy: SYSTEM_ACTOR,
        suspendedAt: at.toISOString(),
      },
      occurredAt: at,
    });
    if (cause.reason !== 'SIGNING_RECHECK') await this.flagRaced(tx, policy, cause, at);
    this.logger.warn(
      `Suspended approval policy ${policy.id} (${cause.reason}): ${policy.authorOrganizationId} ` +
        `no longer governs ${policy.organizationId}`,
    );
    return true;
  }

  /**
   * Flags, for review, every employer signature under this policy that the move raced (D-050): it
   * recorded a hierarchy version lower than the move's — it read the tree before the move — and it
   * could still have committed after the move was prepared.
   * Never revokes or cancels anything; one review row and one audit event per signature, in the
   * transaction that found the policy stranded, under the policy slot's lock.
   *
   * The review names no cause: `detectedBy` is always `MOVE_RECHECK`, with a null event id and
   * instant (round 9; docs/23 D-051).
   */
  private async flagRaced(
    tx: ExtendedPrismaClient,
    policy: { id: string; organizationId: string },
    cause: Exclude<SuspensionCause, { reason: 'SIGNING_RECHECK' }>,
    at: Date,
  ): Promise<void> {
    const attribution = {
      causeEventId: null,
      movedAt: null,
      detectedBy: 'MOVE_RECHECK' as const,
    };
    const flagged = await this.contracts.flagRacedSignatures(tx, {
      organizationId: policy.organizationId,
      policyId: policy.id,
      ...attribution,
      movedVersion: cause.movedVersion,
      earliestMoveInstant: cause.earliestMovedAt,
      clockSkewMarginSeconds: this.env.CONTRACT_HIERARCHY_CLOCK_SKEW_MARGIN_SECONDS,
      at,
    });
    for (const signature of flagged) {
      await this.events.enqueue(tx, {
        eventName: 'CONTRACT_SIGNATURE_AUTHORITY_FLAGGED',
        aggregateId: signature.contractId,
        organizationId: policy.organizationId,
        payload: {
          contractId: signature.contractId,
          organizationId: policy.organizationId,
          side: 'EMPLOYER',
          policyId: policy.id,
          policyVersion: signature.policyVersion,
          reason: 'AUTHORITY_CHANGED_DURING_SIGNING',
          detectedBy: attribution.detectedBy,
          causeEventId: null,
          movedAt: null,
          movedVersion: cause.movedVersion,
          flaggedAt: at.toISOString(),
        },
        occurredAt: at,
      });
      this.logger.warn(
        `Signature of contract ${signature.contractId} flagged for review: the authority it rested ` +
          `on changed while it was being made (no cause named)`,
      );
    }
  }
}
