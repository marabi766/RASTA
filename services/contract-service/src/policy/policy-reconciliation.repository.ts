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
  /**
   * The EARLIEST instant over every move coalesced into the task (D-050): the bound on which
   * signatures could have committed after a move was prepared. Never the instant of the move whose
   * version the task keeps — that one is the latest, not the earliest.
   */
  earliestMovedAt: Date;
  /** The move's hierarchy version (the highest of the moves coalesced); null for an older task. */
  movedVersion: number | null;
}

/**
 * What the suspension transaction asks of a task: is this worker still its owner (checked first,
 * with the row locked), and how to finish it there.
 */
export type TaskCheck =
  /** The lease was lost: nothing may be read or written. */
  | { readonly kind: 'NOT_OWNER' }
  /** A later move coalesced into the task after the claim: the lookup may predate it. */
  | { readonly kind: 'STALE' }
  /** Still the worker's, at the generation it claimed; the move's version and instant as the row holds them NOW. */
  | {
      readonly kind: 'OWNED';
      readonly movedVersion: number | null;
      readonly earliestMovedAt: Date;
    };

export interface TaskOwnership {
  verify(tx: ExtendedPrismaClient): Promise<TaskCheck>;
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
    // stolen). The task keeps the provenance of the move whose version it keeps (round 6): when the
    // later move has the HIGHER version, its event, moved organization, correlation id and instant
    // replace the first's together with the version — never a version with another move's event, or
    // a review would claim a cause that is not the one its version came from. A move without a
    // version, or a lower one, changes none of them. A signature that read the tree between the
    // moves is still flagged, against the higher version (D-050). The task keeps the EARLIEST
    // instant of all the moves coalesced into it (`LEAST`) beside the highest version: the window
    // is bounded by the earliest, so a later move can only add signatures, never drop one the
    // earlier move raced (round 10). `xmax = 0` is what PostgreSQL gives
    // a row this statement inserted rather than updated, so the count is of tasks created, whatever
    // instant either carries — a second move in the very millisecond the first task was made included.
    const result = await runUnscoped(
      'an organization move queues a task for every union-written policy it could have stranded, in any tenant (Q-83)',
      () =>
        tx.$queryRawUnsafe<{ inserted: boolean }[]>(
          `INSERT INTO policy_reconciliation_task
                  (id, organization_id, policy_id, union_id, source_event_id,
                   moved_organization_id, correlation_id, moved_at, moved_version,
                   earliest_moved_at, next_attempt_at, created_at, updated_at)
           SELECT t.id, t.organization_id, t.policy_id, t.union_id, t.source_event_id,
                  t.moved_organization_id, t.correlation_id, $8::timestamptz, $10::bigint,
                  $8::timestamptz, $9::timestamptz, $9::timestamptz, $9::timestamptz
             FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
                  AS t(id, organization_id, policy_id, union_id, source_event_id,
                       moved_organization_id, correlation_id)
           ON CONFLICT (policy_id) WHERE status = 'PENDING'
           DO UPDATE SET generation = policy_reconciliation_task.generation + 1,
                         next_attempt_at = LEAST(policy_reconciliation_task.next_attempt_at, $9::timestamptz),
                         source_event_id = CASE WHEN EXCLUDED.moved_version IS NOT NULL
                              AND (policy_reconciliation_task.moved_version IS NULL
                                   OR EXCLUDED.moved_version > policy_reconciliation_task.moved_version)
                              THEN EXCLUDED.source_event_id ELSE policy_reconciliation_task.source_event_id END,
                         moved_organization_id = CASE WHEN EXCLUDED.moved_version IS NOT NULL
                              AND (policy_reconciliation_task.moved_version IS NULL
                                   OR EXCLUDED.moved_version > policy_reconciliation_task.moved_version)
                              THEN EXCLUDED.moved_organization_id ELSE policy_reconciliation_task.moved_organization_id END,
                         correlation_id = CASE WHEN EXCLUDED.moved_version IS NOT NULL
                              AND (policy_reconciliation_task.moved_version IS NULL
                                   OR EXCLUDED.moved_version > policy_reconciliation_task.moved_version)
                              THEN EXCLUDED.correlation_id ELSE policy_reconciliation_task.correlation_id END,
                         moved_at = CASE WHEN EXCLUDED.moved_version IS NOT NULL
                              AND (policy_reconciliation_task.moved_version IS NULL
                                   OR EXCLUDED.moved_version > policy_reconciliation_task.moved_version)
                              THEN EXCLUDED.moved_at ELSE policy_reconciliation_task.moved_at END,
                         moved_version = GREATEST(policy_reconciliation_task.moved_version, EXCLUDED.moved_version),
                         earliest_moved_at = LEAST(policy_reconciliation_task.earliest_moved_at,
                                                   EXCLUDED.earliest_moved_at),
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
                  earliest_moved_at AS "earliestMovedAt",
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
   * The suspension is fenced on the **generation** too (round 5): a move that coalesced into the
   * task after the claim may have returned the employer, been signed under, and moved it out
   * again — the worker's answer and its copy of the move's version are stale, and suspending on
   * them would flag by the wrong version and finish a task that carries a later move. So under the
   * row lock the task is re-read; a changed generation is `STALE` (nothing written, the task given
   * back, due at once), and an unchanged one hands back the version and instant the row holds now.
   */
  ownershipOf(task: ClaimedTask): TaskOwnership {
    return {
      verify: async (tx) => {
        // The row is locked, so no later move can coalesce into it until this transaction ends:
        // what is read here is final for the suspension it guards (round 5).
        const rows = await tx.$queryRawUnsafe<
          { generation: number; movedVersion: bigint | null; earliestMovedAt: Date }[]
        >(
          `SELECT generation, moved_version AS "movedVersion",
                  earliest_moved_at AS "earliestMovedAt"
             FROM policy_reconciliation_task
            WHERE organization_id = $1 AND id = $2 AND lease_token = $3 AND status = 'PENDING'
              FOR UPDATE`,
          task.organizationId,
          task.id,
          task.leaseToken,
        );
        const row = rows[0];
        if (!row) return { kind: 'NOT_OWNER' };
        // A move landed after the claim: the answer this worker holds may predate it, and the
        // version it claimed is not the task's any more. Leave the task open for a fresh look.
        if (row.generation !== task.generation) return { kind: 'STALE' };
        return {
          kind: 'OWNED',
          movedVersion: row.movedVersion === null ? null : Number(row.movedVersion),
          earliestMovedAt: row.earliestMovedAt,
        };
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
