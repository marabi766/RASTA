import { z } from 'zod';
import { plainText, numberInput } from '@rasta/contracts';
import { RETURN_STATUSES } from './state-machine';

/**
 * Request and response shapes for return requests (ADR-048).
 *
 * Every schema is `.strict()`: there is no price, no refund amount and no status field, so a
 * client that sends one is refused with `400 VALIDATION_FAILED` rather than having it ignored. A
 * return asks for goods to come back; what the buyer is owed for them is decided elsewhere, by
 * the owner of the money (ADR-048 § 2, § 3).
 */

export const createReturnSchema = z
  .object({
    /** Why, in the buyer's words. Shown to the supplier, never put on an event. */
    reason: plainText().min(10).max(1000),
    lines: z
      .array(
        z
          .object({
            orderLineId: z.string().trim().min(1).max(64),
            quantity: z.number().int().positive().max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .superRefine((lines, context) => {
        const seen = new Set<string>();
        for (const [index, line] of lines.entries()) {
          if (seen.has(line.orderLineId)) {
            context.addIssue({
              code: 'custom',
              path: [index, 'orderLineId'],
              message: 'An order line may appear once in a return request',
            });
          }
          seen.add(line.orderLineId);
        }
      }),
  })
  .strict();

/** The order is the path's (`POST /v1/orders/{id}/returns`, docs/06), never the body's. */
export type CreateReturnDto = z.infer<typeof createReturnSchema>;

/** The supplier's decision (`POST /v1/returns/{id}/decisions`, docs/06): two words, no amounts. */
export const decideReturnSchema = z.object({ decision: z.enum(['AUTHORIZE', 'REJECT']) }).strict();

export type DecideReturnDto = z.infer<typeof decideReturnSchema>;

/** The statuses a request is cancelled from (ADR-048 § 3): before any goods moved. */
export const CANCELLABLE_STATUSES = ['REQUESTED', 'AUTHORIZED'] as const;

/**
 * The buyer's cancellation (`POST /v1/returns/{id}/cancellation`, Codex r1 on #339 finding 1): the
 * status the caller saw when it chose to cancel. **Required** — a cancellation is conditional, and
 * judged under the request's row lock: a request that has moved on since (the supplier authorized
 * it between the portal's read and this POST) is refused with `409 OPTIMISTIC_LOCK_FAILED` and
 * nothing is written. Part of the request body, so of the Idempotency-Key's fingerprint: the same
 * key with another expected status is `409 IDEMPOTENCY_KEY_REUSED`.
 */
export const cancelReturnSchema = z
  .object({ expectedStatus: z.enum(CANCELLABLE_STATUSES) })
  .strict();

export type CancelReturnDto = z.infer<typeof cancelReturnSchema>;

export const listReturnsQuerySchema = z
  .object({
    status: z.enum(RETURN_STATUSES).optional(),
    orderId: z
      .string()
      .trim()
      .regex(/^ORD_[0-9A-HJKMNP-TV-Z]{26}$/)
      .optional(),
    /**
     * Which side of the request the caller is asking about — explicit, as for orders: an
     * organization is a buyer in one order and a seller in the next.
     */
    role: z.enum(['BUYER', 'SUPPLIER']).prefault('BUYER'),
    cursor: z.string().optional(),
    limit: numberInput(z.number().int().min(1).max(100)).prefault(25),
  })
  .strict();

export type ListReturnsQuery = z.infer<typeof listReturnsQuerySchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface ReturnLineView {
  orderLineId: string;
  productId: string;
  quantity: number;
}

export interface ReturnRequestView {
  id: string;
  orderId: string;
  status: string;
  /** The request's position in its own history: 1 REQUESTED, then one per status reached. */
  version: number;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  reason: string;
  lines: ReturnLineView[];
  requestedAt: string;
  requestedBy: string;
  authorizedAt: string | null;
  authorizedBy: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelledFrom: string | null;
  /**
   * The physical half, as inventory-service reported it and this service checked it (RUN-005 PR
   * 3): the shipment and when each step happened. What arrived per line and what became of it are
   * inventory's facts, read there.
   */
  returnShipmentId: string | null;
  inTransitAt: string | null;
  receivedAt: string | null;
  inspectedAt: string | null;
  inspectionReportDocumentId: string | null;
  resolvedAt: string | null;
  /**
   * When inventory-service reserved the dispatch of this request, before recording its shipment
   * (Q-133 (5)). Set while the request may still read AUTHORIZED — the shipment's own event moves
   * it on later, or not while the mirror is off — and from then on it cannot be cancelled, unless
   * a reconciliation with inventory releases it (`POST /v1/returns/{id}/dispatch-reconciliation`,
   * Q-133 (9)(a)); then it is `null` again.
   */
  dispatchReservedAt: string | null;
}

/**
 * `GET /v1/internal/returns/{id}` and `POST /v1/internal/returns/{id}/dispatch-reservation`: the
 * request as its owner states it, for the one service that records its goods (inventory-service,
 * ADR-061 § 4). Identifiers, the status and the lines only — never the buyer's reason.
 */
export interface ReturnDispatchSourceView {
  returnRequestId: string;
  orderId: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  status: string;
  lines: ReturnLineView[];
  /**
   * The reservation the dispatch is recorded under (`RDR_<ULID>`), or `null` while none stands. A
   * shipment carries it, so inventory can refuse one whose reservation was withdrawn by a
   * reconciliation (Q-133 (9)(a)).
   */
  dispatchReservationId: string | null;
  dispatchReservedAt: string | null;
  /**
   * Whether a shipment may name fewer lines or units than were authorized:
   * `MARKETPLACE_RETURN_PARTIAL_DISPATCH_ALLOWED` (Q-133 (8)), stated here so the shipment is
   * checked against the same rule the mirror later applies, from one setting.
   */
  partialDispatchAllowed: boolean;
}
