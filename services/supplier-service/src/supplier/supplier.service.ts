import { Injectable } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import type { CursorPage } from '@rasta/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import {
  assertCanBrowseDirectory,
  assertCanRegisterSupplier,
  assertSupplierReadable,
} from '../access/access';
import { isUniqueViolation } from '../shared/prisma-errors';
import { SupplierRepository } from './supplier.repository';
import { toDetailView, toDirectoryView, type SupplierRow } from './views';
import type {
  ListQualifiedForQuery,
  RegisterSupplierDto,
  SearchSuppliersQuery,
  SupplierDetailView,
  SupplierDirectoryView,
} from './dto';
import { suppliersRegisteredTotal, directoryQueriesTotal } from '../observability/metrics';
import { SERVICE_NAME } from '../config/env';

/**
 * RegisterSupplier, GetSupplier, SearchSuppliers, ListQualifiedFor.
 *
 * The profile half of the service. Qualification decisions and suspension are
 * separate services, because they are decided by a different population and
 * mixing them in one class makes it easy for one of them to reach a helper that
 * was written for the other (AGENTS.md A-10 keeps the controller thin; this
 * keeps the two authorities apart).
 */
@Injectable()
export class SupplierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: SupplierRepository,
    private readonly events: EventPublisher,
  ) {}

  /**
   * Registers this organization's supplier profile.
   *
   * The organization comes from the verified token and from nowhere else: the
   * DTO is `.strict()` and has no `organizationId` field, so there is nothing
   * for a caller to substitute.
   *
   * The profile row, its capabilities and `SUPPLIER_REGISTERED` are written in
   * **one transaction** (A-08). A profile without its event would leave
   * analytics and audit blind to a supplier that exists; an event without its
   * profile would point every consumer at a row that is not there.
   */
  async register(dto: RegisterSupplierDto): Promise<SupplierDetailView> {
    assertCanRegisterSupplier();

    const organizationId = getOrganizationId();
    const context = getContext();
    const actor = requireActor();

    const supplierId = newId(ID_PREFIX.supplier);
    const registeredAt = new Date();

    try {
      await this.prisma.transaction(async (tx) => {
        await this.repository.createSupplier(tx, {
          id: supplierId,
          organizationId,
          displayName: dto.displayName,
          registeredBy: actor,
          registeredCorrelationId: context.correlationId,
          capabilities: dto.capabilities.map((capability) => ({
            id: newId(ID_PREFIX.capability),
            capability,
          })),
        });

        await this.events.enqueue(tx, {
          eventName: 'SUPPLIER_REGISTERED',
          aggregateId: supplierId,
          organizationId,
          payload: {
            supplierId,
            organizationId,
            displayName: dto.displayName,
            capabilities: [...dto.capabilities].sort(),
            registeredBy: actor,
            registeredAt: registeredAt.toISOString(),
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // `supplier_organization_id_key`. A 409 rather than returning the
        // existing profile: the caller asked to create something, and quietly
        // handing back a row somebody else in their organization created would
        // hide that the second registration did nothing.
        throw RastaError.alreadyExists('Supplier', organizationId);
      }
      throw error;
    }

    suppliersRegisteredTotal.inc({ service: SERVICE_NAME });

    const created = await this.repository.findSupplier(supplierId);
    if (!created) {
      throw RastaError.internal('The supplier profile disappeared immediately after creation');
    }

    return toDetailView(created as unknown as SupplierRow);
  }

  /**
   * GetSupplier — the private record.
   *
   * Located unscoped and checked immediately, so another tenant gets `404`
   * rather than an answer that distinguishes "missing" from "not yours".
   */
  async get(id: string): Promise<SupplierDetailView> {
    const supplier = await this.repository.findSupplier(id);
    if (!supplier) {
      // The same shape a cross-tenant read produces, so the two are
      // indistinguishable from outside.
      throw RastaError.notFound('Supplier', id);
    }

    assertSupplierReadable(supplier);

    return toDetailView(supplier as unknown as SupplierRow);
  }

  /**
   * SearchSuppliers — the public directory.
   *
   * The cross-tenant read this service makes on purpose (`docs/04` § 4.10: an
   * open list). Contained by two independent controls: `assertCanBrowseDirectory`
   * decides who, and `toDirectoryView` decides what — no evidence identifier, no
   * decision note, no actor, no suspension narrative.
   */
  async search(query: SearchSuppliersQuery): Promise<CursorPage<SupplierDirectoryView>> {
    assertCanBrowseDirectory();
    directoryQueriesTotal.inc({ service: SERVICE_NAME, query: 'search' });

    const rows = await this.repository.searchDirectory({
      ...(query.capability ? { capability: query.capability } : {}),
      ...(query.qualifiedFor ? { qualifiedFor: query.qualifiedFor } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });

    return page(rows as unknown as SupplierRow[], query.limit, toDirectoryView);
  }

  /**
   * ListQualifiedFor — who may be referred work of this kind, right now.
   *
   * A narrower search rather than a different one: same authorization, same
   * projection, and the filter is applied in SQL so that a suspended supplier is
   * excluded before pagination. Filtering the page afterwards would return short
   * pages and, past the first, drop rows that should have appeared.
   *
   * This is the query `maintenance-service`'s `WorkshopDirectory` port and
   * `marketplace-service`'s `SupplierQualificationPort` will eventually call.
   * Neither calls it today — no service access is granted in this phase — and
   * ADR-041 continues to require marketplace to report `UNAVAILABLE` until the
   * integration is made deliberately.
   */
  async listQualifiedFor(query: ListQualifiedForQuery): Promise<CursorPage<SupplierDirectoryView>> {
    assertCanBrowseDirectory();
    directoryQueriesTotal.inc({ service: SERVICE_NAME, query: 'qualified-for' });

    const rows = await this.repository.searchDirectory({
      qualifiedFor: query.capability,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });

    return page(rows as unknown as SupplierRow[], query.limit, toDirectoryView);
  }
}

/**
 * The authenticated user id, or a refusal.
 *
 * Every mutation records an actor (AGENTS.md S-06) and the database refuses a
 * blank one, so a request that cannot name a human is refused here with an
 * explanation rather than at the constraint with a driver error.
 */
export function requireActor(): string {
  const userId = getContext().userId;
  if (!userId) {
    throw RastaError.forbidden('This operation records an actor and the request names none');
  }
  return userId;
}

/**
 * Turns `limit + 1` rows into a page and its cursor.
 *
 * The extra row is how `hasMore` is known without a second `count` query, which
 * on a growing table is the expensive half of a listing.
 */
export function page<TRow extends { id: string }, TView>(
  rows: TRow[],
  limit: number,
  project: (row: TRow) => TView,
): CursorPage<TView> {
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;

  return {
    items: visible.map(project),
    nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
    hasMore,
  };
}
