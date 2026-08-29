import { Injectable } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { newId, ID_PREFIX } from '../events/publisher';
import type { OrderStatus, Prisma } from '../generated/prisma';

/**
 * Data access for orders and offers.
 *
 * Two things here are load-bearing rather than plumbing.
 *
 * **`lockOffers` takes row locks in a deterministic order.** Two buyers
 * ordering the same two offers at the same time would otherwise be able to
 * deadlock each other; sorting the ids first means every transaction takes
 * them in the same sequence, which makes a deadlock structurally impossible —
 * the same reason economic-service locks wallets by ascending id (ADR-031).
 *
 * **A supplier's reads cross the tenant guard with a written reason.** An
 * `Order` is scoped to the buyer (ADR-037 § 8), so the seller — who is
 * legitimately a party to it — cannot see it through the automatic scope. Each
 * crossing is narrow, states its reason, and lands in `access.ts` where the
 * check is explicit.
 */
@Injectable()
export class OrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Locks the named offers `FOR UPDATE`, in a fixed order.
   *
   * Raw SQL because Prisma has no expression for `FOR UPDATE`, and the whole
   * correctness of concurrent ordering rests on it: without the lock, two
   * requests both read `availableQuantity: 1` and both succeed.
   *
   * Crosses the tenant guard deliberately: a buyer prices offers belonging to
   * a *supplier*, so scoping this read to the caller would return nothing and
   * make the marketplace unable to sell anything.
   */
  async lockOffers(tx: ExtendedPrismaClient, offerIds: readonly string[]) {
    const ordered = [...new Set(offerIds)].sort();
    if (ordered.length === 0) return [];

    return runUnscoped(
      'a buyer prices offers owned by suppliers; the object-level check is in pricing and access',
      () => tx.$queryRaw<LockedOfferRow[]>`
        SELECT id, organization_id, product_id, unit_price_minor, currency,
               available_quantity, minimum_quantity, version, status::text AS status
        FROM "offer"
        WHERE id = ANY(${ordered}::text[])
        ORDER BY id
        FOR UPDATE
      `,
    );
  }

  /** Reduces availability by the ordered quantity, under the lock above. */
  async consumeAvailability(
    tx: ExtendedPrismaClient,
    lines: readonly { offerId: string; quantity: number }[],
  ): Promise<void> {
    for (const line of lines) {
      await runUnscoped(
        'availability belongs to the supplier whose offer the buyer just bought',
        () => tx.$executeRaw`
          UPDATE "offer"
          SET available_quantity = available_quantity - ${line.quantity}
          WHERE id = ${line.offerId}
        `,
      );
    }
  }

  /** Restores availability when an order is cancelled before delivery. */
  async restoreAvailability(
    tx: ExtendedPrismaClient,
    lines: readonly { offerId: string; quantity: number }[],
  ): Promise<void> {
    for (const line of lines) {
      await runUnscoped(
        'a cancelled order returns what it reserved to its supplier',
        () =>
          tx.$executeRaw`
          UPDATE "offer"
          SET available_quantity = available_quantity + ${line.quantity}
          WHERE id = ${line.offerId}
        `,
      );
    }
  }

  /**
   * Reads an order either party may see.
   *
   * Crosses the guard because the supplier is not the scoped owner, and
   * narrows to the two named organizations immediately. The caller then runs
   * `assertOrderVisible`, which is where a stranger gets a 404.
   */
  async findForParty(orderId: string) {
    return runUnscoped('an order names two organizations and the seller is one of them', () =>
      this.prisma.client.order.findUnique({
        where: { id: orderId },
        include: { lines: true },
      }),
    );
  }

  /**
   * Locks one order row for a state transition.
   *
   * Every command that changes status goes through this, so two concurrent
   * commands on the same order serialise rather than both reading the old
   * status and both deciding their transition is legal.
   */
  async lockOrder(tx: ExtendedPrismaClient, orderId: string) {
    const rows = await runUnscoped(
      'an order is locked for transition by either of its two parties',
      () => tx.$queryRaw<RawLockedOrderRow[]>`
        SELECT id, organization_id, supplier_organization_id, status::text AS status,
               total_amount_minor, currency, economic_transaction_id, correlation_id
        FROM "order"
        WHERE id = ${orderId}
        FOR UPDATE
      `,
    );

    const row = rows[0];
    if (!row) throw RastaError.notFound('Order', orderId);

    // Mapped to the domain's own casing here rather than at each call site.
    // `access.ts` takes the same shape a Prisma row has, so a caller can pass
    // either without thinking about which one it is holding.
    return {
      id: row.id,
      organizationId: row.organization_id,
      supplierOrganizationId: row.supplier_organization_id,
      status: row.status,
      totalAmountMinor: row.total_amount_minor,
      currency: row.currency,
      economicTransactionId: row.economic_transaction_id,
      correlationId: row.correlation_id,
    };
  }

  /** Writes the audit row every transition and every reminder produces. */
  async recordHistory(
    tx: ExtendedPrismaClient,
    input: {
      orderId: string;
      organizationId: string;
      kind: 'TRANSITION' | 'REMINDER';
      fromStatus: OrderStatus;
      toStatus: OrderStatus;
      reason?: string | null;
    },
  ): Promise<void> {
    const context = getContext();
    await runUnscoped('history mirrors the order it belongs to and carries its own tenant', () =>
      tx.orderStatusHistory.create({
        data: {
          id: newId(ID_PREFIX.history),
          organizationId: input.organizationId,
          orderId: input.orderId,
          kind: input.kind,
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          reason: input.reason ?? null,
          actorId: context.userId ?? context.callerService ?? 'unknown',
          actorType: context.authType,
          correlationId: context.correlationId,
        },
      }),
    );
  }

  /** Lists orders the caller is a party to, on whichever side. */
  async listForCaller(query: {
    status?: OrderStatus;
    role: 'BUYER' | 'SUPPLIER';
    cursor?: string;
    limit: number;
  }) {
    const organizationId = getOrganizationId();
    const where: Prisma.OrderWhereInput =
      query.role === 'BUYER' ? { organizationId } : { supplierOrganizationId: organizationId };

    if (query.status) where.status = query.status;
    if (query.cursor) where.id = { lt: query.cursor };

    return runUnscoped(
      'a supplier lists orders where it is the named counterparty, narrowed to its own id',
      () =>
        this.prisma.client.order.findMany({
          where,
          include: { lines: true },
          orderBy: { id: 'desc' },
          take: query.limit,
        }),
    );
  }
}

export interface LockedOfferRow {
  id: string;
  organization_id: string;
  product_id: string;
  unit_price_minor: bigint;
  currency: string;
  available_quantity: number;
  minimum_quantity: number;
  version: number;
  status: string;
}

/** The raw shape `FOR UPDATE` returns, before it is mapped. */
interface RawLockedOrderRow {
  id: string;
  organization_id: string;
  supplier_organization_id: string;
  status: OrderStatus;
  total_amount_minor: bigint;
  currency: string;
  economic_transaction_id: string | null;
  correlation_id: string;
}

export interface LockedOrderRow {
  id: string;
  organizationId: string;
  supplierOrganizationId: string;
  status: OrderStatus;
  totalAmountMinor: bigint;
  currency: string;
  economicTransactionId: string | null;
  correlationId: string;
}
