import { Injectable } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { MARKETPLACE_EVENTS } from '../events/events';
import { assertNotAuditor, assertOfferOwner } from '../access/access';
import { SERVICE_NAME } from '../config/env';
import { productSearchesTotal } from '../observability/metrics';
import type {
  CreateOfferDto,
  CreateProductDto,
  OfferView,
  ProductView,
  SearchProductsQuery,
  UpdateOfferPriceDto,
} from './dto';
import { isUniqueViolation } from '../shared/prisma-errors';

/**
 * Products and the offers made against them.
 *
 * The catalogue is the one place in this service where a tenant deliberately
 * reads another's rows: a marketplace where you can only see your own listings
 * is not a marketplace. Every such read is narrowed the same way — published
 * offers, catalogue columns only, never an order — and states its reason
 * (ADR-042 § 3).
 */
@Injectable()
export class CatalogueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventPublisher,
  ) {}

  // =========================================================================
  // Products
  // =========================================================================

  async createProduct(dto: CreateProductDto): Promise<ProductView> {
    assertNotAuditor();
    const organizationId = getOrganizationId();
    const actor = getContext().userId ?? SERVICE_NAME;

    try {
      const row = await this.prisma.client.product.create({
        data: {
          id: newId(ID_PREFIX.product),
          organizationId,
          sku: dto.sku,
          name: dto.name,
          description: dto.description ?? null,
          category: dto.category,
          kind: dto.kind,
          unit: dto.unit,
          // Written here rather than generated, so one write does it (ADR-042).
          searchText: searchTextFor(dto),
          createdBy: actor,
        },
      });
      return toProductView(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw RastaError.alreadyExists('Product', dto.sku);
      }
      throw error;
    }
  }

  /**
   * Catalogue search (ADR-042).
   *
   * Text matching runs against the trigram index on `search_text`. Sorting
   * accepts price and lead time only: supplier rating lives in
   * supplier-service, which does not exist, and accepting `RATING` while
   * sorting by something else would tell a client its ordering was applied
   * when it was not (ADR-041).
   */
  async searchProducts(query: SearchProductsQuery): Promise<{ items: ProductView[] }> {
    assertNotAuditor();

    productSearchesTotal.inc({
      service: SERVICE_NAME,
      mode: query.q ? 'TEXT' : 'FILTER',
    });

    const rows = await runUnscoped(
      'a marketplace shows every organization the catalogue; only published offers are joined',
      () =>
        this.prisma.client.product.findMany({
          where: {
            status: 'ACTIVE',
            ...(query.category ? { category: query.category } : {}),
            ...(query.q ? { searchText: { contains: query.q, mode: 'insensitive' } } : {}),
            // A product with no published offer is not for sale, so it is not
            // a search result.
            offers: { some: { status: 'PUBLISHED' } },
          },
          include: {
            offers: {
              where: { status: 'PUBLISHED' },
              orderBy: orderingFor(query.sort),
            },
          },
          // Deterministic and neutral: the tiebreak is the id, so no
          // organization can be favoured by ordering (`docs/04` § 4.8).
          orderBy: { id: 'asc' },
          take: query.limit,
        }),
    );

    return { items: rows.map((row) => toProductView(row, row.offers)) };
  }

  /** Offers for one product, cheapest first unless asked otherwise. */
  async offersFor(productId: string, sort: SearchProductsQuery['sort']): Promise<OfferView[]> {
    assertNotAuditor();

    const rows = await runUnscoped('a buyer compares offers across suppliers', () =>
      this.prisma.client.offer.findMany({
        where: { productId, status: 'PUBLISHED' },
        orderBy: orderingFor(sort),
      }),
    );

    return rows.map(toOfferView);
  }

  // =========================================================================
  // Offers
  // =========================================================================

  async createOffer(dto: CreateOfferDto): Promise<OfferView> {
    assertNotAuditor();
    const organizationId = getOrganizationId();
    const actor = getContext().userId ?? SERVICE_NAME;

    // The product may belong to another organization — a supplier offers
    // against a catalogue entry somebody else defined — so this read crosses
    // the guard and checks only that the product exists and is active.
    const product = await runUnscoped('a supplier offers against a shared catalogue entry', () =>
      this.prisma.client.product.findUnique({ where: { id: dto.productId } }),
    );
    if (!product || product.status !== 'ACTIVE') {
      throw RastaError.notFound('Product', dto.productId);
    }

    const offerId = newId(ID_PREFIX.offer);
    const publishedAt = dto.publish ? new Date() : null;

    const row = await this.prisma.transaction(async (tx) => {
      const created = await tx.offer.create({
        data: {
          id: offerId,
          organizationId,
          productId: dto.productId,
          unitPriceMinor: BigInt(dto.unitPriceMinor),
          currency: dto.currency,
          availableQuantity: dto.availableQuantity,
          leadTimeDays: dto.leadTimeDays,
          minimumQuantity: dto.minimumQuantity,
          status: dto.publish ? 'PUBLISHED' : 'DRAFT',
          publishedAt,
          createdBy: actor,
        },
      });

      await tx.offerPriceHistory.create({
        data: {
          id: newId(ID_PREFIX.priceHistory),
          organizationId,
          offerId,
          version: 1,
          unitPriceMinor: BigInt(dto.unitPriceMinor),
          currency: dto.currency,
          changedBy: actor,
        },
      });

      if (dto.publish) {
        await this.events.enqueue(tx, {
          eventName: MARKETPLACE_EVENTS.OFFER_PUBLISHED,
          aggregateId: offerId,
          organizationId,
          payload: {
            offerId,
            productId: dto.productId,
            supplierOrganizationId: organizationId,
            unitPriceMinor: dto.unitPriceMinor,
            currency: dto.currency,
            availableQuantity: dto.availableQuantity,
            leadTimeDays: dto.leadTimeDays,
            version: 1,
            publishedAt: (publishedAt as Date).toISOString(),
          },
        });
      }

      return created;
    });

    return toOfferView(row);
  }

  /**
   * Reprices an offer, or changes what is available.
   *
   * The version is incremented and a history row written in the same
   * transaction. That pair is what makes "which price did this order agree to"
   * answerable years later: an `OrderLine` records the version, and this table
   * says what that version cost.
   *
   * **Orders already placed are untouched.** They copied the price at
   * placement (ADR-037 § 5), so a supplier cannot reprice work already sold.
   */
  async updateOffer(offerId: string, dto: UpdateOfferPriceDto): Promise<OfferView> {
    const actor = getContext().userId ?? SERVICE_NAME;

    return this.prisma.transaction(async (tx) => {
      const existing = await runUnscoped('an offer is located before its owner is checked', () =>
        tx.offer.findUnique({ where: { id: offerId } }),
      );
      if (!existing) throw RastaError.notFound('Offer', offerId);

      assertOfferOwner(existing);

      const repriced = dto.unitPriceMinor !== undefined;
      const nextVersion = repriced ? existing.version + 1 : existing.version;
      const nextPrice = repriced ? BigInt(dto.unitPriceMinor as string) : existing.unitPriceMinor;
      const willPublish = dto.status === 'PUBLISHED';
      const publishedAt =
        willPublish && !existing.publishedAt
          ? new Date()
          : dto.status && !willPublish
            ? null
            : existing.publishedAt;

      // `assertOfferOwner` above has already decided who may write this row,
      // and for a platform operator that decision is deliberately *not* the
      // owning organization (access.ts, `hasPlatformScope`). The tenant guard
      // cannot see that decision, so an operator's write would be scoped to
      // their own organization, match nothing, and surface as a 500 — the
      // exemption would exist in the check and be unreachable in practice.
      // The crossing is narrow: one row, located by its own id, whose owner
      // was checked a few lines above.
      const updated = await runUnscoped('the offer owner was checked before this write', () =>
        tx.offer.update({
          where: { id: offerId },
          data: {
            ...(repriced ? { unitPriceMinor: nextPrice, version: nextVersion } : {}),
            ...(dto.availableQuantity !== undefined
              ? { availableQuantity: dto.availableQuantity }
              : {}),
            ...(dto.leadTimeDays !== undefined ? { leadTimeDays: dto.leadTimeDays } : {}),
            ...(dto.status ? { status: dto.status } : {}),
            publishedAt,
            updatedBy: actor,
          },
        }),
      );

      if (repriced) {
        // Owned by the supplier whose offer it records, never by whoever
        // changed it — the history is the offer's, and an operator correction
        // must not file a row under the operator's organization.
        await runUnscoped('the price history belongs to the offer, not to the editor', () =>
          tx.offerPriceHistory.create({
            data: {
              id: newId(ID_PREFIX.priceHistory),
              organizationId: existing.organizationId,
              offerId,
              version: nextVersion,
              unitPriceMinor: nextPrice,
              currency: existing.currency,
              changedBy: actor,
            },
          }),
        );
      }

      // Republished on any change that makes it visible or changes what a
      // buyer would see, so a search index built from this stream stays right.
      if (updated.status === 'PUBLISHED') {
        await this.events.enqueue(tx, {
          eventName: MARKETPLACE_EVENTS.OFFER_PUBLISHED,
          aggregateId: offerId,
          organizationId: existing.organizationId,
          payload: {
            offerId,
            productId: updated.productId,
            supplierOrganizationId: existing.organizationId,
            unitPriceMinor: updated.unitPriceMinor.toString(),
            currency: updated.currency,
            availableQuantity: updated.availableQuantity,
            leadTimeDays: updated.leadTimeDays,
            version: updated.version,
            publishedAt: (updated.publishedAt ?? new Date()).toISOString(),
          },
        });
      }

      return toOfferView(updated);
    });
  }

  /** A supplier's own offers, in whatever state. */
  async listOwnOffers(): Promise<OfferView[]> {
    assertNotAuditor();
    const rows = await this.prisma.client.offer.findMany({ orderBy: { id: 'desc' }, take: 100 });
    return rows.map(toOfferView);
  }
}

