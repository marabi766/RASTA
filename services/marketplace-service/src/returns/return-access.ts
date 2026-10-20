import { RastaError, getOrganizationId } from '@rasta/nest-common';
import {
  assertBuyer,
  assertNotAuditor,
  assertSupplier,
  hasPlatformScope,
  type OrderParties,
} from '../access/access';

/**
 * Object-level authorization for return requests (S-03, BOLA; ADR-048 Compliance: tenant
 * isolation and object-level authorization for the order and the shipment).
 *
 * A return request names the same two organizations its order does, and each may do exactly one
 * half of it — the same rule `access.ts` states for orders, reused rather than restated so there
 * is one definition of who the buyer and the seller are:
 *
 * - the **buyer** asks, and withdraws what it asked;
 * - the **supplier** decides (authorizes or rejects) — Q-132, temporary decision;
 * - a **platform operator** may read; it decides nothing, and moves no goods or money.
 */
export interface ReturnParties extends OrderParties {
  readonly orderId: string;
}

/**
 * Either party may read the request; nobody else may know it exists (`404`, not `403`: refusing
 * by name would confirm the id is real).
 */
export function assertReturnVisible(request: ReturnParties): void {
  assertNotAuditor();
  if (hasPlatformScope()) return;

  const caller = getOrganizationId();
  if (caller === request.organizationId || caller === request.supplierOrganizationId) return;

  throw RastaError.notFound('ReturnRequest', request.id);
}

/** What each party command needs, written once so a command and its replay guard cannot disagree. */
export const RETURN_AUTHORISATION = {
  /** Asking is the buyer's, checked against the order, not the request (there is none yet). */
  request: (order: OrderParties) => assertBuyer(order, 'request a return of this order'),
  authorize: (request: ReturnParties) => assertSupplier(request, 'authorize this return'),
  reject: (request: ReturnParties) => assertSupplier(request, 'reject this return'),
  cancel: (request: ReturnParties) => assertBuyer(request, 'cancel this return request'),
  /**
   * Either party may ask inventory to reconcile a dispatch reservation (Q-133 (9)(a), temporary
   * decision): the buyer is the one it keeps from cancelling, the supplier the one whose dispatch
   * failed. It decides nothing — inventory's answer does — so it is no other party's command.
   */
  reconcile: (request: ReturnParties) =>
    getOrganizationId() === request.organizationId
      ? assertBuyer(request, 'reconcile this return’s dispatch')
      : assertSupplier(request, 'reconcile this return’s dispatch'),
} as const;

export type ReturnCommand = keyof typeof RETURN_AUTHORISATION;
