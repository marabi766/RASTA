import { SAGA_START_DB_MAX_WAIT_MS, SAGA_START_DB_TIMEOUT_MS } from '../config/operation-budgets';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';

export const START_BATCH_SIZE = 4;
export const START_LEASE_SECONDS = 30;
export const START_RETRY_SECONDS = 30;
/** From the decision, past any one activity: three attempts of 30 seconds, and their backoff. */
export const UNCONFIRMED_CALL_GRACE_SECONDS = 300;

export interface StartClaim {
  id: string;
  organization_id: string;
  first_possible_start_at: Date;
  age_ms: number;
  token: string;
}

export interface UnconfirmedCalls {
  calls: { operation: string; count: number }[];
  /** Epoch seconds by the database clock, before and after the count's snapshot. */
  startedAt: number;
  finishedAt: number;
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
    const [row] = await this.bounded(
      (tx) => tx.$queryRaw<{ count: bigint; age: number }[]>`
      SELECT count(*) AS count,
        COALESCE(EXTRACT(EPOCH FROM clock_timestamp() - min(created_at)), 0)::float AS age
      FROM "order" WHERE saga_start_delivered_at IS NULL AND status IN ('PENDING', 'CANCELLING')
    `,
    );
    return { count: Number(row.count), age: Math.max(0, row.age) };
  }

  /**
   * Counts only, as `backlog`. By the database clock, across tenants: platform
   * plumbing. A dispute still open has nothing to release yet. A row naming no
   * dispute of its order counts: what cannot be read as waiting is not cleared.
   *
   * The two times bracket the statement's snapshot, by the one clock replicas
   * share, so that their reads can be put in order: a zero whose `startedAt` is past
   * a positive read's `finishedAt` looked strictly later, and a counted call only
   * leaves the count by being confirmed. The transaction's time, because a prepared
   * statement takes its snapshot before `statement_timestamp()` last moves.
   */
  async unconfirmedCalls(graceSeconds = UNCONFIRMED_CALL_GRACE_SECONDS): Promise<UnconfirmedCalls> {
    const rows = await this.bounded(
      (tx) => tx.$queryRaw<
        { operation: string | null; count: bigint | null; started: number; finished: number }[]
      >`
      SELECT g.operation, g.count,
        EXTRACT(EPOCH FROM transaction_timestamp())::float AS started,
        EXTRACT(EPOCH FROM clock_timestamp())::float AS finished
      FROM (SELECT 1) AS one LEFT JOIN (
        SELECT c.operation, count(*) AS count
        FROM saga_unconfirmed_call c
        LEFT JOIN order_dispute d ON d.id = c.subject
          AND d.organization_id = c.organization_id AND d.order_id = c.order_id
        WHERE c.confirmed_at IS NULL AND (d.id IS NULL OR d.status <> 'OPEN')
          AND COALESCE(d.resolved_at AT TIME ZONE 'UTC', c.opened_at)
            <= clock_timestamp() - ${graceSeconds} * interval '1 second'
        GROUP BY c.operation
      ) AS g ON true
    `,
    );
    return {
      startedAt: rows[0].started,
      finishedAt: Math.max(...rows.map((row) => row.finished)),
      calls: rows.flatMap((row) =>
        row.operation === null ? [] : [{ operation: row.operation, count: Number(row.count) }],
      ),
    };
  }
}
