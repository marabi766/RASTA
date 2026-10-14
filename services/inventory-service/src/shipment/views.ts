import type { ShipmentView, TrackingView } from './dto';
import type { ShipmentLegRow, ShipmentRow, TrackingEventRow } from './shipment.repository';

export function toShipmentView(row: ShipmentRow, legs: readonly ShipmentLegRow[]): ShipmentView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    originWarehouseId: row.originWarehouseId,
    consigneeOrganizationId: row.consigneeOrganizationId,
    orderReference: row.orderReference,
    status: row.status,
    legs: legs.map((leg) => ({
      sequence: leg.sequence,
      carrierName: leg.carrierName,
      carrierReference: leg.carrierReference,
    })),
    createdAt: row.createdAt.toISOString(),
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

export function toTrackingView(
  row: ShipmentRow,
  events: readonly TrackingEventRow[],
): TrackingView {
  return {
    shipmentId: row.id,
    status: row.status,
    originWarehouseId: row.originWarehouseId,
    consigneeOrganizationId: row.consigneeOrganizationId,
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt.toISOString(),
      recordedAt: event.recordedAt.toISOString(),
    })),
  };
}
