import { Inject, Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { getContext, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { EconomicEnv } from '../config/env';
import { ENV } from '../tokens';

/**
 * The durable queue behind an unfinished refund (ADR-064 step B1).
 *
 * One task per intent whose money a refund may have stranded. Every write here
 * takes the caller's transaction, because the point is that the task and the
 * risk commit together: {@link open} runs in the transaction that holds the
 * amount or records the marker, {@link close} in the one that records the
 * outcome. A crash therefore never leaves a marker without its task, and a
 * recorded outcome never leaves a task behind.
 *
 * ## Tenancy
 *
 * The statements are raw (an upsert on a partial unique index has no Prisma
 * form), so the tenant guard cannot scope them; each names the intent's
 * organization itself, and the composite foreign key binds a task to its
 * intent in that organization.
 *
 * The **queue as a whole** spans tenants (step B2): one sweeper serves every
 * organization. Claiming, healing and the backlog reading therefore cross the
 * tenant guard under `runUnscoped` with a written reason; everything done
 * **for one task** names the task's own `organization_id` in its predicate,
 * and the sweeper runs it in that tenant's context.
 *
 * Times come from the database's `now()`, never the application clock: a due
 * time and the lease it is later compared with must be one clock's (as in
 * #148's queue).
 */
@Injectable()
export class PaymentReconciliationRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: EconomicEnv,
  ) {}

  /**
   * Opens the intent's task, or reschedules the open one already there
   * (`ux_payment_reconciliation_open`).
   *
   * `due`: `GRACE` for a refund that may still be in flight at the provider,
   * `NOW` for an outcome that is known and only needs recording. An
   * `ESCALATED` task is a person's and is left as it is. A live lease is left
   * alone as well: the fence is the lease token, not the due time.
   */
  async open(tx: ExtendedPrismaClient, task: OpenTask): Promise<void> {
    await runUnscoped('a reconciliation task is written for its intent, in its tenant', () =>
      tx.$executeRawUnsafe(
        `INSERT INTO payment_reconciliation_task
              (id, organization_id, payment_intent_id, kind, next_attempt_at, last_outcome,
               correlation_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4::"PaymentReconciliationKind",
                 now() + ($5::int * interval '1 second'), $6, $7, now(), now())
         ON CONFLICT (payment_intent_id) WHERE status <> 'DONE'
         DO UPDATE SET next_attempt_at = EXCLUDED.next_attempt_at,
                       last_outcome = EXCLUDED.last_outcome,
                       updated_at = now()
                 WHERE payment_reconciliation_task.status = 'PENDING'
                   AND payment_reconciliation_task.organization_id = EXCLUDED.organization_id`,
        `PRT_${ulid()}`,
        task.organizationId,
        task.paymentIntentId,
        task.kind,
        task.due === 'GRACE' ? this.env.ECONOMIC_PAYMENT_RECONCILER_GRACE_SECONDS : 0,
        task.outcome,
        getContext().correlationId,
      ),
    );
  }

  /**
   * Marks the intent's open task DONE with how and by whom. Returns the rows
   * closed: 0 when the intent had none, which is not an error — a refund
   * recorded by the request path within its own attempt may find the task
   * the same attempt opened, or (for an intent refunded before the queue
   * existed) none.
   */
  async close(tx: ExtendedPrismaClient, done: CloseTask): Promise<number> {
    return runUnscoped('a reconciliation task is closed for its intent, in its tenant', () =>
      tx.$executeRawUnsafe(
        `UPDATE payment_reconciliation_task
            SET status = 'DONE', done_at = now(), updated_at = now(),
                resolution = $3, resolved_by = $4,
                lease_until = NULL, lease_token = NULL
          WHERE organization_id = $1 AND payment_intent_id = $2 AND status <> 'DONE'`,
        done.organizationId,
        done.paymentIntentId,
        done.resolution,
        done.resolvedBy,
      ),
    );
  }

  // ==========================================================================
  // The sweeper's side (ADR-064 step B2)
  // ==========================================================================

  /**
   * Claims up to `limit` due PENDING tasks in one statement, oldest first, not
   * under a live lease. `FOR UPDATE SKIP LOCKED` keeps two sweepers off the
   * same rows; the reservation is the lease token, which every later write of
   * the task names — so a sweeper whose lease was taken back can neither move
   * money nor finish, fail or escalate the new holder's task.
   */
  async claimDue(limit: number, leaseSeconds: number, token: string): Promise<ClaimedTask[]> {
    return runUnscoped(
      'the payment reconciler claims due tasks of every tenant; each is then worked in its own tenant (ADR-064)',
      () =>
        this.prisma.client.$queryRawUnsafe<ClaimedTask[]>(
          `UPDATE payment_reconciliation_task
              SET lease_until = now() + ($2::int * interval '1 second'),
                  lease_token = $3,
                  updated_at = now()
            WHERE id IN (
                  SELECT id FROM payment_reconciliation_task
                   WHERE status = 'PENDING'
                     AND next_attempt_at <= now()
                     AND (lease_until IS NULL OR lease_until <= now())
                   ORDER BY next_attempt_at, id
                   LIMIT $1
                     FOR UPDATE SKIP LOCKED)
        RETURNING id,
                  organization_id AS "organizationId",
                  payment_intent_id AS "paymentIntentId",
                  kind::text AS kind,
                  attempts,
                  created_at AS "createdAt",
                  correlation_id AS "correlationId",
                  lease_token AS "leaseToken"`,
          limit,
          leaseSeconds,
          token,
        ),
    );
  }

  /**
   * What an apply transaction asks of its task: is this sweeper still the
   * owner (checked with the row locked, before anything changes), and how to
   * finish it there. A sweeper whose lease lapsed and was re-claimed fails
   * `verify`, so its transaction moves nothing and emits nothing — the fence
   * guards the effect, not only the task (#148's pattern).
   */
  ownershipOf(task: ClaimedTask): TaskOwnership {
    return {
      verify: async (tx) => {
        const rows = await runUnscoped('a raw row lock names the task and its tenant', () =>
          tx.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM payment_reconciliation_task
              WHERE organization_id = $1 AND id = $2 AND lease_token = $3 AND status = 'PENDING'
                FOR UPDATE`,
            task.organizationId,
            task.id,
            task.leaseToken,
          ),
        );
        return rows.length === 1;
      },
      finish: (tx, resolution, resolvedBy) =>
        runUnscoped('a fenced write names the task and its tenant', () =>
          tx.$executeRawUnsafe(
            `UPDATE payment_reconciliation_task
                SET status = 'DONE', done_at = now(), updated_at = now(),
                    resolution = $4, resolved_by = $5,
                    lease_until = NULL, lease_token = NULL
              WHERE organization_id = $1 AND id = $2 AND lease_token = $3 AND status = 'PENDING'`,
            task.organizationId,
            task.id,
            task.leaseToken,
            resolution,
            resolvedBy,
          ),
        ),
      escalate: (tx, outcome, countAttempt) =>
        runUnscoped('a fenced write names the task and its tenant', () =>
          tx.$executeRawUnsafe(
            `UPDATE payment_reconciliation_task
                SET status = 'ESCALATED', escalated_at = now(), updated_at = now(),
                    attempts = attempts + $5::int, last_outcome = $4,
                    lease_until = NULL, lease_token = NULL
              WHERE organization_id = $1 AND id = $2 AND lease_token = $3 AND status = 'PENDING'`,
            task.organizationId,
            task.id,
            task.leaseToken,
            outcome,
            countAttempt ? 1 : 0,
          ),
        ),
    };
  }

  /**
   * Puts the task back for later with what was observed. `countAttempt`:
   * true for an unanswered question, false for a deferral that asked nothing
   * (a frozen wallet). Fenced on the lease.
   */
  async retryLater(
    task: ClaimedTask,
    outcome: string,
    delaySeconds: number,
    countAttempt: boolean,
  ): Promise<number> {
    return runUnscoped('a fenced write names the task and its tenant', () =>
      this.prisma.client.$executeRawUnsafe(
        `UPDATE payment_reconciliation_task
            SET attempts = attempts + $6::int, last_outcome = $4, updated_at = now(),
                next_attempt_at = now() + ($5::int * interval '1 second'),
                lease_until = NULL, lease_token = NULL
          WHERE organization_id = $1 AND id = $2 AND lease_token = $3 AND status = 'PENDING'`,
        task.organizationId,
        task.id,
        task.leaseToken,
        outcome,
        Math.round(delaySeconds),
        countAttempt ? 1 : 0,
      ),
    );
  }

  /**
   * Level-triggered healing, both directions (Codex on #161, HIGH 1).
   *
   * A B0 instance still running during the deploy writes markers without
   * tasks and resolves intents without closing their tasks; the migration's
   * backfill ran once and cannot see either. So every sweep:
   *
   *   - **a marker with no open task** gets one — due after the grace for an
   *     unknown outcome (a B0 provider call may still be running), at once
   *     for a known one;
   *   - **an open task whose intent no longer carries its marker** is DONE as
   *     `NOTHING_TO_RECONCILE`, with no money action — unless the refund's hold
   *     is still out, which is left for the claim path to escalate.
   *
   * **Bounded work per sweep, whatever the backlog** (Codex on #164, MEDIUM):
   * each direction examines one window of at most `limit` rows after its
   * cursor, in `(created_at, id)` order — never "every candidate, then
   * LIMIT". The next window starts where this one ended; a window shorter
   * than `limit` reached the end, and the cursor starts over. The cursor
   * lives in the sweeper (per process): a restart starts over, which is
   * still bounded.
   *
   * Correctness therefore does not depend on deploy order. A task under a
   * live lease is never touched.
   */
  async heal(limit: number, cursor: HealCursor): Promise<HealPass> {
    const window = await runUnscoped(
      'the payment reconciler examines a window of marked intents of every tenant (ADR-064)',
      () =>
        this.prisma.client.$queryRawUnsafe<
          {
            id: string;
            organizationId: string;
            kind: PaymentReconciliationKind;
            unknown: boolean;
            correlationId: string;
            createdAt: Date;
            hasTask: boolean;
          }[]
        >(
          `SELECT pi.id,
                  pi.organization_id AS "organizationId",
                  CASE WHEN pi.status = 'AUTHORIZED' THEN 'UNCREDITED_REFUND' ELSE 'REFUND' END AS kind,
                  pi.failure_reason IN ('REFUND_REQUESTED', 'REFUND_UNKNOWN', 'CAPTURED_REFUND_UNKNOWN') AS unknown,
                  COALESCE(NULLIF(btrim(pi.correlation_id), ''), 'PAYMENT_RECONCILER') AS "correlationId",
                  pi.created_at AS "createdAt",
                  EXISTS (SELECT 1 FROM payment_reconciliation_task t
                           WHERE t.payment_intent_id = pi.id AND t.status <> 'DONE') AS "hasTask"
             FROM payment_intent pi
            WHERE ((pi.status = 'CAPTURED'
                    AND pi.failure_reason IN ('REFUND_REQUESTED', 'REFUND_UNKNOWN',
                                              'REFUNDED_NOT_REVERSED', 'REFUND_DECLINED_RELEASE_PENDING'))
                OR (pi.status = 'AUTHORIZED' AND pi.failure_reason = 'CAPTURED_REFUND_UNKNOWN'))
              AND (pi.created_at, pi.id) > ($2::timestamp, $3::text)
            ORDER BY pi.created_at, pi.id
            LIMIT $1`,
          limit,
          cursor.missing?.createdAt ?? EPOCH,
          cursor.missing?.id ?? '',
        ),
    );
    const missing = window.filter((row) => !row.hasTask);
    let opened = 0;
    if (missing.length > 0) {
      opened = await runUnscoped(
        "the payment reconciler opens the missing tasks, each in its intent's tenant (ADR-064)",
        () =>
          this.prisma.client.$executeRawUnsafe(
            `INSERT INTO payment_reconciliation_task
                  (id, organization_id, payment_intent_id, kind, next_attempt_at, last_outcome,
                   correlation_id, created_at, updated_at)
             SELECT m.id, m.organization_id, m.payment_intent_id, m.kind::"PaymentReconciliationKind",
                    now() + (CASE WHEN m.unknown THEN $6::int ELSE 0 END * interval '1 second'),
                    'MISSING_TASK', m.correlation_id, now(), now()
               FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::boolean[], $7::text[])
                    AS m(id, organization_id, payment_intent_id, kind, unknown, correlation_id)
             ON CONFLICT (payment_intent_id) WHERE status <> 'DONE' DO NOTHING`,
            missing.map(() => `PRT_${ulid()}`),
            missing.map((row) => row.organizationId),
            missing.map((row) => row.id),
            missing.map((row) => row.kind),
            missing.map((row) => row.unknown),
            this.env.ECONOMIC_PAYMENT_RECONCILER_GRACE_SECONDS,
            missing.map((row) => row.correlationId),
          ),
      );
    }
    const lastIntent = window[window.length - 1];

    const [stale] = await runUnscoped(
      'the payment reconciler examines a window of open tasks of every tenant and closes those settled without them (ADR-064)',
      () =>
        this.prisma.client.$queryRawUnsafe<
          { examined: number; closed: number; lastCreatedAt: Date | null; lastId: string | null }[]
        >(
          `WITH win AS (
                SELECT id, created_at FROM payment_reconciliation_task
                 WHERE status <> 'DONE' AND (created_at, id) > ($2::timestamp, $3::text)
                 ORDER BY created_at, id
                 LIMIT $1),
                closed AS (
                UPDATE payment_reconciliation_task
                   SET status = 'DONE', done_at = now(), updated_at = now(),
                       resolution = 'NOTHING_TO_RECONCILE', resolved_by = $4,
                       last_outcome = 'MARKER_GONE', lease_until = NULL, lease_token = NULL
                 WHERE id IN (
                       SELECT t.id
                         FROM payment_reconciliation_task t
                         JOIN win w ON w.id = t.id
                         JOIN payment_intent pi
                           ON pi.organization_id = t.organization_id AND pi.id = t.payment_intent_id
                        WHERE t.status <> 'DONE'
                          AND (t.lease_until IS NULL OR t.lease_until <= now())
                          AND NOT ((t.kind = 'REFUND' AND pi.status = 'CAPTURED'
                                    AND pi.failure_reason IN ('REFUND_REQUESTED', 'REFUND_UNKNOWN',
                                                              'REFUNDED_NOT_REVERSED',
                                                              'REFUND_DECLINED_RELEASE_PENDING'))
                                OR (t.kind = 'UNCREDITED_REFUND' AND pi.status = 'AUTHORIZED'
                                    AND pi.failure_reason = 'CAPTURED_REFUND_UNKNOWN'))
                          AND NOT EXISTS (SELECT 1 FROM wallet_hold h
                                           WHERE h.wallet_id = pi.wallet_id AND h.reference = pi.id
                                             AND h.reference_type = 'PAYMENT_REFUND'
                                             AND h.status = 'ACTIVE')
                          FOR UPDATE OF t SKIP LOCKED)
                RETURNING id)
           SELECT (SELECT count(*) FROM win)::int AS examined,
                  (SELECT count(*) FROM closed)::int AS closed,
                  (SELECT created_at FROM win ORDER BY created_at DESC, id DESC LIMIT 1) AS "lastCreatedAt",
                  (SELECT id FROM win ORDER BY created_at DESC, id DESC LIMIT 1) AS "lastId"`,
          limit,
          cursor.stale?.createdAt ?? EPOCH,
          cursor.stale?.id ?? '',
          PAYMENT_RECONCILER,
        ),
    );

    return {
      opened,
      closed: stale?.closed ?? 0,
      cursor: {
        // A full window may have more behind it; a short one reached the end.
        missing:
          window.length === limit && lastIntent
            ? { createdAt: lastIntent.createdAt, id: lastIntent.id }
            : null,
        stale:
          stale && stale.examined === limit && stale.lastCreatedAt && stale.lastId
            ? { createdAt: stale.lastCreatedAt, id: stale.lastId }
            : null,
      },
    };
  }

  /** Sampled for the gauges: what is waiting, what a person has, and for how long. */
  async backlog(): Promise<Backlog> {
    const rows = await runUnscoped(
      'the payment reconciliation backlog gauge counts the queue of every tenant (ADR-064)',
      () =>
        this.prisma.client.$queryRawUnsafe<
          { open: bigint; escalated: bigint; oldest: number | null }[]
        >(
          `SELECT count(*) FILTER (WHERE status = 'PENDING') AS open,
                  count(*) FILTER (WHERE status = 'ESCALATED') AS escalated,
                  extract(epoch FROM now() - min(next_attempt_at)
                          FILTER (WHERE status = 'PENDING' AND next_attempt_at <= now()))::float8 AS oldest
             FROM payment_reconciliation_task
            WHERE status <> 'DONE'`,
        ),
    );
    // An aggregate without GROUP BY answers exactly one row, even over none.
    const [row] = rows as [(typeof rows)[number]];
    return {
      open: Number(row.open),
      escalated: Number(row.escalated),
      oldestDueAgeSeconds: Math.max(0, Number(row.oldest ?? 0)),
    };
  }
}

/** Before every row: where a heal window starts over. */
const EPOCH = new Date(0);

/** Where each heal direction's next window starts; null = from the beginning. */
export interface HealCursor {
  missing: HealPosition | null;
  stale: HealPosition | null;
}

export interface HealPosition {
  createdAt: Date;
  id: string;
}

export interface HealPass {
  opened: number;
  closed: number;
  cursor: HealCursor;
}

/** Who a task finished or escalated by the sweeper is attributed to. */
export const PAYMENT_RECONCILER = 'PAYMENT_RECONCILER';

export interface ClaimedTask {
  id: string;
  organizationId: string;
  paymentIntentId: string;
  kind: PaymentReconciliationKind;
  /** Attempts before this one. */
  attempts: number;
  createdAt: Date;
  correlationId: string;
  /** The fence: every later write of the task names it. */
  leaseToken: string;
}

export interface TaskOwnership {
  verify(tx: ExtendedPrismaClient): Promise<boolean>;
  finish(tx: ExtendedPrismaClient, resolution: string, resolvedBy: string): Promise<number>;
  escalate(tx: ExtendedPrismaClient, outcome: string, countAttempt: boolean): Promise<number>;
}

export interface Backlog {
  /** PENDING tasks. */
  open: number;
  /** ESCALATED tasks: a person's. */
  escalated: number;
  /** How long the oldest due PENDING task has waited, in seconds; 0 when none. */
  oldestDueAgeSeconds: number;
}

export type PaymentReconciliationKind = 'REFUND' | 'UNCREDITED_REFUND';

export interface OpenTask {
  organizationId: string;
  paymentIntentId: string;
  kind: PaymentReconciliationKind;
  /** What was just observed, as a closed code. */
  outcome: string;
  due: 'NOW' | 'GRACE';
}

export interface CloseTask {
  organizationId: string;
  paymentIntentId: string;
  /** How it finished, as a closed code. */
  resolution: 'REFUNDED' | 'REFUND_DECLINED';
  resolvedBy: string;
}
