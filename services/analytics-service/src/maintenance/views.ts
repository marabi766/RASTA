import type { MaintenanceTotalsRow } from './maintenance-fact.repository';
import type { FleetDashboardView } from './dto';

type CompletedByType = FleetDashboardView['maintenance']['completed'][number];

/**
 * Folds the (type, currency) cells into one entry per type: counts and downtime summed across
 * currencies (they do not depend on money), cost kept per currency — never added across two.
 * Downtime is added as `bigint` and stays a decimal string, exact at any size. The repository
 * already orders the cells by type then currency, and the fold keeps that order.
 */
export function completedByType(rows: readonly MaintenanceTotalsRow[]): CompletedByType[] {
  const byType = new Map<string, { entry: CompletedByType; minutes: bigint }>();
  for (const row of rows) {
    const held = byType.get(row.maintenanceType) ?? {
      entry: {
        type: row.maintenanceType,
        count: 0,
        downtime: { knownCount: 0, totalMinutes: '0' },
        cost: [],
      },
      minutes: 0n,
    };
    held.entry.count += row.completedCount;
    held.entry.downtime.knownCount += row.downtimeKnownCount;
    held.minutes += BigInt(row.downtimeMinutes);
    held.entry.downtime.totalMinutes = held.minutes.toString();
    held.entry.cost.push({ currency: row.currency, amountMinor: row.totalCostMinor });
    byType.set(row.maintenanceType, held);
  }
  return [...byType.values()].map(({ entry }) => entry);
}

export function toFleetDashboardView(input: {
  organizationId: string;
  from: Date;
  to: Date;
  earliestCompletion: Date | null;
  rows: readonly MaintenanceTotalsRow[];
}): FleetDashboardView {
  return {
    organizationId: input.organizationId,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    earliestCompletionAt: input.earliestCompletion?.toISOString() ?? null,
    maintenance: { completed: completedByType(input.rows) },
  };
}
