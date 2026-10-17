import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import type { DemandAggregation } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';

/**
 * What the window sweeper reads and writes of the aggregation table (ADR-070 § 2, plan PR 2; the
 * shape of construction's `TenderCloseRepository`, ADR-065 § 3).
 *
 * ## Where the tenant guard is crossed
 *
 * The **queue as a whole** spans tenants: due windows of every organization, one sweeper serving
 * them all. Claiming and the backlog reading therefore run under `runUnscoped` with a written
 * reason. Everything done **for one window** — locking it, ending it, moving its demands, renewing
 * or releasing its lease — names the window's own `organization_id` in the predicate and runs in
 * that tenant's context (`WindowSweepService`).
 *
 * Times are the database's (`clock_timestamp()`), never the application's: the lease and the end it
 * is compared with are one clock's. A claim, its renewal, its release and a failed attempt are
 * bookkeeping: `demand_aggregation_guard` lets them through without a version, and the deferred
 * totals check skips them (the window's totals do not move).
 */

/** One window a sweeper holds the claim on: the fence is what every later write names. */
export interface ClaimedWindow {
  id: string;
  organizationId: string;
  fence: string;
}

export interface SweepBacklog {
  /** OPEN windows past their end. */
  due: number;
  /** How long the oldest has been past it, in seconds; 0 when none. */
  oldestDueAgeSeconds: number;
  /** Live demands of ended windows still to follow them. */
  demandsToFollow: number;
  /** The most failed sweep attempts of any window still to sweep; 0 when none failed. */
  maxAttempts: number;
  /** The largest extension count of an OPEN window; 0 when none. */
  maxExtensionCount: number;
}

