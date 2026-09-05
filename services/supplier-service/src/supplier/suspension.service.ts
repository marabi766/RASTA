import { Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { assertCanDecideAbout } from '../access/access';
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
    const suspendedAt = new Date();

    await this.prisma.transaction(async (tx) => {
      const changed = await this.repository.openSuspension(tx, {
        id: suspensionId,
        supplierId,
        organizationId: supplier.organizationId,
        reason: dto.reason,
        suspendedBy: actor,
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
      });
    });

    suspensionTransitionsTotal.inc({ service: SERVICE_NAME, transition: 'SUSPENDED' });

    return this.detailOf(supplierId);
  }

  /**
   * Reinstates a supplier.
   *
   * Publishes **nothing**, and that is a gap rather than a design: the platform
   * catalogue (`docs/events/README.md` § Supplier) names no `SUPPLIER_REINSTATED`
   * and this phase's event set is the four the catalogue does name. A consumer
   * that hid a supplier's offers on `SUPPLIER_SUSPENDED` therefore has no event
   * telling it to stop and must re-read this service.
   *
   * Recorded as a known issue and an Integration Handoff item rather than closed
   * by inventing an event this service has no mandate to add — the same
   * discipline ADR-041 applied when it refused to answer `false` for a check
   * nobody had made.
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
      const result = await this.repository.closeSuspension(tx, {
        supplierId,
        reinstatedBy: actor,
        reinstatedAt: new Date(),
        reinstatedCorrelationId: context.correlationId,
        reinstatementNote: dto.reason,
      });

      if (result.changed === 0) {
        throw RastaError.businessRule(
          `Supplier ${supplierId} was reinstated by somebody else first`,
          { supplierId },
        );
      }
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
