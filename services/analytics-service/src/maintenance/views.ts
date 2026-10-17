import type { MaintenanceTotalsRow } from './maintenance-fact.repository';
import type { FleetDashboardView } from './dto';

type CompletedByType = FleetDashboardView['maintenance']['completed'][number];

/**
 * Folds the (type, currency) cells into one entry per type: counts and downtime summed across
 * currencies (they do not depend on money), cost kept per currency. The repository already
 * orders the cells by type then currency, and the fold keeps that order.
 */
export function completedByType(rows: readonly MaintenanceTotalsRow[]): CompletedByType[] {
  const byType = new Map<string, CompletedByType>();
  for (const row of rows) {
    const entry = byType.get(row.maintenanceType) ?? {
      type: row.maintenanceType,
      count: 0,
      downtime: { knownCount: 0, totalMinutes: 0 },
      cost: [],
    };
    entry.count += row.completedCount;
    entry.downtime.knownCount += row.downtimeKnownCount;
    entry.downtime.totalMinutes += row.downtimeMinutes;
    entry.cost.push({ currency: row.currency, amountMinor: row.totalCostMinor.toString() });
    byType.set(row.maintenanceType, entry);
  }
  return [...byType.values()];
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
