import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import { InventoryAccess } from '../access/access';
import { SERVICE_NAME, type InventoryEnv } from '../config/env';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { inventoryCommandsTotal } from '../observability/metrics';
import { PrismaService } from '../prisma/prisma.service';
import { transactionNow } from '../shared/clock';
import { pageOf, type CursorPage } from '../shared/dto';
import type { ClaimFence } from '../shared/idempotency';
import { ENV } from '../tokens';
import type { CreateWarehouseDto, ListWarehousesQuery, WarehouseView } from './dto';
import { toWarehouseView } from './views';
import { WarehouseRepository } from './warehouse.repository';

/**
 * Warehouses (ADR-056 § 5): created by an operator of the organization that will own and operate
 * the warehouse — any organization, never assumed to be a union — and read by its own people.
 * Every other organization finds them `404`.
 */
@Injectable()
export class WarehouseService {
  constructor(
    private readonly warehouses: WarehouseRepository,
    private readonly access: InventoryAccess,
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
    @Inject(ENV) private readonly env: InventoryEnv,
  ) {}

  /**
   * Creates an ACTIVE warehouse owned by the organization the request acts for. A body that names
   * another organization is refused `403` (ADR-056 § 5, negative test 5): the resource does not
   * exist yet, so there is nothing to hide behind a `404` — the caller simply may not act for it.
   */
  async create(dto: CreateWarehouseDto, fence: ClaimFence<WarehouseView>): Promise<WarehouseView> {
    const acting = this.access.assertOperator();
    if (dto.organizationId !== undefined && dto.organizationId !== acting.organizationId) {
      inventoryCommandsTotal.inc({
        service: SERVICE_NAME,
        command: 'create_warehouse',
        outcome: 'refused',
      });
      throw RastaError.forbidden(
        'A warehouse is created for the organization the request acts for, and no other',
      );
    }

    return this.prisma.transaction(
      async (tx) => {
        await fence.hold(tx);
        const at = await transactionNow(tx);
        const row = await this.warehouses.insert(tx, {
          id: newId(ID_PREFIX.warehouse),
          organizationId: acting.organizationId,
          name: dto.name,
          location: dto.location ?? null,
          actor: acting.userId,
          correlationId: getContext().correlationId,
          at,
        });
        await this.publisher.enqueue(tx, {
          eventName: 'WAREHOUSE_CREATED',
          aggregateId: row.id,
          organizationId: row.organizationId,
          occurredAt: at,
          payload: {
            warehouseId: row.id,
            organizationId: row.organizationId,
            createdBy: acting.userId,
            createdAt: at.toISOString(),
          },
        });
        inventoryCommandsTotal.inc({
          service: SERVICE_NAME,
          command: 'create_warehouse',
          outcome: 'applied',
        });
        return fence.complete(tx, toWarehouseView(row));
      },
      { maxWaitMs: this.env.INVENTORY_LOCK_TIMEOUT_MS },
    );
  }

  async get(id: string): Promise<WarehouseView> {
    const { organizationId } = this.access.assertReader();
    const row = await this.warehouses.find(organizationId, id);
    if (!row) throw RastaError.notFound('Warehouse', id);
    return toWarehouseView(row);
  }

  async list(query: ListWarehousesQuery): Promise<CursorPage<WarehouseView>> {
    const { organizationId } = this.access.assertReader();
    const rows = await this.warehouses.list(organizationId, {
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: query.limit,
    });
    return pageOf(rows, query.limit, toWarehouseView);
  }

  /** Whether the caller may still see this warehouse (the replay of a create). */
  async assertVisible(id: string): Promise<void> {
    await this.get(id);
  }
}
