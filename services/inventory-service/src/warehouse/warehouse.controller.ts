import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import type { CursorPage } from '../shared/dto';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import { COMMAND_NOTE, READ_NOTE } from '../shared/notes';
import {
  createWarehouseSchema,
  listWarehousesQuerySchema,
  type CreateWarehouseDto,
  type ListWarehousesQuery,
  type WarehouseView,
} from './dto';
import { WarehouseService } from './warehouse.service';

/** The route template the idempotency store keys on: a closed set, never an id. */
export const CREATE_WAREHOUSE_ENDPOINT = 'POST /v1/warehouses';

/**
 * The warehouse API. HTTP ↔ DTO and nothing else (AGENTS.md A-10); no handler names a role —
 * who may act is configuration (`InventoryAccess`).
 */
@ApiTags('warehouses')
@Controller({ path: 'warehouses', version: '1' })
export class WarehouseController {
  constructor(
    private readonly warehouses: WarehouseService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List the warehouses of the organization the request acts for, newest first',
    description: READ_NOTE,
  })
  async list(
    @Query(zodPipe(listWarehousesQuerySchema)) query: ListWarehousesQuery,
  ): Promise<CursorPage<WarehouseView>> {
    return this.warehouses.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one warehouse', description: READ_NOTE })
  async get(@Param('id') id: string): Promise<WarehouseView> {
    return this.warehouses.get(id);
  }

  @RequirePlatformUserId()
  @Post()
  @HttpCode(201)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization.',
  })
  @ApiOperation({
    summary: 'Create a warehouse, owned by the organization the request acts for',
    description:
      'The owner is the organization the request acts for — any organization, never assumed to ' +
      'be a union (ADR-056 § 5). A body that names another organization in `organizationId` is ' +
      '403 FORBIDDEN, and so is acting for an organization the caller is not a member of ' +
      '(TENANT_MISMATCH). The warehouse is ACTIVE; there is no lifecycle yet (Q-108). ' +
      'WAREHOUSE_CREATED carries identifiers and the instant only — no name, no location. ' +
      COMMAND_NOTE,
  })
  async create(
    @Body(zodPipe(createWarehouseSchema)) dto: CreateWarehouseDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<WarehouseView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<WarehouseView>(
      CREATE_WAREHOUSE_ENDPOINT,
      key,
      dto,
      201,
      (fence) => this.warehouses.create(dto, fence),
      (stored) => this.warehouses.assertVisible(stored.id),
    );
    return result;
  }
}
