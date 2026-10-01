import { Inject, Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { getContext, runUnscoped } from '@rasta/nest-common';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
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
 * intent in that organization. The sweeper's cross-tenant claim is step B2's
 * and is not here.
 *
 * Times come from the database's `now()`, never the application clock: a due
 * time and the lease it is later compared with must be one clock's (as in
 * #148's queue).
 */
@Injectable()
export class PaymentReconciliationRepository {
  constructor(@Inject(ENV) private readonly env: EconomicEnv) {}

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