function orderingFor(sort: SearchProductsQuery['sort']) {
  switch (sort) {
    case 'PRICE_DESC':
      return [{ unitPriceMinor: 'desc' as const }, { id: 'asc' as const }];
    case 'LEAD_TIME_ASC':
      return [{ leadTimeDays: 'asc' as const }, { id: 'asc' as const }];
    case 'PRICE_ASC':
    default:
      return [{ unitPriceMinor: 'asc' as const }, { id: 'asc' as const }];
  }
}

/** Name, category and SKU, which is what a buyer actually searches by. */
export function searchTextFor(input: {
  name: string;
  category: string;
  sku: string;
  description?: string | undefined;
}): string {
  return [input.name, input.category, input.sku, input.description ?? ''].join(' ').trim();
}

type ProductRow = {
  id: string;
  organizationId: string;
  sku: string;
  name: string;
  description: string | null;
  category: string;
  kind: string;
  unit: string;
  status: string;
};

type OfferRow = {
  id: string;
  organizationId: string;
  productId: string;
  unitPriceMinor: bigint;
  currency: string;
  availableQuantity: number;
  leadTimeDays: number;
  minimumQuantity: number;
  status: string;
  version: number;
};

export function toProductView(row: ProductRow, offers?: OfferRow[]): ProductView {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    category: row.category,
    kind: row.kind,
    unit: row.unit,
    status: row.status,
    ...(offers ? { offers: offers.map(toOfferView) } : {}),
  };
}

export function toOfferView(row: OfferRow): OfferView {
  return {
    id: row.id,
    productId: row.productId,
    supplierOrganizationId: row.organizationId,
    unitPriceMinor: row.unitPriceMinor.toString(),
    currency: row.currency,
    availableQuantity: row.availableQuantity,
    leadTimeDays: row.leadTimeDays,
    minimumQuantity: row.minimumQuantity,
    status: row.status,
    version: row.version,
    // ADR-041: the check did not run, so this is not `false`.
    supplierQualification: 'UNAVAILABLE',
  };
}
