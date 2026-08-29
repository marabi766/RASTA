import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { CatalogueService } from './catalogue.service';
import {
  createOfferSchema,
  createProductSchema,
  searchProductsQuerySchema,
  updateOfferSchema,
  type CreateOfferDto,
  type CreateProductDto,
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
 */
@ApiTags('products')
@Controller({ path: 'products', version: '1' })
export class ProductController {
  constructor(private readonly catalogue: CatalogueService) {}

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
    description: 'A catalogue entry other organizations may then offer against.',
  })
  async create(@Body(zodPipe(createProductSchema)) dto: CreateProductDto) {
    return this.catalogue.createProduct(dto);
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
  constructor(private readonly catalogue: CatalogueService) {}

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
      'inventory-service and does not exist.',
  })
  async create(@Body(zodPipe(createOfferSchema)) dto: CreateOfferDto) {
    return this.catalogue.createOffer(dto);
  }

  @Patch(':id')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'SUPPLIER', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'Reprice or restock an offer',
    description:
      'A price change increments the version and writes a history row. Orders already ' +
      'placed keep the price they agreed to — a supplier cannot reprice work already sold.',
  })
  async update(
    @Param('id') id: string,
    @Body(zodPipe(updateOfferSchema)) dto: UpdateOfferPriceDto,
  ) {
    return this.catalogue.updateOffer(id, dto);
  }
}
