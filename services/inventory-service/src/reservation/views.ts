import type { ReservationView } from './dto';

type ReservationLike = {
  id: string;
  organizationId: string;
  warehouseId: string;
  stockItemId: string;
  holderOrganizationId: string;
  orderReference: string | null;
  quantity: number;
  status: ReservationView['status'];
  expiresAt: Date | null;
  createdAt: Date;
  createdBy: string;
  endedAt: Date | null;
  endedBy: string | null;
  updatedAt: Date;
  version: number;
};

export function toReservationView(row: ReservationLike): ReservationView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    warehouseId: row.warehouseId,
    stockItemId: row.stockItemId,
    holderOrganizationId: row.holderOrganizationId,
    orderReference: row.orderReference,
    quantity: row.quantity,
    status: row.status,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    endedAt: row.endedAt?.toISOString() ?? null,
    endedBy: row.endedBy,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}
