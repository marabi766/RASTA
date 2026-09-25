import { Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { assertCanDecideAbout } from '../access/access';
import { transactionNow } from '../shared/clock';
import { SupplierRepository } from './supplier.repository';
import { requireActor } from './supplier.service';
import { toDetailView, type SupplierRow } from './views';
import {
  assertReinstatable,
  assertSuspendable,
  type SupplierStatusName,
} from './suspension.state-machine';
import type { ReinstateSupplierDto, SupplierDetailView, SuspendSupplierDto } from './dto';
import { suspensionTransitionsTotal } from '../observability/metrics';
import { SERVICE_NAME } from '../config/env';

/**
 * SuspendSupplier and ReinstateSupplier.
 *
 * Both are platform-operator decisions taken about somebody else's
 * organization, and both go through {@link assertCanDecideAbout} — which
 * requires platform scope **and** refuses a caller from the supplier's own
 * organization, whatever role they hold. A supplier lifting its own suspension
 * is the failure this guards, and it is a row-level fact no role check can see.
 *
 * ## Nothing here suspends automatically
 *
 * No score, no dispute count, no threshold, no scheduled sweep. Q-12 is open, so
 * there is no number to act on, and a rule like "suspend after three disputes"
 * would be an invented business fact (AGENTS.md § 9). Every suspension in this
 * service was decided by a named human whose id is on the row.
 */
@Injectable()
export class SuspensionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: SupplierRepository,
    private readonly events: EventPublisher,
  ) {}

  /**
   * Suspends a supplier.
   *
   * The status flip, the new episode and `SUPPLIER_SUSPENDED` share one
   * transaction (A-08). The event is what makes marketplace hide the supplier's
   * offers, so publishing it without the state change — or the reverse — is the
   * failure that leaves the platform and its consumers disagreeing about who is
   * allowed to trade.
   *
   * The qualification rows are **not touched**. Suspension does not revoke an
   * approval; it withholds it, and `isCurrentlyQualified` is where that is
   * expressed. Revoking would mean a reinstatement needed a fresh decision
   * nobody asked for, and would destroy the record of the original one.
   */
  async suspend(supplierId: string, dto: SuspendSupplierDto): Promise<SupplierDetailView> {
    const supplier = await this.repository.findSupplier(supplierId);
    if (!supplier) throw RastaError.notFound('Supplier', supplierId);

    assertCanDecideAbout(supplier);
    assertSuspendable({ id: supplier.id, status: supplier.status as SupplierStatusName });

    const context = getContext();
    const actor = requireActor();
    const suspensionId = newId(ID_PREFIX.suspension);

    await this.prisma.transaction(async (tx) => {
      // D-5: one instant from the database for the episode and its event.
      const suspendedAt = await transactionNow(tx);

      const changed = await this.repository.openSuspension(tx, {
        id: suspensionId,
        supplierId,
        organizationId: supplier.organizationId,
        reason: dto.reason,
        suspendedBy: actor,
        suspendedAt,
        suspendedCorrelationId: context.correlationId,
      });

      if (changed === 0) {
        // Another operator suspended it between the read and this write.
        // Thrown inside the transaction so the event rolls back with it.
        throw RastaError.businessRule(
          `Supplier ${supplierId} was suspended by somebody else first`,
          {
            supplierId,
          },
        );
      }

      await this.events.enqueue(tx, {
        eventName: 'SUPPLIER_SUSPENDED',
        aggregateId: suspensionId,
        organizationId: supplier.organizationId,
        payload: {
          supplierId,
          organizationId: supplier.organizationId,
          suspensionId,
          reason: dto.reason,
          // No end date. The suspension runs until somebody explicitly
          // reinstates; a timed one would need a rule nobody has written.
          until: null,
          suspendedBy: actor,
          suspendedAt: suspendedAt.toISOString(),
        },
        occurredAt: suspendedAt,
      });
    });

    suspensionTransitionsTotal.inc({ service: SERVICE_NAME, transition: 'SUSPENDED' });

    return this.detailOf(supplierId);
  }

  /**
   * Reinstates a supplier.
   *
   * The status flip, the stamped episode and `SUPPLIER_REINSTATED` share one
   * transaction (A-08), exactly as `suspend` does. Until the global audit's
   * L7-14 it published nothing, so audit-service held every suspension and
   * never its end (AGENTS.md S-06); the event also tells a consumer that hid
   * the supplier's offers on `SUPPLIER_SUSPENDED` to stop.
   *
   * The episode is stamped, never deleted: a reinstatement that removed the row
   * would erase the record of who suspended the supplier and why.
   */
  async reinstate(supplierId: string, dto: ReinstateSupplierDto): Promise<SupplierDetailView> {
    const supplier = await this.repository.findSupplier(supplierId);
    if (!supplier) throw RastaError.notFound('Supplier', supplierId);

    assertCanDecideAbout(supplier);
    assertReinstatable({ id: supplier.id, status: supplier.status as SupplierStatusName });

    const context = getContext();
    const actor = requireActor();

    await this.prisma.transaction(async (tx) => {
      // D-5: `reinstated_at >= suspended_at` is a CHECK, and both sides must
      // come from the clock that evaluates it — and the event states the same
      // instant the episode records.
      const reinstatedAt = await transactionNow(tx);
      const result = await this.repository.closeSuspension(tx, {
        supplierId,
        reinstatedBy: actor,
        reinstatedAt,
        reinstatedCorrelationId: context.correlationId,
        reinstatementNote: dto.reason,
      });

      if (result.changed === 0 || !result.suspensionId) {
        // Thrown inside the transaction so nothing — status or event — commits.
        throw RastaError.businessRule(
          `Supplier ${supplierId} was reinstated by somebody else first`,
          { supplierId },
        );
      }

      await this.events.enqueue(tx, {
        eventName: 'SUPPLIER_REINSTATED',
        aggregateId: result.suspensionId,
        organizationId: supplier.organizationId,
        payload: {
          supplierId,
          organizationId: supplier.organizationId,
          suspensionId: result.suspensionId,
          reason: dto.reason,
          reinstatedBy: actor,
          reinstatedAt: reinstatedAt.toISOString(),
        },
        occurredAt: reinstatedAt,
      });
    });

    suspensionTransitionsTotal.inc({ service: SERVICE_NAME, transition: 'REINSTATED' });

    return this.detailOf(supplierId);
  }

  private async detailOf(supplierId: string): Promise<SupplierDetailView> {
    const supplier = await this.repository.findSupplier(supplierId);
    if (!supplier) {
      throw RastaError.internal('The supplier disappeared immediately after being written');
    }
    return toDetailView(supplier as unknown as SupplierRow);
  }
}
