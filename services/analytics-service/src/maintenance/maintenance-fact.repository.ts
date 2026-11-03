import { Injectable } from '@nestjs/common';
import { getOrganizationId } from '@rasta/nest-common';
import { z } from 'zod';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { MaintenanceFact } from './maintenance-fact';

/** What recording one delivery did. */
export type RecordResult =
  | { readonly kind: 'APPLIED' }
  /** This consumer already applied this very event: nothing happened. */
  | { readonly kind: 'ALREADY_PROCESSED' }
  /** Another event already made the fact for this completion; it is returned for comparison. */
  | { readonly kind: 'FACT_HELD'; readonly held: MaintenanceFact };

/** One (type, currency) cell of an organization's completions in a window. */
export interface MaintenanceTotalsRow {
  readonly maintenanceType: string;
  readonly currency: string;
  readonly completedCount: number;
  /** Completions whose downtime the producer knew; the rest are not counted as zero. */
  readonly downtimeKnownCount: number;
  /** Exact decimal strings, summed as `numeric`: each value fits its column, a sum need not. */
  readonly downtimeMinutes: string;
  readonly totalCostMinor: string;
}

/** The fleet dashboard's read, from one statement and therefore one snapshot. */
export interface FleetMaintenanceRead {
  readonly rows: MaintenanceTotalsRow[];
  /** The earliest completion held in any window, or null when none is. */
  readonly earliestCompletion: Date | null;
}

const decimal = z.string().regex(/^\d+$/);
const count = z.number().int().nonnegative();

/** What the statement returns, checked rather than cast: a drift in the SQL fails loudly. */
const fleetMaintenanceResult = z.object({
  earliest_completion: z.date().nullable(),
  cells: z.array(
    z.object({
      maintenance_type: z.string(),
      currency: z.string(),
      completed_count: count,
      downtime_known_count: count,
      downtime_minutes: decimal,
      total_cost_minor: decimal,
    }),
  ),
});

/**
 * The maintenance facts and the projection's idempotency marker.
 *
 * Every query here is tenant-scoped: a fact is written through the guarded client under the
 * organization of the system context the consumer opened for its envelope, and read under
 * the organization a request acts for — by the guard, or, in the one raw statement, by the
 * same `getOrganizationId()` written into its predicates. Nothing here crosses the boundary
 * (`runUnscoped` appears nowhere in this service).
 */
