import { SAGA_START_DB_MAX_WAIT_MS, SAGA_START_DB_TIMEOUT_MS } from '../config/operation-budgets';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { SAGA_CUSTODY_STATUSES } from '../order/state-machine';

export const START_BATCH_SIZE = 4;
export const START_LEASE_SECONDS = 30;
export const START_RETRY_SECONDS = 30;
export const OPEN_UNCONFIRMED_CALLS_LIMIT = 1000;
/** An unresolved financial episode older than this is overdue (#792 r1 F2). */
export const UNRESOLVED_OVERDUE_SECONDS = 3600;

export interface StartClaim {
  id: string;
  organization_id: string;
  first_possible_start_at: Date;
  age_ms: number;
  token: string;
}

/** One row of `saga_unconfirmed_call` no attempt has confirmed (FU-104). */
export interface OpenUnconfirmedCall {
  organizationId: string;
  orderId: string;
  operation: string;
  /** What the call is about: for a dispute release, the order's dispute. */
  subject: string;
  /** The opening a confirmation has to name. */
  generation: number;
  /**
   * The first opening. A later attempt leaves it, so that a stuck call's age keeps
   * growing; it does not say when the attempt now running began.
   */
  openedAt: Date;
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

  /**
   * The time every saga state gauge ages against (#792 r1 F2): the database's
   * clock, never earlier than any reference handed out before. Moved forward in
   * a short transaction of its own, which holds the row only for this one
   * statement (#792 r2: a read holding it would make every other read wait);
   * a row locked past 500 ms fails the sample, never skips the move.
   *
   * A read then ages against the row as committed, taken in SQL rather than as
   * a parameter so no driver or session zone converts it, and proves it found
   * the row: a reference never runs back, and none means no sample.
   */
  private async advanceReference(): Promise<void> {
    const moved = await this.bounded(async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
      return tx.$executeRaw`
      UPDATE saga_monitor_clock SET high_water = GREATEST(high_water, clock_timestamp())
      WHERE id = 1
    `;
    });
    if (moved !== 1) throw noReference();
  }

  async backlog(): Promise<{ count: number; age: number }> {
    // Counts only, no tenant labels, identifiers or amounts leave the DB.
    // created_at is UTC wall time without a zone, read as UTC, so the session's
    // TimeZone cannot shift the age; the reference cannot run back.
    await this.advanceReference();
    const [row] = await this.bounded(
      (tx) => tx.$queryRaw<{ count: bigint; age: number; referenced: boolean }[]>`
      WITH clock AS (SELECT high_water AS now FROM saga_monitor_clock WHERE id = 1)
      SELECT count(*) AS count,
        COALESCE(EXTRACT(EPOCH FROM (SELECT now FROM clock) - min(created_at AT TIME ZONE 'UTC')),
          0)::float AS age,
        EXISTS (SELECT 1 FROM clock) AS referenced
      FROM "order" WHERE saga_start_delivered_at IS NULL AND status IN ('PENDING', 'CANCELLING')
    `,
    );
    if (!row?.referenced) throw noReference();
    return { count: Number(row.count), age: Math.max(0, row.age) };
  }

  /**
   * Unresolved financial episodes, by reason (#770 r2 F3, #792 r1 F1/F2): how
   * many, the oldest one's age, and how many are past `overdueSeconds`. State,
   * not attempts: an episode counts until it is resolved, whether the saga
   * retries, has stopped, or has no worker.
   *
   * - Each open `saga_unconfirmed_call` row (#769) is an episode of its own: one
   *   per dispute, so a second dispute, a lost step record or a clock that ran
   *   back cannot hide the first one's release. Whatever the order's status. The
   *   one row not counted is a dispute still open on an order still DISPUTED:
   *   the operator decides, nothing is due. A release is due from its dispute's
   *   decision; a row whose dispute is missing, or any other call, from its
   *   first opening. `DISPUTE_RELEASE` for a release, `UNCONFIRMED_CALL` for
   *   any other operation (none is recorded yet; counted, never dropped).
   * - An order in a `SAGA_CUSTODY` status is one more, aged from when it last
   *   left a party's hands (a transition from a party or terminal status; else
   *   its creation), so RECEIPT_CONFIRMED ↔ SETTLING and PENDING → CANCELLING do
   *   not restart it. Refund and settlement have no call record yet: status is
   *   all there is.
   *
   * Ages are taken against `advanceReference()`, so none decreases while its episode
   * lasts. Times without a zone are UTC wall time. Counts and ages only leave
   * the database.
   */
  async unresolved(
    overdueSeconds = UNRESOLVED_OVERDUE_SECONDS,
  ): Promise<{ reason: string; count: number; age: number; overdue: number }[]> {
    const custody = SAGA_CUSTODY_STATUSES as string[];
    await this.advanceReference();
    const read = await this.bounded(
      (tx) => tx.$queryRaw<
        { reason: string | null; count: bigint; age: number; overdue: bigint }[]
      >`
      WITH clock AS (SELECT high_water AS now FROM saga_monitor_clock WHERE id = 1),
      episode AS (
        SELECT CASE WHEN c.operation = 'resolveObligationDispute' THEN 'DISPUTE_RELEASE'
            ELSE 'UNCONFIRMED_CALL' END AS reason,
          COALESCE(CASE WHEN d.status <> 'OPEN' THEN d.resolved_at AT TIME ZONE 'UTC' END,
            c.opened_at) AS since
        FROM saga_unconfirmed_call c
        LEFT JOIN "order" o ON o.organization_id = c.organization_id AND o.id = c.order_id
        LEFT JOIN order_dispute d ON d.organization_id = c.organization_id
          AND d.order_id = c.order_id AND d.id = c.subject
        WHERE c.confirmed_at IS NULL
          AND NOT COALESCE(c.operation = 'resolveObligationDispute' AND d.status = 'OPEN'
            AND o.status = 'DISPUTED', false)
        UNION ALL
        SELECT o.status::text,
          COALESCE((SELECT max(h.occurred_at) FROM order_status_history h
              WHERE h.organization_id = o.organization_id AND h.order_id = o.id
                AND h.kind = 'TRANSITION' AND NOT (h.from_status::text = ANY(${custody}::text[]))),
            o.created_at) AT TIME ZONE 'UTC'
        FROM "order" o
        WHERE o.status::text = ANY(${custody}::text[])
      )
      SELECT reason, count(*) AS count,
        GREATEST(0, EXTRACT(EPOCH FROM clock.now - min(since)))::float AS age,
        count(*) FILTER (WHERE since <= clock.now - ${overdueSeconds} * interval '1 second') AS overdue
      FROM episode CROSS JOIN clock GROUP BY reason, clock.now
      -- One row with no reason, there only if the reference was: what proves an
      -- empty result is no episode, not no clock.
      UNION ALL SELECT NULL, 0, 0, 0 FROM clock
    `,
    );
    if (!read.some((row) => row.reason === null)) throw noReference();
    const rows = read.filter((row): row is typeof row & { reason: string } => row.reason !== null);
    const reasons = [...custody, 'DISPUTE_RELEASE', 'UNCONFIRMED_CALL'];
    // A reason this list does not know is still money: reported, not dropped.
    for (const row of rows) if (!reasons.includes(row.reason)) reasons.push(row.reason);
    return reasons.map((reason) => {
      const row = rows.find((candidate) => candidate.reason === reason);
      return {
        reason,
        count: Number(row?.count ?? 0),
        age: row?.age ?? 0,
        overdue: Number(row?.overdue ?? 0),
      };
    });
  }

  /**
   * The economic calls no attempt has confirmed (FU-104), oldest first, across
   * tenants: platform plumbing, never served to a party. As recorded: whether a row
   * is due, or still a call in flight, is the reader's to decide. `more` says the
   * list stopped at `limit`, so its length is not a total; a failed read throws, so
   * no reader can take it for an empty list.
   */
  async openUnconfirmedCalls(
    limit = OPEN_UNCONFIRMED_CALLS_LIMIT,
  ): Promise<{ calls: OpenUnconfirmedCall[]; more: boolean }> {
    const rows = await this.bounded(
      (tx) => tx.$queryRaw<OpenUnconfirmedCall[]>`
      SELECT organization_id AS "organizationId", order_id AS "orderId", operation, subject,
        generation, opened_at AS "openedAt"
      FROM saga_unconfirmed_call
      WHERE confirmed_at IS NULL
      ORDER BY opened_at, organization_id, order_id, operation, subject
      LIMIT ${limit + 1}
    `,
    );
    return { calls: rows.slice(0, limit), more: rows.length > limit };
  }
}

function noReference(): Error {
  return new Error('saga_monitor_clock has no row: the saga state cannot be aged');
}
