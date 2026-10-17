import { Injectable } from '@nestjs/common';
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
  readonly downtimeMinutes: number;
  readonly totalCostMinor: bigint;
}

/**
 * The maintenance facts and the projection's idempotency marker.
 *
 * Every query here runs through the tenant-guarded client: a fact is written under the
 * organization of the system context the consumer opened for its envelope, and read under
 * the organization a request acts for. Nothing here crosses the boundary (`runUnscoped`
 * appears nowhere in this service).
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
   * The organization's completions in `[from, to)`, by type and currency. One grouped read
   * over `ix_fact_maintenance_org_completed`; the organization is the request's, injected by
   * the guard.
   */
  async totals(from: Date, to: Date): Promise<MaintenanceTotalsRow[]> {
    const groups = await this.prisma.client.factMaintenance.groupBy({
      by: ['maintenanceType', 'currency'],
      where: { completedAt: { gte: from, lt: to } },
      _count: { _all: true, downtimeMinutes: true },
      _sum: { downtimeMinutes: true, totalCostMinor: true },
      orderBy: [{ maintenanceType: 'asc' }, { currency: 'asc' }],
    });
    return groups.map((group) => ({
      maintenanceType: group.maintenanceType,
      currency: group.currency,
      completedCount: group._count._all,
      downtimeKnownCount: group._count.downtimeMinutes,
      downtimeMinutes: group._sum.downtimeMinutes ?? 0,
      totalCostMinor: group._sum.totalCostMinor ?? 0n,
    }));
  }

  /**
   * The earliest completion this service holds a fact for, in any window: a dashboard says
   * from when it counts, so an empty window is not read as "no maintenance happened" before
   * the projection existed (ADR-071, Consequences).
   */
  async earliestCompletion(): Promise<Date | null> {
    const result = await this.prisma.client.factMaintenance.aggregate({
      _min: { completedAt: true },
    });
    return result._min.completedAt;
  }
}