@Injectable()
export class MaintenanceFactRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records one delivery inside `tx`: the marker first, then the fact.
   *
   * The marker is `ON CONFLICT DO NOTHING` on `(event_id, consumer_name)`, so a redelivered
   * event changes nothing. The fact is `ON CONFLICT DO NOTHING` on `(organization_id,
   * request_id)`: a second event for the same completion — which waits on the key until the
   * first commits — writes nothing and is handed the fact it found, for the caller to judge
   * the same or a contradiction. Either way the caller decides inside the same transaction,
   * so a contradiction's rollback takes its marker with it.
   */
  async record(
    tx: ExtendedPrismaClient,
    consumerName: string,
    fact: MaintenanceFact,
  ): Promise<RecordResult> {
    const marked = await tx.processedEvent.createMany({
      data: [{ eventId: fact.sourceEventId, consumerName }],
      skipDuplicates: true,
    });
    if (marked.count === 0) return { kind: 'ALREADY_PROCESSED' };

    const inserted = await tx.factMaintenance.createMany({
      data: [
        {
          organizationId: fact.organizationId,
          requestId: fact.requestId,
          assetId: fact.assetId,
          maintenanceType: fact.maintenanceType,
          scheduleId: fact.scheduleId,
          completedAt: fact.completedAt,
          downtimeMinutes: fact.downtimeMinutes,
          totalCostMinor: fact.totalCostMinor,
          currency: fact.currency,
          sourceEventId: fact.sourceEventId,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 1) return { kind: 'APPLIED' };

    const held = await tx.factMaintenance.findFirst({ where: { requestId: fact.requestId } });
    if (!held) {
      // The key refused the row and no row is visible under this tenant: impossible unless
      // the key and the guard disagree. Thrown (retried, then dead-lettered), never ignored.
      throw new Error(`fact_maintenance refused request ${fact.requestId} and holds none`);
    }
    return {
      kind: 'FACT_HELD',
      held: {
        organizationId: held.organizationId,
        requestId: held.requestId,
        assetId: held.assetId,
        maintenanceType: held.maintenanceType,
        scheduleId: held.scheduleId,
        completedAt: held.completedAt,
        downtimeMinutes: held.downtimeMinutes,
        totalCostMinor: held.totalCostMinor,
        currency: held.currency,
        sourceEventId: held.sourceEventId,
      },
    };
  }

  /**
   * Records, once and for the whole deployment, the instant this projection first ran
   * successfully (ADR-071 § 6, Q-154). **Insert-if-absent**: the first start wins and every
   * later one — a restart, a second replica, a replayed delivery — changes nothing, so the
   * instant is never moved earlier or later. The database stamps it
   * (`tg_projection_coverage_started_at`). Deployment-wide by design: consumption is not per
   * tenant, so a quiet tenant is covered as soon as the projection is. Raw SQL on a table with
   * no organization column, outside the tenant extension on purpose.
   *
   * Never called per delivery: a delivery that rolls back or is replayed cannot create or
   * advance coverage, because no delivery writes it.
   */
  async recordCoverageStart(consumerName: string): Promise<void> {
    await this.prisma.client.$executeRaw`
      INSERT INTO projection_coverage (consumer_name)
      VALUES (${consumerName})
      ON CONFLICT (consumer_name) DO NOTHING`;
  }

  /**
   * The organization's completions in `[from, to)` by type and currency, and the earliest
   * completion held in any window — a dashboard says from when it counts, so an empty window
   * is not read as "no maintenance happened" before the projection existed (ADR-071,
   * Consequences).
   *
   * **Summed in SQL as `numeric`, returned as text** (#337 r1, Medium). Every cost fits a
   * bigint, but the sum of two need not: PostgreSQL's `sum(bigint)` is already `numeric`,
   * while Prisma's `groupBy` hands it back through a 64-bit `BigInt` field and fails past
   * 2^63 − 1 — a 500 for a valid dataset. The decimal string is exact at any size; downtime
   * gets the same treatment, since a sum of valid `integer` minutes can pass 2^53.
   *
   * **One statement**, so the cells and the earliest completion come from one snapshot. Raw
   * SQL is outside the tenant extension, so the organization is in every predicate, taken
   * from the request context exactly as the guard would (`getOrganizationId`): no caller can
   * pass another. Reads `ix_fact_maintenance_org_completed`.
   */
  async fleetMaintenance(from: Date, to: Date): Promise<FleetMaintenanceRead> {
    const organizationId = getOrganizationId();
    const [result] = await this.prisma.client.$queryRaw<unknown[]>`
      SELECT
        (SELECT min(completed_at) FROM fact_maintenance
          WHERE organization_id = ${organizationId}) AS earliest_completion,
        COALESCE((
          SELECT json_agg(cell ORDER BY cell.maintenance_type, cell.currency)
          FROM (
            SELECT maintenance_type,
                   currency,
                   count(*) AS completed_count,
                   count(downtime_minutes) AS downtime_known_count,
                   COALESCE(sum(downtime_minutes::numeric), 0)::text AS downtime_minutes,
                   sum(total_cost_minor::numeric)::text AS total_cost_minor
            FROM fact_maintenance
            WHERE organization_id = ${organizationId}
              AND completed_at >= ${from}::timestamptz
              AND completed_at < ${to}::timestamptz
            GROUP BY maintenance_type, currency
          ) AS cell
        ), '[]'::json) AS cells`;

    const parsed = fleetMaintenanceResult.parse(result);
    return {
      earliestCompletion: parsed.earliest_completion,
      rows: parsed.cells.map((cell) => ({
        maintenanceType: cell.maintenance_type,
        currency: cell.currency,
        completedCount: cell.completed_count,
        downtimeKnownCount: cell.downtime_known_count,
        downtimeMinutes: cell.downtime_minutes,
        totalCostMinor: cell.total_cost_minor,
      })),
    };
  }
}
