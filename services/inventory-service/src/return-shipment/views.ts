import type { ReturnShipmentView, ReturnTrackingView } from './dto';
import type {
  ReturnDispositionRow,
  ReturnShipmentLineRow,
  ReturnShipmentRow,
  ReturnTrackingEventRow,
} from './return-shipment.repository';

export function toReturnShipmentView(
  row: ReturnShipmentRow,
  lines: readonly ReturnShipmentLineRow[],
  dispositions: readonly ReturnDispositionRow[] = [],
): ReturnShipmentView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    destinationWarehouseId: row.destinationWarehouseId,
    buyerOrganizationId: row.buyerOrganizationId,
    returnRequestId: row.returnRequestId,
    orderId: row.orderId,
    status: row.status,
    lines: lines.map((line) => ({
      orderLineId: line.orderLineId,
      productId: line.productId,
      expectedQuantity: line.expectedQuantity,
      receivedQuantity: line.receivedQuantity,
    })),
    carrierName: row.carrierName,
    carrierReference: row.carrierReference,
    createdAt: row.createdAt.toISOString(),
    receivedAt: row.receivedAt?.toISOString() ?? null,
    inspectedAt: row.inspectedAt?.toISOString() ?? null,
    inspectionNote: row.inspectionNote,
    inspectionReportDocumentId: row.inspectionReportDocumentId,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    dispositions: dispositions.map((disposition) => ({
      orderLineId: disposition.orderLineId,
      disposition: disposition.disposition,
      quantity: disposition.quantity,
    })),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

export function toReturnTrackingView(
  row: ReturnShipmentRow,
  events: readonly ReturnTrackingEventRow[],
): ReturnTrackingView {
  return {
    returnShipmentId: row.id,
    status: row.status,
    destinationWarehouseId: row.destinationWarehouseId,
    buyerOrganizationId: row.buyerOrganizationId,
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt.toISOString(),
      recordedAt: event.recordedAt.toISOString(),
    })),
  };
}
