/**
 * What every stock event says about the item it moved (`events.ts`): which item, where, the
 * movement, and the balance and ledger position it left.
 */
export function stockFacts(
  item: {
    id: string;
    warehouseId: string;
    productId: string;
    organizationId: string;
    version: number;
    onHandQuantity: number;
    reservedQuantity: number;
  },
  movementId: string,
) {
  return {
    stockItemId: item.id,
    warehouseId: item.warehouseId,
    productId: item.productId,
    organizationId: item.organizationId,
    movementId,
    itemVersion: item.version,
    onHandAfter: item.onHandQuantity,
    reservedAfter: item.reservedQuantity,
  };
}

/** What every reservation event says about the reservation. */
export function reservationFacts(reservation: {
  id: string;
  holderOrganizationId: string;
  orderReference: string | null;
  quantity: number;
}) {
  return {
    reservationId: reservation.id,
    holderOrganizationId: reservation.holderOrganizationId,
    orderReference: reservation.orderReference,
    quantity: reservation.quantity,
  };
}