@Injectable()
export class WindowSweepRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claims up to `limit` windows in one statement: OPEN and past `closes_at` on the database's
   * clock, or ended with demands still to follow or its digest (and so its event) still being
   * built; not under a live lease, not in a failed
   * attempt's backoff; the earliest end first. `FOR UPDATE SKIP LOCKED` keeps two sweepers from
   * queueing on the same rows — and skips a window a demand holds locked at this instant (it is
   * claimed on the next sweep, if that demand did not end it). The fence is what the window's own
   * transaction checks before it reads or writes anything.
   *
   * A first cut, not the decision: the end is judged again after the window is locked, on a clock
   * read then.
   */
  claimDue(limit: number, leaseSeconds: number, fence: string): Promise<ClaimedWindow[]> {
    return runUnscoped(
      'the window sweeper claims due aggregation windows of every tenant; each is then swept in its own tenant (ADR-070 § 2)',
      () =>
        this.prisma.client.$queryRawUnsafe<ClaimedWindow[]>(
          `UPDATE "demand_aggregation"
              SET "sweep_lease_until" = clock_timestamp() + ($2::int * interval '1 second'),
                  "sweep_fence" = $3
            WHERE "id" IN (
                  SELECT "id" FROM "demand_aggregation"
                   WHERE (("status" = 'OPEN' AND "closes_at" <= clock_timestamp())
                          OR "demands_to_follow" > 0 OR "end_digest_state" IS NOT NULL)
                     AND ("sweep_lease_until" IS NULL OR "sweep_lease_until" <= clock_timestamp())
                     AND ("sweep_next_attempt_at" IS NULL OR "sweep_next_attempt_at" <= clock_timestamp())
                   ORDER BY "closes_at", "id"
                   LIMIT $1
                     FOR UPDATE SKIP LOCKED)
        RETURNING "id", "organization_id" AS "organizationId", "sweep_fence" AS "fence"`,
          limit,
          leaseSeconds,
          fence,
        ),
    );
  }

  /**
   * Locks the window row for the rest of the transaction — the lock a demand's submit, its
   * withdrawal and a cancellation take first — and reads it. Scoped to its own organization.
   */
  async lockForSweep(
    tx: ExtendedPrismaClient,
    organizationId: string,
    id: string,
  ): Promise<DemandAggregation | null> {
    await tx.$queryRaw`
      SELECT 1 FROM demand_aggregation WHERE organization_id = ${organizationId} AND id = ${id}
      FOR UPDATE`;
    return tx.demandAggregation.findFirst({ where: { organizationId, id } });
  }

  /** The holder keeps its claim for another `leaseSeconds` (between two batches of one window). */
  async renew(
    tx: ExtendedPrismaClient,
    window: { organizationId: string; id: string },
    fence: string,
    leaseSeconds: number,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE demand_aggregation
         SET sweep_lease_until = clock_timestamp() + (${leaseSeconds}::int * interval '1 second')
       WHERE organization_id = ${window.organizationId} AND id = ${window.id}
         AND sweep_fence = ${fence}`;
  }

  /**
   * Lets go of the claim: done with the window, or nothing to do. Its failures are forgotten — the
   * window was swept. Only the holder's fence matches; another sweeper's claim is left alone.
   */
  async release(
    tx: ExtendedPrismaClient,
    window: { organizationId: string; id: string },
    fence: string,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE demand_aggregation
         SET sweep_lease_until = NULL, sweep_fence = NULL, sweep_attempts = 0,
             sweep_next_attempt_at = NULL
       WHERE organization_id = ${window.organizationId} AND id = ${window.id}
         AND sweep_fence = ${fence}`;
  }

  /**
   * A failed attempt: counted, the claim given back, and the next try pushed out by
   * `min(maxSeconds, baseSeconds × 2^attempts)` on the database's clock. Only the holder's fence
   * matches. Its own transaction (the sweeping one rolled back), in the window's tenant.
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
      UPDATE demand_aggregation
         SET sweep_attempts = sweep_attempts + 1,
             sweep_next_attempt_at = clock_timestamp() + interval '1 second'
                 * LEAST(${input.maxSeconds}::double precision,
                         ${input.baseSeconds}::double precision * power(2, LEAST(sweep_attempts, 30))),
             sweep_lease_until = NULL,
             sweep_fence = NULL
       WHERE organization_id = ${input.organizationId} AND id = ${input.id}
         AND sweep_fence = ${input.fence}`;
  }

  /** Sampled for the gauges: what is due, for how long, what still follows, the worst retries. */
  async backlog(): Promise<SweepBacklog> {
    const rows = await runUnscoped(
      'the window sweep gauges count the due aggregation windows of every tenant (ADR-070 § 2)',
      () =>
        this.prisma.client.$queryRawUnsafe<
          {
            due: bigint;
            oldest: number | null;
            following: bigint | null;
            attempts: number | null;
            extensions: number | null;
          }[]
        >(
          `SELECT count(*) FILTER (WHERE "status" = 'OPEN' AND "closes_at" <= clock_timestamp()) AS due,
                  extract(epoch FROM clock_timestamp() - min("closes_at")
                    FILTER (WHERE "status" = 'OPEN' AND "closes_at" <= clock_timestamp())) AS oldest,
                  sum("demands_to_follow") AS following,
                  max("sweep_attempts")
                    FILTER (WHERE ("status" = 'OPEN' AND "closes_at" <= clock_timestamp())
                                  OR "demands_to_follow" > 0
                                  OR "end_digest_state" IS NOT NULL) AS attempts,
                  max("extension_count") FILTER (WHERE "status" = 'OPEN') AS extensions
             FROM "demand_aggregation"
            WHERE "status" = 'OPEN' OR "demands_to_follow" > 0 OR "end_digest_state" IS NOT NULL`,
        ),
    );
    const row = rows[0];
    return {
      due: Number(row?.due ?? 0),
      oldestDueAgeSeconds: Math.max(0, Number(row?.oldest ?? 0)),
      demandsToFollow: Number(row?.following ?? 0),
      maxAttempts: Number(row?.attempts ?? 0),
      maxExtensionCount: Number(row?.extensions ?? 0),
    };
  }
}
