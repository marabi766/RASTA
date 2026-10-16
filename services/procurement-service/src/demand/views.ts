import type { DemandAggregation, DemandRequest } from '../generated/prisma';
import type { ShortfallPolicy } from '../config/env';
import type { AggregationStateName, DemandStateName } from './demand.state-machine';
import type { AggregationView, DemandView } from './dto';

/** A demand row as the API shows it: every instant in UTC, the note and reason only here. */
export function toDemandView(row: DemandRequest): DemandView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    productId: row.productId,
    quantity: row.quantity,
    status: row.status as DemandStateName,
    aggregationId: row.aggregationId,
    note: row.note,
    submittedAt: row.submittedAt.toISOString(),
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    withdrawReason: row.withdrawReason,
    version: row.version,
  };
}

/**
 * An aggregation row as the API shows it. The total is a bigint column held to MAX_QUANTITY by its
 * CHECK, so it is an exact JavaScript number.
 */
export function toAggregationView(row: DemandAggregation): AggregationView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    productId: row.productId,
    status: row.status as AggregationStateName,
    openedAt: row.openedAt.toISOString(),
    closesAt: row.closesAt.toISOString(),
    totalQuantity: Number(row.totalQuantity),
    demandCount: row.demandCount,
    extensionCount: row.extensionCount,
    setting: {
      windowHours: row.windowHours,
      minQuantity: row.minQuantity,
      shortfallPolicy: row.shortfallPolicy as ShortfallPolicy,
      settingVersion: row.settingVersion,
    },
    closedAt: row.closedAt?.toISOString() ?? null,
    rfqId: row.rfqId,
    version: row.version,
  };
}
