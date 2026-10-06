import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';

/**
 * The durable work queue behind ORGANIZATION_MOVED (Q-83, docs/23 D-041) — construction-service's,
 * for the signing policies of this service.
 *
 * ## Two populations, and where the tenant guard is crossed
 *
 * The **queue as a whole** spans tenants: a move strands policies of many organizations, and one
 * sweeper serves them all. Enqueueing, claiming and the backlog reading therefore run under
 * `runUnscoped` with a written reason. Everything done **for one task** — completing it, failing it
 * — is written with the task's own `organization_id` in the predicate, and the sweeper runs it in
 * that tenant's context. No method here reads or writes a task without an organization predicate
 * except the three that say so.
 *
 * Times come from the database's `now()`, never the application clock (D-5): a lease and the due
 * time it is compared with must be one clock's.
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
  /** The generation at claim: what `complete` must still find for a "nothing to do" verdict. */
  generation: number;
  leaseToken: string;
  /** When the move took effect (the event's instant); the task's creation for an older task. */
  movedAt: Date;
  /** The move's hierarchy version (the highest of the moves coalesced); null for an older task. */
  movedVersion: number | null;
}

/**
 * What the suspension transaction asks of a task: is this worker still its owner (checked first,
 * with the row locked), and how to finish it there.
 */
export interface TaskOwnership {
  verify(tx: ExtendedPrismaClient): Promise<boolean>;
  finish(tx: ExtendedPrismaClient): Promise<unknown>;
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
   * (`ux_policy_reconciliation_open`): `ON CONFLICT DO NOTHING`, so a replay, a `.retry` delivery
   * and a second move while the first is queued add nothing. Returns the tasks actually created.
   */
  async enqueue(
    tx: ExtendedPrismaClient,
    rows: NewTask[],
    /** When the move took effect: the event's own instant. */
    movedAt: Date,
    /** This transaction's `now()`. */
    at: Date,
    /** The move's hierarchy version; null for an event that carries none. */
    movedVersion: number | null,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    // One statement decides, per policy, between "a new task" and "the open one already there",
    // by the unique index itself — never by comparing instants. A move that coalesces into an open
    // task must not lose the re-check: a sweeper holding it may have asked the hierarchy before the
    // move landed, so the conflicting task's generation advances (that sweeper then cannot finish it
    // on its stale answer) and it falls due now. The lease is left alone (a live claim is not
    // stolen), and the first move's event and instant stay — the earlier instant flags more, never
    // fewer, signatures — while the version becomes the HIGHER of the two, so a signature that read
    // the tree between the moves is flagged against the later one too (D-050). `xmax = 0` is what PostgreSQL gives a row this statement inserted
    // rather than updated, so the count is of tasks created, whatever instant either carries — a
    // second move in the very millisecond the first task was made included.
    const result = await runUnscoped(
      'an organization move queues a task for every union-written policy it could have stranded, in any tenant (Q-83)',
      () =>
        tx.$queryRawUnsafe<{ inserted: boolean }[]>(
          `INSERT INTO policy_reconciliation_task
                  (id, organization_id, policy_id, union_id, source_event_id,
                   moved_organization_id, correlation_id, moved_at, moved_version,
                   next_attempt_at, created_at, updated_at)
           SELECT t.id, t.organization_id, t.policy_id, t.union_id, t.source_event_id,
                  t.moved_organization_id, t.correlation_id, $8::timestamptz, $10::bigint,
                  $9::timestamptz, $9::timestamptz, $9::timestamptz
             FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
                  AS t(id, organization_id, policy_id, union_id, source_event_id,
                       moved_organization_id, correlation_id)
           ON CONFLICT (policy_id) WHERE status = 'PENDING'
           DO UPDATE SET generation = policy_reconciliation_task.generation + 1,
                         next_attempt_at = LEAST(policy_reconciliation_task.next_attempt_at, $9::timestamptz),
                         moved_version = GREATEST(policy_reconciliation_task.moved_version, $10::bigint),
                         updated_at = $9::timestamptz
           RETURNING (xmax = 0) AS inserted`,
          rows.map((row) => row.id),
          rows.map((row) => row.organizationId),
          rows.map((row) => row.policyId),
          rows.map((row) => row.unionId),
          rows.map((row) => row.sourceEventId),
          rows.map((row) => row.movedOrganizationId),
          rows.map((row) => row.correlationId),
          movedAt,
          at,
          movedVersion,
        ),
    );
    return result.filter((row) => row.inserted).length;
  }

