import type { WarehouseView } from './dto';
import type { WarehouseRow } from './warehouse.repository';

export function toWarehouseView(row: WarehouseRow): WarehouseView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    location:
      row.latitude === null || row.longitude === null
        ? null
        : { latitude: row.latitude, longitude: row.longitude },
    status: 'ACTIVE',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}
