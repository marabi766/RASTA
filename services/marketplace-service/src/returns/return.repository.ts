import { Injectable } from '@nestjs/common';
import { getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { Prisma } from '../generated/prisma';
import type { ReturnStatus } from './state-machine';

/**
 * Data access for return requests.
 *
 * A request is scoped to the **buyer**, as the order it returns is (ADR-037 § 8), so the buyer's
 * own reads go through the tenant guard. The supplier is the named counterparty: its reads and its
 * decisions cross the guard once each, with a written reason, narrowed to its own organization id,
 * and land in `return-access.ts`, where the check is explicit.
 */

/** A request with its lines, as the views and the events are built from it. */
export type ReturnRequestRow = Prisma.ReturnRequestGetPayload<{ include: { lines: true } }>;

/** The order a request is made against, as read under its lock. */
export interface LockedOrderForReturn {
  id: string;
  organizationId: string;
  supplierOrganizationId: string;
  status: string;
  completedAt: Date | null;
}

interface RawLockedOrder {
  id: string;
  organization_id: string;
  supplier_organization_id: string;
  status: string;
  completed_at: Date | null;
}

/** A request row as `FOR UPDATE` returns it: the parties, the status and the version. */
export interface LockedReturnRow {
  id: string;
  organizationId: string;
  supplierOrganizationId: string;
  orderId: string;
  status: ReturnStatus;
  version: number;
  authorizedAt: Date | null;
  updatedAt: Date;
}

interface RawLockedReturn {
  id: string;
  organization_id: string;
  supplier_organization_id: string;
  order_id: string;
  status: ReturnStatus;
  version: number;
  authorized_at: Date | null;
  updated_at: Date;
}

@Injectable()
export class ReturnRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Locks the order a request is made against, so two requests for one order serialise — and an
   * order that moves on (a dispute, say) is read in the state the request is judged against.
   * Unscoped: the buyer's own order is reachable by the guard, but the lock is by id and the
   * party check is the caller's, in `return-access.ts`.
   */
  async lockOrder(tx: ExtendedPrismaClient, orderId: string): Promise<LockedOrderForReturn | null> {
    const rows = await runUnscoped(
      'an order is locked for a return request by its buyer; the party check follows in access',
      () => tx.$queryRaw<RawLockedOrder[]>`
        SELECT id, organization_id, supplier_organization_id, status::text AS status, completed_at
        FROM "order"
        WHERE id = ${orderId}
        FOR UPDATE
      `,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organization_id,
      supplierOrganizationId: row.supplier_organization_id,
      status: row.status,
      completedAt: row.completed_at,
    };
  }

  /** The lines of an order, as sold — read for the buyer, inside the order's tenant. */
  async orderLines(tx: ExtendedPrismaClient, orderId: string, organizationId: string) {
    return tx.orderLine.findMany({
      where: { orderId, organizationId },
      select: { id: true, productId: true, quantity: true },
      orderBy: { id: 'asc' },
    });
  }

  /**
   * Locks one request `FOR UPDATE`. Unscoped because the supplier decides a request the buyer
   * owns; the caller checks both visibility and the party before anything is written.
   */
  async lockRequest(tx: ExtendedPrismaClient, id: string): Promise<LockedReturnRow | null> {
    const rows = await runUnscoped(
      'a return request names two organizations and its supplier decides it; the party check follows in access',
      () => tx.$queryRaw<RawLockedReturn[]>`
        SELECT id, organization_id, supplier_organization_id, order_id, status, version,
               authorized_at, updated_at
        FROM "return_request"
        WHERE id = ${id}
        FOR UPDATE
      `,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organization_id,
      supplierOrganizationId: row.supplier_organization_id,
      orderId: row.order_id,
      status: row.status,
      version: row.version,
      authorizedAt: row.authorized_at,
      updatedAt: row.updated_at,
    };
  }

  async insertRequest(
    tx: ExtendedPrismaClient,
    data: Prisma.ReturnRequestUncheckedCreateInput,
  ): Promise<void> {
    await tx.returnRequest.create({ data });
  }

  async insertLine(
    tx: ExtendedPrismaClient,
    data: Prisma.ReturnLineUncheckedCreateInput,
  ): Promise<void> {
    await tx.returnLine.create({ data });
  }

  async insertHistory(
    tx: ExtendedPrismaClient,
    data: Prisma.ReturnStatusHistoryUncheckedCreateInput,
  ): Promise<void> {
    await runUnscoped(
      'history mirrors the request it belongs to, whichever party moved it, and carries the buyer tenant',
      () => tx.returnStatusHistory.create({ data }),
    );
  }

  /**
   * Moves a request, compare-and-set on its version: the row was locked, so this only fails if the
   * lock was somehow not held — in which case nothing changes and the caller fails the command.
   * Crosses the guard with the same reason as {@link lockRequest}.
   */
  async advance(
    tx: ExtendedPrismaClient,
    locked: LockedReturnRow,
    data: Prisma.ReturnRequestUncheckedUpdateManyInput,
  ): Promise<boolean> {
    const { count } = await runUnscoped(
      'the supplier decides, or the buyer withdraws, a request locked above under its version',
      () =>
        tx.returnRequest.updateMany({
          where: { id: locked.id, version: locked.version },
          data,
        }),
    );
    return count === 1;
  }

  /** One request with its lines, for either party — the caller checks which. */
  async findWithLines(id: string, tx?: ExtendedPrismaClient): Promise<ReturnRequestRow | null> {
    const client = tx ?? this.prisma.client;
    return runUnscoped(
      'a return request names two organizations and the seller is one of them; the party check follows in access',
      () =>
        client.returnRequest.findUnique({
          where: { id },
          include: { lines: { orderBy: { id: 'asc' } } },
        }),
    );
  }

  /** The caller's requests, on whichever side, newest first. */
  async list(query: {
    status?: ReturnStatus;
    orderId?: string;
    role: 'BUYER' | 'SUPPLIER';
    cursor?: string;
    limit: number;
  }): Promise<ReturnRequestRow[]> {
    const organizationId = getOrganizationId();
    const where: Prisma.ReturnRequestWhereInput =
      query.role === 'BUYER' ? { organizationId } : { supplierOrganizationId: organizationId };
    if (query.status) where.status = query.status;
    if (query.orderId) where.orderId = query.orderId;
    if (query.cursor) where.id = { lt: query.cursor };

    return runUnscoped(
      'a supplier lists the requests where it is the named counterparty, narrowed to its own id',
      () =>
        this.prisma.client.returnRequest.findMany({
          where,
          include: { lines: { orderBy: { id: 'asc' } } },
          orderBy: { id: 'desc' },
          take: query.limit,
        }),
    );
  }
}
