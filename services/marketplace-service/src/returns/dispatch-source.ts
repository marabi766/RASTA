import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { SERVICE_NAME, type MarketplaceEnv } from '../config/env';
import { returnRefusalsTotal } from '../observability/metrics';
import { PrismaService } from '../prisma/prisma.service';
import { ENV } from '../tokens';
import type { ReturnDispatchSourceView } from './dto';
import { ReturnRepository, type ReturnRequestRow } from './return.repository';
import { toReturnDispatchSourceView } from './views';

/**
 * A return request as its owner states it, for the one service that records its goods
 * (inventory-service; ADR-048 § 2, ADR-061 § 4, A-13) — and the step that ends its cancellability
 * (Codex r1 on #336, findings 1 and 2).
 *
 * ## Why inventory asks
 *
 * A return shipment names a marketplace request, its order and its buyer. Taken on trust, an
 * operator of any organization could record a shipment naming another organization's return, and
 * its buyer would read that shipment's progress as its own. So before inventory writes one, it
 * reads the request here and checks it names the caller as supplier, the buyer, the order and the
 * lines it was told. This service's database is the only authority for that.
 *
 * ## Why it reserves
 *
 * marketplace learns a shipment exists from `RETURN_SHIPMENT_DISPATCHED` — later, or never while
 * the mirror consumer is off — and until then the request reads AUTHORIZED, which the buyer may
 * cancel, freeing its quantities to be asked for again while the goods are on the road. Asking
 * inventory before a cancellation would not close it: the shipment could be written between the
 * question and the cancellation. The one place both commands meet is this request's row lock, so
 * inventory reserves the dispatch under it, and a cancellation under the same lock refuses a
 * reserved request. Whichever commits first wins; the other is refused (Q-133 (5), D-058).
 *
 * ## The lock (contract-service's `settlement-fact.ts`, ADR-061 § 4)
 *
 * - `/v1/internal/…`, a first path segment the gateway routes nowhere.
 * - `@AllowService` admits no other service (403), and {@link assertDispatchSourceCaller} also
 *   refuses every *user* token (403): the auth guard admits a verified user to any authenticated
 *   route, so `@AllowService` alone would not.
 * - The tenant is the one **signed into** the internal token (ADR-035), never a header, and it must
 *   be the request's **supplier**: the organization that receives the goods (Q-133 (1)). A token
 *   with no organization is refused (403) before any query; a request of any other supplier — its
 *   buyer included — is not found (404), so the caller learns nothing about it.
 */

/** The only caller these routes answer. */
export const DISPATCH_SOURCE_CALLER = 'inventory-service';

export function assertDispatchSourceCaller(): void {
  const context = getContext();
  if (context.authType !== 'SERVICE' || context.callerService !== DISPATCH_SOURCE_CALLER) {
    throw RastaError.forbidden(
      'This endpoint is reserved for the service that records return goods',
    );
  }
}

/** The status whose goods may be dispatched: the supplier agreed to take them back. */
const DISPATCHABLE_STATUS = 'AUTHORIZED';

@Injectable()
export class ReturnDispatchSourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: ReturnRepository,
    @Inject(ENV) private readonly env: MarketplaceEnv,
  ) {}

  /** The request as it stands, whatever its status: inventory decides, and refuses all but AUTHORIZED. */
  async read(id: string): Promise<ReturnDispatchSourceView> {
    const supplier = this.supplier();
    const row = await this.repository.findWithLines(id);
    return this.view(this.ownRequest(row, supplier, id));
  }

  /**
   * Reserves the dispatch of an AUTHORIZED request of the caller's: after this, the buyer cannot
   * cancel it. Idempotent — a request already reserved answers as it stands, so a retried dispatch
   * passes again; one shipment per return is inventory's own rule. Anything but AUTHORIZED is
   * refused: not yet decided, refused, withdrawn, or already moved on by its shipment's event.
   */
  async reserve(id: string): Promise<ReturnDispatchSourceView> {
    const supplier = this.supplier();
    const context = getContext();

    return this.prisma.transaction(async (tx) => {
      const locked = await this.repository.lockRequest(tx, id);
      if (!locked || locked.supplierOrganizationId !== supplier) {
        throw RastaError.notFound('ReturnRequest', id);
      }
      if (locked.status !== DISPATCHABLE_STATUS) {
        returnRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'NOT_DISPATCHABLE' });
        throw RastaError.businessRule(
          `Return request ${id} is ${locked.status}: only an AUTHORIZED return's goods are dispatched`,
          { returnRequestId: id, status: locked.status },
        );
      }
      if (locked.dispatchReservedAt === null) {
        // Never before what it follows, as every move of the request (`ReturnService.decide`).
        const at = new Date(Math.max(Date.now(), locked.updatedAt.getTime()));
        const reserved = await this.repository.reserveDispatch(tx, locked, {
          at,
          by: context.callerService ?? DISPATCH_SOURCE_CALLER,
          correlationId: context.correlationId,
        });
        if (!reserved) throw RastaError.optimisticLockFailed('ReturnRequest', id);
      }
      const row = await this.repository.findWithLines(id, tx);
      if (!row) throw new Error(`Return request ${id} vanished inside its own transaction`);
      return this.view(row);
    });
  }

  /** Resolved before any query, so a token minted with no organization is a 403 that reads nothing. */
  private supplier(): string {
    assertDispatchSourceCaller();
    return getOrganizationId();
  }

  private ownRequest(row: ReturnRequestRow | null, supplier: string, id: string): ReturnRequestRow {
    if (!row || row.supplierOrganizationId !== supplier)
      throw RastaError.notFound('ReturnRequest', id);
    return row;
  }

  private view(row: ReturnRequestRow): ReturnDispatchSourceView {
    return toReturnDispatchSourceView(row, this.env.MARKETPLACE_RETURN_PARTIAL_DISPATCH_ALLOWED);
  }
}
