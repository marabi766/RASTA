import type { StockItemView, StockMovementView } from './dto';

type ItemLike = {
  id: string;
  organizationId: string;
  warehouseId: string;
  productId: string;
  onHandQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

type MovementLike = {
  id: string;
  stockItemId: string;
  warehouseId: string;
  type: StockMovementView['type'];
  onHandDelta: number;
  reservedDelta: number;
  onHandAfter: number;
  reservedAfter: number;
  itemVersion: number;
  reservationId: string | null;
  sourceReference: string | null;
  createdAt: Date;
  createdBy: string;
};

export function toStockItemView(row: ItemLike): StockItemView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    warehouseId: row.warehouseId,
    productId: row.productId,
    onHandQuantity: row.onHandQuantity,
    reservedQuantity: row.reservedQuantity,
    availableQuantity: row.availableQuantity,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toStockMovementView(row: MovementLike): StockMovementView {
  return {
    id: row.id,
    stockItemId: row.stockItemId,
    warehouseId: row.warehouseId,
    type: row.type,
    onHandDelta: row.onHandDelta,
    reservedDelta: row.reservedDelta,
    onHandAfter: row.onHandAfter,
    reservedAfter: row.reservedAfter,
    itemVersion: row.itemVersion,
    reservationId: row.reservationId,
    sourceReference: row.sourceReference,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
  };
}
