import { SAGA_START_DB_MAX_WAIT_MS, SAGA_START_DB_TIMEOUT_MS } from '../config/operation-budgets';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { RELEASE_WATCHED_STATUSES, SAGA_CUSTODY_STATUSES } from '../order/state-machine';

export const START_BATCH_SIZE = 4;
export const START_LEASE_SECONDS = 30;
export const START_RETRY_SECONDS = 30;

export interface StartClaim {
  id: string;
  organization_id: string;
  first_possible_start_at: Date;
  age_ms: number;
  token: string;
}

/** ADR-050 fencing, on the order itself: intent and receipt are never purged.
 * The cross-tenant sweep is platform plumbing. Only persisted ownership is
 * returned; every subsequent mutation fences BOTH that buyer and the token.
 */
@Injectable()
export class SagaStartStore {
  constructor(private readonly prisma: PrismaService) {}

  private bounded<T>(fn: (tx: ExtendedPrismaClient) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '1000ms'`;
        return fn(tx as ExtendedPrismaClient);
      },
      { maxWait: SAGA_START_DB_MAX_WAIT_MS, timeout: SAGA_START_DB_TIMEOUT_MS },
    );
  }

  async claim(only?: { id: string; organizationId: string }): Promise<StartClaim[]> {
    const token = randomUUID();
    return this.bounded(
      (tx) => tx.$queryRaw<StartClaim[]>`
      WITH due AS (
        SELECT id, organization_id FROM "order"
        WHERE saga_start_delivered_at IS NULL AND status IN ('PENDING', 'CANCELLING')
          AND saga_start_next_attempt_at <= clock_timestamp()
          AND (saga_start_claim_expires_at IS NULL OR saga_start_claim_expires_at <= clock_timestamp())
          AND (${only?.id ?? null}::text IS NULL OR
            (id = ${only?.id ?? null} AND organization_id = ${only?.organizationId ?? null}))
        ORDER BY saga_start_next_attempt_at, id LIMIT ${only ? 1 : START_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "order" o SET saga_start_claim_token = ${token}::uuid,
        saga_start_claim_expires_at = clock_timestamp() + ${START_LEASE_SECONDS} * interval '1 second',
        saga_start_attempted_at = COALESCE(o.saga_start_attempted_at,
          CASE WHEN o.saga_start_requested_at IS NULL THEN o.created_at ELSE clock_timestamp() END)
      FROM due WHERE o.id = due.id AND o.organization_id = due.organization_id
      RETURNING o.id, o.organization_id, o.saga_start_attempted_at AS first_possible_start_at,
        GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - o.saga_start_attempted_at)) * 1000)::float AS age_ms,
        o.saga_start_claim_token::text AS token
    `,
    );
  }

  async finish(claim: StartClaim, accepted: boolean): Promise<number> {
    return this.bounded(
      (tx) => tx.$executeRaw`
      UPDATE "order" SET
        saga_start_delivered_at = CASE WHEN ${accepted} THEN clock_timestamp() ELSE NULL END,
        saga_start_claim_token = NULL, saga_start_claim_expires_at = NULL,
        saga_start_next_attempt_at = clock_timestamp() + ${START_RETRY_SECONDS} * interval '1 second'
      WHERE id = ${claim.id} AND organization_id = ${claim.organization_id}
        AND saga_start_claim_token = ${claim.token}::uuid
        AND saga_start_claim_expires_at > clock_timestamp() AND saga_start_delivered_at IS NULL
    `,
    );
  }

  async backlog(): Promise<{ count: number; age: number }> {
    // Counts only, no tenant labels, identifiers or amounts leave the DB.
    // created_at is UTC wall time without a zone: now is taken in UTC too, so
    // the session's TimeZone cannot shift the age.
    const [row] = await this.bounded(
      (tx) => tx.$queryRaw<{ count: bigint; age: number }[]>`
      SELECT count(*) AS count,
        COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() AT TIME ZONE 'UTC') - min(created_at)), 0)::float AS age
      FROM "order" WHERE saga_start_delivered_at IS NULL AND status IN ('PENDING', 'CANCELLING')
    `,
    );
    return { count: Number(row.count), age: Math.max(0, row.age) };
  }

  /**
   * Orders waiting on a financial step the saga owes, by reason, with the
   * oldest wait (#770 r2 F3). State, not attempts: an order counts until it
   * moves on, whether the saga retries, has stopped, or has no worker.
   *
   * - `DISPUTE_RELEASE`, first: any live order outside DISPUTED whose last
   *   dispute mirror (`disputeObligation` / `markObligationDisputed` step) is
   *   newer than its last `resolveObligationDispute` step — economic-service
   *   still holds the obligation DISPUTED (D-083). Whatever a party does next
   *   (confirms receipt, cancels), it stays this, aged from when the order
   *   left DISPUTED, so a party's move neither clears nor re-ages it.
   * - Otherwise a `SAGA_CUSTODY` status, aged from when the order last left a
   *   party's hands (a transition from a party or terminal status; else its
   *   creation), so a settlement bouncing RECEIPT_CONFIRMED ↔ SETTLING does
   *   not reset it.
   *
   * Times without a zone are UTC wall time; now is taken in UTC to match.
   * Counts and ages only leave the database.
   */
  async unresolved(): Promise<{ reason: string; count: number; age: number }[]> {
    const custody = SAGA_CUSTODY_STATUSES as string[];
    const live = RELEASE_WATCHED_STATUSES as string[];
    const rows = await this.bounded(
      (tx) => tx.$queryRaw<{ reason: string; count: bigint; age: number }[]>`
      WITH candidate AS (
        SELECT o.id, o.organization_id, o.status::text AS status, o.created_at,
          COALESCE((SELECT max(s.applied_at) FROM saga_step s
              WHERE s.organization_id = o.organization_id AND s.order_id = o.id
                AND s.activity IN ('disputeObligation', 'markObligationDisputed'))
            > COALESCE((SELECT max(s.applied_at) FROM saga_step s
              WHERE s.organization_id = o.organization_id AND s.order_id = o.id
                AND s.activity = 'resolveObligationDispute'), '-infinity'::timestamptz),
            false) AS release_owed
        FROM "order" o
        WHERE o.status::text = ANY(${live}::text[])
      ),
      owed AS (
        SELECT CASE WHEN c.release_owed THEN 'DISPUTE_RELEASE' ELSE c.status END AS reason,
          COALESCE(CASE WHEN c.release_owed THEN
            (SELECT max(h.occurred_at) FROM order_status_history h
              WHERE h.organization_id = c.organization_id AND h.order_id = c.id
                AND h.kind = 'TRANSITION' AND h.from_status = 'DISPUTED')
          ELSE
            (SELECT max(h.occurred_at) FROM order_status_history h
              WHERE h.organization_id = c.organization_id AND h.order_id = c.id
                AND h.kind = 'TRANSITION' AND NOT (h.from_status::text = ANY(${custody}::text[])))
          END, c.created_at) AS since
        FROM candidate c
        WHERE c.release_owed OR c.status = ANY(${custody}::text[])
      )
      SELECT reason, count(*) AS count,
        GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() AT TIME ZONE 'UTC') - min(since)))::float AS age
      FROM owed GROUP BY reason
    `,
    );
    return [...custody, 'DISPUTE_RELEASE'].map((reason) => {
      const row = rows.find((candidate) => candidate.reason === reason);
      return { reason, count: Number(row?.count ?? 0), age: row?.age ?? 0 };
    });
  }
}
