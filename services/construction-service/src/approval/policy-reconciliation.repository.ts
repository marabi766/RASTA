import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';

/**
 * The durable work queue behind ORGANIZATION_MOVED (Q-83, docs/23 D-041).
 *
 * ## Two populations, and where the tenant guard is crossed
 *
 * The **queue as a whole** spans tenants: a move strands policies of many
 * organizations, and one sweeper serves them all. Enqueueing, claiming and the
 * backlog reading therefore run under `runUnscoped` with a written reason.
 * Everything done **for one task** — completing it, failing it — is written
 * with the task's own `organization_id` in the predicate, and the sweeper runs
 * it in that tenant's context. No method here reads or writes a task without an
 * organization predicate except the three that say so.
 *
 * Times come from the database's `now()`, never the application clock (D-5): a
 * lease and the due time it is compared with must be one clock's.
 */

export interface NewTask {
  id: string;
  organizationId: string;
  policyId: string;
  unionId: string;
  sourceEventId: string;
  movedOrganizationId: string;
  correlationId: string;
}

export interface ClaimedTask {
  id: string;
  organizationId: string;
  policyId: string;
  unionId: string;
  sourceEventId: string;
  movedOrganizationId: string;
  correlationId: string;
  attempts: number;
  leaseToken: string;
}

export interface Backlog {
  /** Tasks not yet DONE. */
  open: number;
  /** Open tasks whose time has come, leased or not. */
  due: number;
  /** How long the oldest due task has been waiting, in seconds; 0 when none. */
  oldestDueAgeSeconds: number;
}

@Injectable()
export class PolicyReconciliationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One task per policy, coalescing into the open one that is already there
   * (`ux_policy_reconciliation_open`): `ON CONFLICT DO NOTHING`, so a replay, a
   * `.retry` delivery and a second move while the first is queued add nothing.
   * Returns the tasks actually created.
   */
  async enqueue(tx: ExtendedPrismaClient, rows: NewTask[], at: Date): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await runUnscoped(
      'an organization move queues a task for every union-written policy it could have stranded, in any tenant (Q-83)',
      () =>
        tx.policyReconciliationTask.createMany({
          data: rows.map((row) => ({ ...row, nextAttemptAt: at, createdAt: at, updatedAt: at })),
          skipDuplicates: true,
        }),
    );
    return result.count;
  }

  /**
   * Claims up to `limit` due tasks in one statement: due, open, and not under a
   * live lease, oldest first. `FOR UPDATE SKIP LOCKED` keeps two sweepers from
   * queueing on the same rows; the reservation is the lease token, which every
   * later write of the task names, so a sweeper whose lease was taken back can
   * neither complete nor fail the new holder's task.
   */
  async claimDue(limit: number, leaseSeconds: number, token: string): Promise<ClaimedTask[]> {
    return runUnscoped(
      'the sweeper claims due reconciliation tasks of every tenant; each is then handled in its own tenant (Q-83)',
      () =>
        this.prisma.client.$queryRawUnsafe<ClaimedTask[]>(
          `UPDATE policy_reconciliation_task
              SET lease_until = now() + ($2::int * interval '1 second'),
                  lease_token = $3,
                  updated_at = now()
            WHERE id IN (
                  SELECT id FROM policy_reconciliation_task
                   WHERE status = 'PENDING'
                     AND next_attempt_at <= now()
                     AND (lease_until IS NULL OR lease_until <= now())
                   ORDER BY next_attempt_at, id
                   LIMIT $1
                     FOR UPDATE SKIP LOCKED)
        RETURNING id,
                  organization_id AS "organizationId",
                  policy_id AS "policyId",
                  union_id AS "unionId",
                  source_event_id AS "sourceEventId",
                  moved_organization_id AS "movedOrganizationId",
                  correlation_id AS "correlationId",
                  attempts,
                  lease_token AS "leaseToken"`,
          limit,
          leaseSeconds,
          token,
        ),
    );
  }

  /**
   * DONE, fenced on the lease. `0`: the lease was taken back; whatever the
   * caller did in the same transaction is conditional and stays correct.
   */
  async complete(tx: ExtendedPrismaClient, task: ClaimedTask): Promise<number> {
    return tx.$executeRawUnsafe(
      `UPDATE policy_reconciliation_task
          SET status = 'DONE', done_at = now(), updated_at = now(),
              lease_until = NULL, lease_token = NULL, last_error_code = NULL
        WHERE organization_id = $1 AND id = $2 AND lease_token = $3 AND status = 'PENDING'`,
      task.organizationId,
      task.id,
      task.leaseToken,
    );
  }

  /** `complete` on its own, for a task whose policy needs no change. */
  async markDone(task: ClaimedTask): Promise<number> {
    return this.complete(this.prisma.client, task);
  }

  /** One more attempt, later, with the reason as a closed code. Fenced on the lease. */
  async retryLater(task: ClaimedTask, errorCode: string, backoffSeconds: number): Promise<number> {
    return this.prisma.client.$executeRawUnsafe(
      `UPDATE policy_reconciliation_task
          SET attempts = attempts + 1, last_error_code = $4, updated_at = now(),
              next_attempt_at = now() + ($5::int * interval '1 second'),
              lease_until = NULL, lease_token = NULL
        WHERE organization_id = $1 AND id = $2 AND lease_token = $3 AND status = 'PENDING'`,
      task.organizationId,
      task.id,
      task.leaseToken,
      errorCode,
      backoffSeconds,
    );
  }

  /** Sampled for the gauges: what is waiting, and for how long. */
  async backlog(): Promise<Backlog> {
    const rows = await runUnscoped(
      'the reconciliation backlog gauge counts the queue of every tenant (Q-83)',
      () =>
        this.prisma.client.$queryRawUnsafe<{ open: bigint; due: bigint; oldest: number | null }[]>(
          `SELECT count(*) AS open,
                  count(*) FILTER (WHERE next_attempt_at <= now()) AS due,
                  extract(epoch FROM now() - min(next_attempt_at)
                          FILTER (WHERE next_attempt_at <= now())) AS oldest
             FROM policy_reconciliation_task
            WHERE status = 'PENDING'`,
        ),
    );
    const row = rows[0];
    return {
      open: Number(row?.open ?? 0),
      due: Number(row?.due ?? 0),
      oldestDueAgeSeconds: Math.max(0, Number(row?.oldest ?? 0)),
    };
  }
}
