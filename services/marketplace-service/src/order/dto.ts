import { z } from 'zod';

/**
 * Request and response shapes for orders.
 *
 * Every schema is `.strict()`, and on `createOrderSchema` that is a security
 * property rather than tidiness: there is **no price field**, so a client that
 * sends one is refused with `400 VALIDATION_FAILED` instead of having it
 * silently ignored (ADR-037 § 5).
 *
 * Ignoring is quiet. Refusing tells a client that thinks it is setting the
 * price that it is not.
 */

export const ORDER_STATUSES = [
  'PENDING',
  'FUNDS_HELD',
  'CONFIRMED',
  'AWAITING_RECEIPT_CONFIRMATION',
  'RECEIPT_CONFIRMED',
  'SETTLING',
  'COMPLETED',
  'DISPUTED',
  'CANCELLING',
  'CANCELLED',
  'FAILED',
] as const;

export const createOrderSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            offerId: z.string().trim().min(1).max(64),
            quantity: z.number().int().positive().max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    /** Free text from the buyer, carried through to the supplier. */
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export type CreateOrderDto = z.infer<typeof createOrderSchema>;

export const fulfillOrderSchema = z
  .object({
    /** A waybill or courier reference. Opaque to this service. */
    trackingReference: z.string().trim().min(1).max(128).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export type FulfillOrderDto = z.infer<typeof fulfillOrderSchema>;

export const confirmReceiptSchema = z
  .object({
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export type ConfirmReceiptDto = z.infer<typeof confirmReceiptSchema>;

export const raiseDisputeSchema = z
  .object({
    /**
     * At least a sentence, mirroring economic-service's dispute contract.
     *
     * A dispute stops settlement completely and indefinitely. Whoever has to
     * resolve it needs to know what it is about, and a one-word reason is how
     * a dispute becomes permanent by neglect.
     */
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();

export type RaiseDisputeDto = z.infer<typeof raiseDisputeSchema>;

export const resolveDisputeSchema = z
  .object({
    /**
     * What happens to the money.
     *
     * `SETTLE` returns the order to the settlement path; `REFUND` cancels it
     * and returns the held funds. There is no third option, because a dispute
     * that is neither settled nor refunded leaves the money held forever.
     */
    outcome: z.enum(['SETTLE', 'REFUND']),
    resolution: z.string().trim().min(10).max(1000),
  })
  .strict();

export type ResolveDisputeDto = z.infer<typeof resolveDisputeSchema>;

export const cancelOrderSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export type CancelOrderDto = z.infer<typeof cancelOrderSchema>;

export const submitReviewSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(2000).optional(),
  })
  .strict();

export type SubmitReviewDto = z.infer<typeof submitReviewSchema>;

export const listOrdersQuerySchema = z
  .object({
    status: z.enum(ORDER_STATUSES).optional(),
    /**
     * Which side of the order the caller is asking about.
     *
     * Explicit rather than inferred from the role: an organization can be both
     * a buyer and a supplier, and guessing which list they meant would return
     * the wrong one silently.
     */
    role: z.enum(['BUYER', 'SUPPLIER']).default('BUYER'),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface OrderLineView {
  offerId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPriceMinor: string;
  lineTotalMinor: string;
  currency: string;
  offerVersion: number;
}

export interface OrderView {
  id: string;
  status: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  totalAmountMinor: string;
  currency: string;
  lines: OrderLineView[];
  economicTransactionId: string | null;
  economicSettlementId: string | null;
  /**
   * Whether the supplier's qualification could be checked (ADR-041).
   *
   * `UNAVAILABLE`, always, until supplier-service exists. Not `false`: a
   * `false` says the check ran and failed, and a client showing "unverified"
   * on that basis would be reporting something nobody established.
   */
  supplierQualification: 'UNAVAILABLE';
  reminderCount: number;
  lastReminderAt: string | null;
  confirmedAt: string | null;
  fulfilledAt: string | null;
  receiptConfirmedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  failureReason: string | null;
  createdAt: string;
  placedBy: string;
}