  /**
   * Claims up to `limit` due tasks in one statement: due, open, and not under a live lease, oldest
   * first. `FOR UPDATE SKIP LOCKED` keeps two sweepers from queueing on the same rows; the
   * reservation is the lease token, which every later write of the task names, so a sweeper whose
   * lease was taken back can neither complete nor fail the new holder's task.
   */
  async claimDue(limit: number, leaseSeconds: number, token: string): Promise<ClaimedTask[]> {
    const claimed = await runUnscoped(
      'the sweeper claims due reconciliation tasks of every tenant; each is then handled in its own tenant (Q-83)',
      () =>
        this.prisma.client.$queryRawUnsafe<
          (Omit<ClaimedTask, 'movedVersion'> & {
            movedVersion: bigint | null;
          })[]
        >(
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
                  generation,
                  lease_token AS "leaseToken",
                  COALESCE(moved_at, created_at) AS "movedAt",
                  moved_version AS "movedVersion"`,
          limit,
          leaseSeconds,
          token,
        ),
    );
    return claimed.map((task) => ({
      ...task,
      movedVersion: task.movedVersion === null ? null : Number(task.movedVersion),
    }));
  }

  /**
   * DONE, fenced on the lease and — with `currentGeneration` — on the generation claimed. `0`: the
   * lease was taken back, or (for a "nothing to do" verdict) a later move coalesced into the task
   * after the lookup, so the task must be looked at again rather than finished.
   */
  async complete(
    tx: ExtendedPrismaClient,
    task: ClaimedTask,
    options: { currentGeneration: boolean },
  ): Promise<number> {
    return tx.$executeRawUnsafe(
      `UPDATE policy_reconciliation_task
          SET status = 'DONE', done_at = now(), updated_at = now(),
              lease_until = NULL, lease_token = NULL, last_error_code = NULL
        WHERE organization_id = $1 AND id = $2 AND lease_token = $3 AND status = 'PENDING'
          AND ($4::boolean = false OR generation = $5::int)`,
      task.organizationId,
      task.id,
      task.leaseToken,
      options.currentGeneration,
      task.generation,
    );
  }

  /**
   * Finishes a task whose lookup said "within", or gives it back if a later move landed since it
   * was claimed: `true` = DONE, `false` = released and due again (or the lease was lost), so the
   * next sweep asks once more.
   */
  async markDone(task: ClaimedTask): Promise<boolean> {
    if ((await this.complete(this.prisma.client, task, { currentGeneration: true })) > 0) {
      return true;
    }
    await this.release(task);
    return false;
  }

  /** Lets go of the lease without finishing: the task stays open and, if due, is claimable at once. */
  async release(task: ClaimedTask): Promise<number> {
    return this.prisma.client.$executeRawUnsafe(
      `UPDATE policy_reconciliation_task
          SET lease_until = NULL, lease_token = NULL, updated_at = now()
        WHERE organization_id = $1 AND id = $2 AND lease_token = $3 AND status = 'PENDING'`,
      task.organizationId,
      task.id,
      task.leaseToken,
    );
  }

  /**
   * The check a suspension transaction makes before it changes anything: lock the task row and
   * confirm this worker still holds it (token, open). A worker whose lease lapsed and was
   * re-claimed fails here, so it can neither suspend nor emit — the fence guards the effect, not
   * only the task.
   *
   * The suspension needs only the lease, not the generation: "outside" is the safe direction
   * whatever landed since, and a suspended policy has nothing left to re-look at, so its task is
   * finished whatever the generation is.
   */
  ownershipOf(task: ClaimedTask): TaskOwnership {
    return {
      verify: async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM policy_reconciliation_task
            WHERE organization_id = $1 AND id = $2 AND lease_token = $3 AND status = 'PENDING'
              FOR UPDATE`,
          task.organizationId,
          task.id,
          task.leaseToken,
        );
        return rows.length === 1;
      },
      finish: (tx) => this.complete(tx, task, { currentGeneration: false }),
    };
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
