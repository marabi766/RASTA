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

    const productId = newId(ID_PREFIX.product);

    try {
      // The product and its audit record commit together (AGENTS.md S-06,
      // A-08; global audit L7-14).
      const row = await this.prisma.transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            id: productId,
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

        await this.events.enqueue(tx, {
          eventName: MARKETPLACE_EVENTS.PRODUCT_CREATED,
          aggregateId: productId,
          organizationId,
          payload: {
            productId,
            organizationId,
            sku: created.sku,
            category: created.category,
            kind: created.kind,
            unit: created.unit,
            createdBy: actor,
            createdAt: created.createdAt.toISOString(),
          },
        });

        return created;
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

  /**
   * One product, by id — regardless of which organization catalogued it.
   *
   * The same open read as `searchProducts`: a marketplace where a buyer
   * cannot see a listing's own name and category, only search results that
   * happened to contain it, is not a marketplace. Unlike search this does not
   * require a published offer — a compare page reached from an older link
   * should still say what the product is, even if nobody is currently
   * offering it. It does still require `ACTIVE`, the same rule `createOffer`
   * applies to the same column: an archived product is gone from the
   * catalogue, and this endpoint answers exactly as it would for an id that
   * never existed, matching that precedent rather than adding a second one.
   */
  async getProduct(productId: string): Promise<ProductView> {
    assertNotAuditor();

    const row = await runUnscoped(
      'a compare page needs the product it names, regardless of which organization catalogued it',
      () => this.prisma.client.product.findUnique({ where: { id: productId } }),
    );
    if (!row || row.status !== 'ACTIVE') throw RastaError.notFound('Product', productId);

    return toProductView(row);
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

      if (!dto.publish) {
        // A draft is a state change too (L7-14); a published offer is
        // announced by OFFER_PUBLISHED below, as before.
        await this.events.enqueue(tx, {
          eventName: MARKETPLACE_EVENTS.OFFER_DRAFTED,
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
            minimumQuantity: created.minimumQuantity,
            version: 1,
            createdBy: actor,
            createdAt: created.createdAt.toISOString(),
          },
        });
      }

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
      // Locked before it is read (Codex #115 R1-1). Every field compared
      // below — and the `previousStatus` an audit record names — comes from
      // this snapshot, which no concurrent update can change until this
      // transaction ends. Read unlocked, a withdrawal committed by somebody
      // else in between was reported as this caller's change. The lock is
      // taken by id alone, before the owner check, and holds nothing a
      // stranger could learn from.
      await tx.$executeRaw`SELECT 1 FROM "offer" WHERE id = ${offerId} FOR UPDATE`;

      const existing = await runUnscoped('an offer is located before its owner is checked', () =>
        tx.offer.findUnique({ where: { id: offerId } }),
      );
      if (!existing) throw RastaError.notFound('Offer', offerId);

      assertOfferOwner(existing);

      const nextPrice =
        dto.unitPriceMinor !== undefined ? BigInt(dto.unitPriceMinor) : existing.unitPriceMinor;
      const nextStatus = dto.status ?? existing.status;
      const changedFields = [
        ...(nextPrice !== existing.unitPriceMinor ? ['unitPriceMinor' as const] : []),
        ...(dto.availableQuantity !== undefined &&
        dto.availableQuantity !== existing.availableQuantity
          ? ['availableQuantity' as const]
          : []),
        ...(dto.leadTimeDays !== undefined && dto.leadTimeDays !== existing.leadTimeDays
          ? ['leadTimeDays' as const]
          : []),
        ...(nextStatus !== existing.status ? ['status' as const] : []),
      ];

      // An update that changes nothing writes nothing and announces nothing
      // (Codex #115 R1-2) — not even `updatedBy`/`updatedAt`, and not a
      // re-publication of terms nobody changed.
      if (changedFields.length === 0) return toOfferView(existing);

      const repriced = changedFields.includes('unitPriceMinor');
      const nextVersion = repriced ? existing.version + 1 : existing.version;
      const willPublish = nextStatus === 'PUBLISHED';
      const publishedAt =
        willPublish && !existing.publishedAt
          ? new Date()
          : !willPublish
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
            ...(changedFields.includes('availableQuantity')
              ? { availableQuantity: dto.availableQuantity }
              : {}),
            ...(changedFields.includes('leadTimeDays') ? { leadTimeDays: dto.leadTimeDays } : {}),
            ...(changedFields.includes('status') ? { status: nextStatus } : {}),
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

      // Anything else that changed is recorded too (L7-14): an edit to a
      // draft, and every move out of PUBLISHED — which is exactly what a
      // search index built from this stream must not miss. `changedFields`
      // comes from the locked snapshot above, so it names this caller's
      // change and nobody else's.
      if (updated.status !== 'PUBLISHED') {
        await this.events.enqueue(tx, {
          eventName: MARKETPLACE_EVENTS.OFFER_UPDATED,
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
            minimumQuantity: updated.minimumQuantity,
            version: updated.version,
            previousStatus: existing.status,
            status: updated.status,
            changedFields,
            updatedBy: actor,
            updatedAt: updated.updatedAt.toISOString(),
          },
        });
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
