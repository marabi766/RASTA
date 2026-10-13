import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { IdempotencyStore, requireIdempotencyKey, targeted } from '../shared/idempotency';
import { CatalogueService } from './catalogue.service';
import {
  createOfferSchema,
  createProductSchema,
  searchProductsQuerySchema,
  updateOfferSchema,
  type CreateOfferDto,
  type CreateProductDto,
  type OfferView,
  type ProductView,
  type SearchProductsQuery,
  type UpdateOfferPriceDto,
} from './dto';

/**
 * Products and search (`docs/06` § Marketplace).
 *
 * The reads here are the one place a tenant deliberately sees another's rows:
 * a marketplace in which you can only see your own listings is not a
 * marketplace. Each such read is narrowed to published offers and catalogue
 * columns, and never touches an order (ADR-042 § 3).
 *
 * Every write here requires an `Idempotency-Key` (docs/06 § 6.8 lists
 * publishing an offer — ثبت پیشنهاد — among the operations that must be
 * idempotent): a double submit without one created two products or two
 * offers. The gateway requires it on the `products` and `offers` prefixes
 * for unsafe methods, and the service again, because the gateway is not the
 * only way to reach this port. The response is stored in the write's own
 * transaction, as for orders.
 */
@ApiTags('products')
@Controller({ path: 'products', version: '1' })
export class ProductController {
  constructor(
    private readonly catalogue: CatalogueService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get()
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER', 'SUPPLIER')
  @ApiOperation({
    summary: 'Search the catalogue',
    description:
      'Text matching runs on a trigram index. Sorting accepts price and lead time only — ' +
      'supplier rating lives in supplier-service, which does not exist, and accepting ' +
      '`RATING` while ordering by something else would be a lie about the result.',
  })
  async search(@Query(zodPipe(searchProductsQuerySchema)) query: SearchProductsQuery) {
    return this.catalogue.searchProducts(query);
  }

  @Get(':id')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER', 'SUPPLIER')
  @ApiOperation({
    summary: 'One product from the catalogue',
    description:
      'Visible regardless of which organization catalogued it — the same open read as search.',
  })
  async get(@Param('id') id: string) {
    return this.catalogue.getProduct(id);
  }

  @Get(':id/offers')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER', 'SUPPLIER')
  @ApiOperation({
    summary: 'Offers for one product',
    description: 'Published offers from every supplier, cheapest first by default.',
  })
  async offers(
    @Param('id') productId: string,
    @Query(zodPipe(searchProductsQuerySchema)) query: SearchProductsQuery,
  ) {
    return { items: await this.catalogue.offersFor(productId, query.sort) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'SUPPLIER')
  @ApiOperation({
    summary: 'Define a product',
    description:
      'A catalogue entry other organizations may then offer against. Requires an ' +
      '`Idempotency-Key`; the same key with the same body returns the original product ' +
      'without creating a second one.',
  })
  async create(
    @Body(zodPipe(createProductSchema)) dto: CreateProductDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.idempotency.run<ProductView>('POST /v1/products', key, dto, 201, (record) =>
      this.catalogue.createProduct(dto, record),
    );
  }
}

/**
 * Offers — the supplier's side of the catalogue.
 *
 * A supplier sees and edits only its own; the object-level check is in
 * `access.ts`, and a stranger editing another supplier's offer gets 404 rather
 * than 403 so the attempt cannot confirm the offer exists.
 */
@ApiTags('offers')
@Controller({ path: 'offers', version: '1' })
export class OfferController {
  constructor(
    private readonly catalogue: CatalogueService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get()
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'SUPPLIER', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'List the caller’s own offers',
    description: 'Every state, including drafts. Scoped to the calling organization.',
  })
  async listOwn() {
    return { items: await this.catalogue.listOwnOffers() };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'SUPPLIER', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'Publish an offer',
    description:
      'Price is in minor units as a string (ADR-022). `availableQuantity` is what the ' +
      'supplier declares it can supply — **not** warehouse stock, which belongs to ' +
      'inventory-service and does not exist. Requires an `Idempotency-Key`; the same key ' +
      'with the same body returns the original offer without publishing a second one.',
  })
  async create(
    @Body(zodPipe(createOfferSchema)) dto: CreateOfferDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.idempotency.run<OfferView>('POST /v1/offers', key, dto, 201, (record) =>
      this.catalogue.createOffer(dto, record),
    );
  }

  @Patch(':id')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'SUPPLIER', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'Reprice or restock an offer',
    description:
      'A price change increments the version and writes a history row. Orders already ' +
      'placed keep the price they agreed to — a supplier cannot reprice work already sold. ' +
      'Requires an `Idempotency-Key`; the offer id is part of the request, so the same key ' +
      'on another offer is refused with 409 IDEMPOTENCY_KEY_REUSED.',
  })
  async update(
    @Param('id') id: string,
    @Body(zodPipe(updateOfferSchema)) dto: UpdateOfferPriceDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.idempotency.run<OfferView>(
      'PATCH /v1/offers/:id',
      key,
      targeted(id, dto),
      200,
      (record) => this.catalogue.updateOffer(id, dto, record),
    );
  }
}
