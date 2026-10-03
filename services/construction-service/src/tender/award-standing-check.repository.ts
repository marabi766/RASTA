import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';

/**
 * What the standing-check sweeper reads and writes of `tender_award_standing_check`
 * (ADR-067 § 3, residual), the close sweeper's repository over again.
 *
 * ## Where the tenant guard is crossed
 *
 * The **queue as a whole** spans tenants: pending checks of every organization, one sweeper
 * serving them all. Claiming and the backlog reading therefore run under `runUnscoped` with a
 * written reason. Everything done **for one check** — settling it, recording its failure — names the
 * check's own `organization_id` in the predicate and runs in that tenant's context.
 *
 * Times are the database's (`clock_timestamp()`), never the application's: the lease, the backoff
 * and the ages they are compared with are one clock's.
 */

/** One check a sweeper holds the claim on: the fence is what every later write names. */
export interface ClaimedCheck {
  id: string;
  organizationId: string;
  tenderId: string;
  projectId: string;
  bidId: string;
  winnerOrganizationId: string;
  awardedBy: string;
  awardedAt: Date;
  windowStart: Date;
  fence: string;
  attempts: number;
}

export interface CheckBacklog {
  /** Checks still PENDING. */
  pending: number;
  /** How long the oldest has been pending, in seconds; 0 when none. */
  oldestPendingAgeSeconds: number;
  /** Pending for longer than the configured alert age. */
  overdue: number;
  /** The most failed attempts any pending check has; 0 when none failed. */
  maxAttempts: number;
}

@Injectable()
export class AwardStandingCheckRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claims up to `limit` pending checks in one statement: PENDING, not under a live lease, not
   * waiting out a backoff, oldest first. `FOR UPDATE SKIP LOCKED` keeps two sweepers from queueing
   * on the same rows; the reservation is the fence, which the settling transaction checks. A claim
   * changes neither what the check is about nor its attempts. `tenderId` narrows the claim to one
   * award's check (a person making it now, a test); the sweeper passes none.
   */
  claimDue(
    limit: number,
    leaseSeconds: number,
    fence: string,
    tenderId?: string,
  ): Promise<ClaimedCheck[]> {
    return runUnscoped(
      'the standing-check sweeper claims the pending checks of every tenant; each is settled in its own tenant (ADR-067 § 3)',
      () =>
        this.prisma.client.$queryRawUnsafe<ClaimedCheck[]>(
          `UPDATE "tender_award_standing_check"
              SET "lease_until" = clock_timestamp() + ($2::int * interval '1 second'),
                  "fence" = $3
            WHERE "id" IN (
                  SELECT "id" FROM "tender_award_standing_check"
                   WHERE "status" = 'PENDING'
                     AND ("lease_until" IS NULL OR "lease_until" <= clock_timestamp())
                     AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= clock_timestamp())
                     AND ($4::text IS NULL OR "tender_id" = $4)
                   ORDER BY "created_at", "id"
                   LIMIT $1
                     FOR UPDATE SKIP LOCKED)
        RETURNING "id", "organization_id" AS "organizationId", "tender_id" AS "tenderId",
                  "project_id" AS "projectId", "bid_id" AS "bidId",
                  "winner_organization_id" AS "winnerOrganizationId", "awarded_by" AS "awardedBy",
                  "awarded_at" AS "awardedAt", "window_start" AS "windowStart", "fence", "attempts"`,
          limit,
          leaseSeconds,
          fence,
          tenderId ?? null,
        ),
    );
  }

  /**
   * PENDING → DONE with its outcome, only for the holder of the fence **while its lease is live**,
   * on the database's clock. Returns the instant it was settled at, or null when the claim is no
   * longer this holder's (the lease ran out — reclaimed or not — or it is settled): nothing was
   * changed. The database holds the same line: it settles only from a live claim.
   */
  async settle(
    tx: ExtendedPrismaClient,
    input: { organizationId: string; id: string; fence: string; outcome: 'CLEAR' | 'CONFLICT' },
  ): Promise<Date | null> {
    const rows = await tx.$queryRaw<{ done_at: Date }[]>`
      UPDATE "tender_award_standing_check"
         SET "status" = 'DONE', "outcome" = ${input.outcome},
             "done_at" = clock_timestamp(), "lease_until" = NULL, "fence" = NULL,
             "next_attempt_at" = NULL
       WHERE "organization_id" = ${input.organizationId} AND "id" = ${input.id}
         AND "fence" = ${input.fence} AND "status" = 'PENDING'
         AND "lease_until" > clock_timestamp()
   RETURNING "done_at"`;
    return rows[0]?.done_at ?? null;
  }

  /**
   * A failed attempt: counted, the claim given back, and the next try pushed out by
   * `min(maxSeconds, baseSeconds × 2^attempts)`. Only the holder of the fence **with a live lease**
   * matches: a holder whose lease lapsed postpones nothing (the lapse is itself the retry).
   */
  async recordFailure(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      id: string;
      fence: string;
      baseSeconds: number;
      maxSeconds: number;
    },
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE "tender_award_standing_check"
         SET "attempts" = "attempts" + 1,
             "next_attempt_at" = clock_timestamp() + interval '1 second'
                 * LEAST(${input.maxSeconds}::double precision,
                         ${input.baseSeconds}::double precision * power(2, LEAST("attempts", 30))),
             "lease_until" = NULL, "fence" = NULL
       WHERE "organization_id" = ${input.organizationId} AND "id" = ${input.id}
         AND "fence" = ${input.fence} AND "status" = 'PENDING'
         AND "lease_until" > clock_timestamp()`;
  }

  /** Sampled for the gauges: what is pending, for how long, how many are past the alert age. */
  async backlog(alertAgeSeconds: number): Promise<CheckBacklog> {
    const rows = await runUnscoped(
      'the standing-check gauges count the pending checks of every tenant (ADR-067 § 3)',
      () =>
        this.prisma.client.$queryRawUnsafe<
          { pending: bigint; oldest: number | null; overdue: bigint; attempts: number | null }[]
        >(
          `SELECT count(*) AS pending,
                  extract(epoch FROM clock_timestamp() - min("created_at")) AS oldest,
                  count(*) FILTER (WHERE "created_at" <= clock_timestamp() - ($1::int * interval '1 second')) AS overdue,
                  max("attempts") AS attempts
             FROM "tender_award_standing_check"
            WHERE "status" = 'PENDING'`,
          alertAgeSeconds,
        ),
    );
    const row = rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      oldestPendingAgeSeconds: Math.max(0, Number(row?.oldest ?? 0)),
      overdue: Number(row?.overdue ?? 0),
      maxAttempts: Number(row?.attempts ?? 0),
    };
  }
}
