import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { TenderStateName } from './tender.state-machine';

/**
 * What the close sweeper reads and writes of the tender table (ADR-065 § 3).
 *
 * ## Where the tenant guard is crossed
 *
 * The **queue as a whole** spans tenants: overdue tenders of every organization, one
 * sweeper serving them all. Claiming and the backlog reading therefore run under
 * `runUnscoped` with a written reason. Everything done **for one tender** — locking
 * it, counting its bids, closing it, releasing its lease — names the tender's own
 * `organization_id` in the predicate and runs in that tenant's context.
 *
 * Times are the database's (`clock_timestamp()`), never the application's: the lease
 * and the deadline it is compared with are one clock's.
 */

/** One tender a sweeper holds the claim on: the fence is what every later write names. */
export interface ClaimedTender {
  id: string;
  organizationId: string;
  fence: string;
}

/** The tender row under the close lock: enough to decide, nothing more. */
export interface TenderForClose {
  id: string;
  organizationId: string;
  projectId: string;
  status: TenderStateName;
  version: number;
  bidClosingAt: Date | null;
  fence: string | null;
}

export interface CloseBacklog {
  /** PUBLISHED tenders past their deadline. */
  overdue: number;
  /** How long the oldest has been past it, in seconds; 0 when none. */
  oldestOverdueAgeSeconds: number;
}

@Injectable()
export class TenderCloseRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claims up to `limit` overdue tenders in one statement: PUBLISHED, past the
   * deadline on the database's clock, not under a live lease, oldest deadline first.
   * `FOR UPDATE SKIP LOCKED` keeps two sweepers from queueing on the same rows (and
   * skips a tender a bidder holds `FOR SHARE` at this instant — it is claimed on the
   * next sweep); the reservation is the fence, which the closing transaction checks
   * before it reads or writes anything. `version` and `updated_at` are not touched:
   * a claim is not a change of the tender.
   *
   * This is a first cut, not the decision: the deadline is judged again after the
   * tender is locked, on a clock read then (ADR-065 § 2).
   */
  claimDue(limit: number, leaseSeconds: number, fence: string): Promise<ClaimedTender[]> {
    return runUnscoped(
      'the close sweeper claims overdue tenders of every tenant; each is then closed in its own tenant (ADR-065 § 3)',
      () =>
        this.prisma.client.$queryRawUnsafe<ClaimedTender[]>(
          `UPDATE "tender"
              SET "close_lease_until" = clock_timestamp() + ($2::int * interval '1 second'),
                  "close_fence" = $3
            WHERE "id" IN (
                  SELECT "id" FROM "tender"
                   WHERE "status"::text = 'PUBLISHED'
                     AND "bid_closing_at" <= clock_timestamp()
                     AND ("close_lease_until" IS NULL OR "close_lease_until" <= clock_timestamp())
                   ORDER BY "bid_closing_at", "id"
                   LIMIT $1
                     FOR UPDATE SKIP LOCKED)
        RETURNING "id", "organization_id" AS "organizationId", "close_fence" AS "fence"`,
          limit,
          leaseSeconds,
          fence,
        ),
    );
  }

  /**
   * Locks the tender row for the rest of the transaction — the same lock `close`,
   * `open-bids` and every owner command take, which bids share — and reads what the
   * decision needs. Scoped to the tender's own organization.
   */
  async lockForClose(
    tx: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
  ): Promise<TenderForClose | null> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        organization_id: string;
        project_id: string;
        status: TenderStateName;
        version: number;
        bid_closing_at: Date | null;
        close_fence: string | null;
      }[]
    >`
      SELECT "id", "organization_id", "project_id", "status"::text AS "status", "version",
             "bid_closing_at", "close_fence"
        FROM "tender"
       WHERE "organization_id" = ${organizationId} AND "id" = ${tenderId}
       FOR UPDATE`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      status: row.status,
      version: row.version,
      bidClosingAt: row.bid_closing_at,
      fence: row.close_fence,
    };
  }

  /**
   * The bids standing: submitted and not withdrawn. Read under the tender's lock,
   * which every bid write shares, so the count cannot change before the commit.
   */
  countStandingBids(tx: ExtendedPrismaClient, tenderId: string): Promise<number> {
    return tx.bid.count({ where: { tenderId, status: 'SUBMITTED' } });
  }

  /**
   * PUBLISHED → CLOSED: compare-and-set on status and version, who and when, and the
   * lease cleared in the same statement. Returns the rows matched: 0 or 1.
   */
  async closeTender(
    tx: ExtendedPrismaClient,
    input: { tenderId: string; expectedVersion: number; actor: string; at: Date },
  ): Promise<number> {
    const result = await tx.tender.updateMany({
      where: { id: input.tenderId, status: 'PUBLISHED', version: input.expectedVersion },
      data: {
        status: 'CLOSED',
        closedAt: input.at,
        closedBy: input.actor,
        closeLeaseUntil: null,
        closeFence: null,
        statusChangedAt: input.at,
        statusChangedBy: input.actor,
        updatedAt: input.at,
        updatedBy: input.actor,
        version: { increment: 1 },
      },
    });
    return result.count;
  }

  /**
   * Lets go of the claim without closing: the tender stays PUBLISHED and is claimable
   * at once. Only the holder's fence matches; another sweeper's claim is left alone.
   */
  async releaseClaim(
    tx: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
    fence: string,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE "tender" SET "close_lease_until" = NULL, "close_fence" = NULL
       WHERE "organization_id" = ${organizationId} AND "id" = ${tenderId}
         AND "close_fence" = ${fence}`;
  }

  /** Sampled for the gauges: what is overdue, and for how long. */
  async backlog(): Promise<CloseBacklog> {
    const rows = await runUnscoped(
      'the close backlog gauge counts the overdue tenders of every tenant (ADR-065 § 3)',
      () =>
        this.prisma.client.$queryRawUnsafe<{ overdue: bigint; oldest: number | null }[]>(
          `SELECT count(*) AS overdue,
                  extract(epoch FROM clock_timestamp() - min("bid_closing_at")) AS oldest
             FROM "tender"
            WHERE "status"::text = 'PUBLISHED' AND "bid_closing_at" <= clock_timestamp()`,
        ),
    );
    const row = rows[0];
    return {
      overdue: Number(row?.overdue ?? 0),
      oldestOverdueAgeSeconds: Math.max(0, Number(row?.oldest ?? 0)),
    };
  }
}
