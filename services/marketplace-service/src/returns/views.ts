import type { ReturnRequestView } from './dto';
import type { ReturnRequestRow } from './return.repository';

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function toReturnView(row: ReturnRequestRow): ReturnRequestView {
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    version: row.version,
    buyerOrganizationId: row.organizationId,
    supplierOrganizationId: row.supplierOrganizationId,
    reason: row.reason,
    lines: row.lines.map((line) => ({
      orderLineId: line.orderLineId,
      productId: line.productId,
      quantity: line.quantity,
    })),
    requestedAt: row.requestedAt.toISOString(),
    requestedBy: row.requestedBy,
    authorizedAt: iso(row.authorizedAt),
    authorizedBy: row.authorizedBy,
    rejectedAt: iso(row.rejectedAt),
    rejectedBy: row.rejectedBy,
    cancelledAt: iso(row.cancelledAt),
    cancelledBy: row.cancelledBy,
    cancelledFrom: row.cancelledFrom,
    returnShipmentId: row.returnShipmentId,
    inTransitAt: iso(row.inTransitAt),
    receivedAt: iso(row.receivedAt),
    inspectedAt: iso(row.inspectedAt),
    inspectionReportDocumentId: row.inspectionReportDocumentId,
    resolvedAt: iso(row.resolvedAt),
  };
}
