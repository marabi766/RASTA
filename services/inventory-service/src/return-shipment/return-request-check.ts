import { RastaError } from '@rasta/nest-common';
import { refusal } from '../shared/refusal';
import type { CreateReturnShipmentDto } from './dto';
import type { ReturnRequestFact } from './return-request-source';

/** The one status of a return request whose goods may be dispatched: the supplier agreed. */
export const DISPATCHABLE_RETURN_STATUS = 'AUTHORIZED';

/**
 * Checks a return shipment against the return request as marketplace, its owner, records it
 * (A-13; Codex r1 on #336, finding 1). Pure: the facts are read by the caller, before any
 * transaction.
 *
 * - **Supplier.** The request must name the acting organization as its supplier. Marketplace
 *   answers only a request of the organization the token is signed for, so a different supplier
 *   here means an owner that broke its contract: it is treated as the request not being there
 *   (`404`), the answer every other organization's request gets — nothing about it is disclosed.
 * - **Status.** Only an AUTHORIZED request's goods travel (ADR-048 § 3).
 * - **Parties.** The order and the buyer are the request's own.
 * - **Lines.** Each line is one of the request's, of the same product, and no more than was
 *   authorized. Unless marketplace allows a partial dispatch (`partialDispatchAllowed`,
 *   `MARKETPLACE_RETURN_PARTIAL_DISPATCH_ALLOWED`, Q-133 (8) — the same setting its mirror judges
 *   the shipment's event by), every line of the request, each in exactly its authorized quantity:
 *   arriving short is the receipt's to say, not the dispatch's (Q-133 (4)).
 */
export function assertShipmentMatchesRequest(
  dto: CreateReturnShipmentDto,
  actingOrganizationId: string,
  request: ReturnRequestFact,
): void {
  if (request.supplierOrganizationId !== actingOrganizationId) {
    throw RastaError.notFound('ReturnRequest', dto.returnRequestId);
  }
  const context = { returnRequestId: dto.returnRequestId };
  if (request.status !== DISPATCHABLE_RETURN_STATUS) {
    throw refusal(
      'returnShipment',
      'RETURN_REQUEST_NOT_AUTHORIZED',
      'Only an AUTHORIZED return request’s goods are dispatched',
      { ...context, status: request.status },
    );
  }
  if (request.orderId !== dto.orderId || request.buyerOrganizationId !== dto.buyerOrganizationId) {
    throw refusal(
      'returnShipment',
      'RETURN_REQUEST_MISMATCH',
      'The order and the buyer are the return request’s own',
      context,
    );
  }

  const authorized = new Map(request.lines.map((line) => [line.orderLineId, line]));
  const every = dto.lines.every((line) => {
    const asked = authorized.get(line.orderLineId);
    return (
      asked !== undefined &&
      asked.productId === line.productId &&
      (request.partialDispatchAllowed
        ? line.quantity <= asked.quantity
        : line.quantity === asked.quantity)
    );
  });
  const complete = request.partialDispatchAllowed || dto.lines.length === authorized.size;
  if (!every || !complete) {
    throw refusal(
      'returnShipment',
      'RETURN_LINES_MISMATCH',
      request.partialDispatchAllowed
        ? 'Each line is one of the return request’s, of its product, and no more than was authorized'
        : 'A return shipment names every line of the return request, each in exactly its authorized quantity',
      context,
    );
  }
}
