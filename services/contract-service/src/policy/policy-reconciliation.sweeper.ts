import { Logger } from '@nestjs/common';
import { RastaError, createSystemContext, runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { SERVICE_NAME } from '../config/env';
import { OrganizationDirectory } from '../organization/organization-directory';
import { policyReconciliationTotal } from '../observability/metrics';
import {
  PolicyReconciliationRepository,
  type ClaimedTask,
} from './policy-reconciliation.repository';
import { PolicySuspensionService } from './policy-suspension.service';

/** The producer of the moves that queue tasks: the system context's calling service. */
export const MOVE_PRODUCER = 'organization-service';

export interface SweeperOptions {
  /** How often a sweep runs. */
  intervalMs: number;
  /** Tasks claimed per sweep — with the per-call deadline, the bound on one sweep. */
  batchSize: number;
  /** How long a claim holds before another sweeper may take the task back. */
  leaseSeconds: number;
  /** Retry delay after the first failure; doubles per attempt up to the maximum. */
  backoffSeconds: number;
  backoffMaxSeconds: number;
}

export interface SweepOutcome {
  claimed: number;
  /** Suspended by this sweep. */
  suspended: number;
  /** Union still governs, or nothing left to suspend: DONE without a change. */
  confirmed: number;
  /** Failed and put back for later. */
  retried: number;
  /** Answered "within", but a later move landed meanwhile: released, due again at once. */
  requeued: number;
  /** The lease was lost before the write: nothing was changed. */
  notOwned: number;
}

/** The closed code recorded for a failure: a platform error code, or `INTERNAL`. */
function errorCodeOf(error: unknown): string {
  return error instanceof RastaError ? error.code : 'INTERNAL';
}

/**
 * Works the queue `OrganizationMovedConsumer` fills (Q-83, docs/23 D-041) — construction-service's
 * sweeper, for the signing policies of this service.
 *
 * Each sweep claims a bounded batch of due tasks (`FOR UPDATE SKIP LOCKED` plus a lease and a
 * fencing token, so any number of instances may run), asks organization-service whether each
 * policy's union still governs its organization — signed for the writing union, as everywhere —
 * and:
 *
 *   - **not within** → `PolicySuspensionService.suspend`, whose transaction also marks the task
 *     DONE: the suspension, its event and the task's completion commit together;
 *   - **within** → DONE, nothing changed — but only if no later move coalesced into the task since
 *     the claim (its `generation`); otherwise the lookup may predate that move, so the task is
 *     released, due at once, and the next sweep asks again;
 *   - **could not confirm** → the policy is left exactly as it is, the task's attempts go up and
 *     its next attempt moves out by an exponential backoff. Nothing partial, and nothing skipped:
 *     the task stays until an answer comes. Meanwhile the signing-time check refuses.
 *
 * A task whose policy is no longer ACTIVE or PENDING (retired, replaced, already suspended) is DONE
 * as a no-op. One task failing never stalls the batch. Each task is handled in the tenant of its
 * policy.
 *
 * The bound on the work is the batch size and the per-call deadline of `OrganizationDirectory`
 * (`CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS`), and it lives here, off the Kafka path: the handler
 * that fills the queue makes no network call at all.
 */
export class PolicyReconciliationSweeper {
  private readonly logger = new Logger(PolicyReconciliationSweeper.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<unknown>;

  constructor(
    private readonly reconciliations: PolicyReconciliationRepository,
    private readonly suspension: PolicySuspensionService,
    private readonly directory: Pick<OrganizationDirectory, 'isWithin' | 'withinVersion'>,
    private readonly options: SweeperOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Never overlap with itself: a slow sweep is followed by the next tick, not by a second
      // sweep beside it.
      if (this.inFlight) return;
      this.inFlight = this.runOnce()
        .catch((error: unknown) => {
          // A sweep that fails as a whole (the database is down) is retried by the next tick; the
          // tasks are still queued.
          this.logger.error(`Reconciliation sweep failed: ${errorCodeOf(error)}`);
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** One sweep. Public so a test, or an operator's tool, can drive it. */
  async runOnce(): Promise<SweepOutcome> {
    const token = ulid();
    const tasks = await this.reconciliations.claimDue(
      this.options.batchSize,
      this.options.leaseSeconds,
      token,
    );
    const outcome: SweepOutcome = {
      claimed: tasks.length,
      suspended: 0,
      confirmed: 0,
      retried: 0,
      requeued: 0,
      notOwned: 0,
    };

    // One question per (union, organization) pair in the batch.
    const answers = new Map<string, Promise<boolean>>();
    const ask = (task: ClaimedTask): Promise<boolean> => {
      const key = `${task.unionId}\u0000${task.organizationId}`;
      let answer = answers.get(key);
      if (!answer) {
        answer = this.directory.isWithin(task.unionId, task.organizationId);
        answers.set(key, answer);
      }
      return answer;
    };

    for (const task of tasks) {
      const context = createSystemContext({
        correlationId: task.correlationId,
        organizationId: task.organizationId,
        callerService: MOVE_PRODUCER,
      });
      try {
        await runWithContext(context, async () => {
          const within = await ask(task);
          if (within) {
            // Nothing about the policy changes: the task alone is finished — unless a later move
            // coalesced into it after the claim, in which case this answer may predate that move
            // and the task is given back, due at once, to be looked at again.
            if (await this.reconciliations.markDone(task)) {
              outcome.confirmed += 1;
              policyReconciliationTotal.inc({ service: SERVICE_NAME, result: 'confirmed' });
            } else {
              outcome.requeued += 1;
              policyReconciliationTotal.inc({ service: SERVICE_NAME, result: 'requeued' });
            }
            return;
          }
          // The union no longer governs the employer. Whether THIS move is why is a separate
          // question, answered from the hierarchy and never assumed (round 6).
          const proven = await this.isCause(task);
          const result = await this.suspension.suspend(
            { id: task.policyId, organizationId: task.organizationId },
            proven
              ? {
                  reason: 'ORGANIZATION_MOVED',
                  eventId: task.sourceEventId,
                  movedOrganizationId: task.movedOrganizationId,
                  movedAt: task.movedAt,
                  movedVersion: task.movedVersion,
                  correlationId: task.correlationId,
                  callerService: MOVE_PRODUCER,
                }
              : {
                  reason: 'MOVE_RECHECK',
                  movedVersion: task.movedVersion,
                  correlationId: task.correlationId,
                  callerService: MOVE_PRODUCER,
                },
            this.reconciliations.ownershipOf(task),
          );
          if (result === 'STALE') {
            // A move coalesced after the claim: give the task back, due at once, for a fresh look.
            await this.reconciliations.release(task);
            outcome.requeued += 1;
            policyReconciliationTotal.inc({ service: SERVICE_NAME, result: 'requeued' });
            return;
          }
          if (result === 'SUSPENDED') outcome.suspended += 1;
          else if (result === 'NOTHING') outcome.confirmed += 1;
          else outcome.notOwned += 1;
          policyReconciliationTotal.inc({
            service: SERVICE_NAME,
            result: result === 'SUSPENDED' ? 'suspended' : result === 'NOTHING' ? 'noop' : 'lost',
          });
        });
      } catch (error) {
        outcome.retried += 1;
        policyReconciliationTotal.inc({ service: SERVICE_NAME, result: 'retried' });
        await this.retryLater(task, error);
      }
    }

    if (outcome.claimed > 0) {
      const backlog = await this.reconciliations.backlog().catch(() => undefined);
      this.logger.log(
        `Reconciliation sweep: claimed ${outcome.claimed}, suspended ${outcome.suspended}, ` +
          `confirmed ${outcome.confirmed}, retried ${outcome.retried}, ` +
          `requeued ${outcome.requeued}, lost ${outcome.notOwned}` +
          (backlog
            ? `; backlog ${backlog.open} open, ${backlog.due} due, oldest due ` +
              `${Math.round(backlog.oldestDueAgeSeconds)}s`
            : ''),
      );
    }
    return outcome;
  }

  /**
   * Whether the move this task carries is shown to be why the union lost the employer. Two things
   * must hold (round 7):
   *
   * 1. **Exactly one move is on the task** — it was never coalesced into (`generation` 0; the
   *    suspension is fenced on the generation, so it is still 0 when the review is written). A
   *    coalesced task holds the highest-versioned of several moves, and the hierarchy cannot say
   *    which of them took the employer out: the employer may have left the union with an earlier
   *    one and then moved again within the outside branch, and the later move would be named.
   * 2. The employer is in the moved organization's subtree **and** carries that move's hierarchy
   *    version — a move stamps the moved organization and every descendant with its version in its
   *    own transaction, so a different version means another move last touched the employer, and a
   *    missing one means there is nothing to prove it by.
   *
   * An organization that is not within the moved one — an unrelated move that merely queued this
   * re-check — proves nothing. Fail closed: no proof is "not shown" (`MOVE_RECHECK`, no cause), and
   * a question that cannot be answered is retried like any other.
   */
  private async isCause(task: ClaimedTask): Promise<boolean> {
    if (task.generation !== 0) return false;
    if (task.movedVersion === null) return false;
    const answer = await this.directory.withinVersion(
      task.movedOrganizationId,
      task.organizationId,
    );
    return answer !== null && answer.hierarchyVersion === task.movedVersion;
  }

  private async retryLater(task: ClaimedTask, error: unknown): Promise<void> {
    const code = errorCodeOf(error);
    const backoff = Math.min(
      this.options.backoffMaxSeconds,
      this.options.backoffSeconds * 2 ** Math.min(task.attempts, 20),
    );
    try {
      await this.reconciliations.retryLater(task, code, Math.round(backoff));
      this.logger.warn(
        `Reconciliation task ${task.id} (attempt ${task.attempts + 1}) failed: ${code}; ` +
          `retrying in ${Math.round(backoff)}s`,
      );
    } catch {
      // The lease will expire and the task be taken again; nothing else to do.
      this.logger.error(`Reconciliation task ${task.id} could not be put back (${code})`);
    }
  }
}
