import { z } from 'zod';
import { plainText } from '@rasta/contracts';
import { RESPONSIBILITY_ATTRIBUTION } from '../events/events';

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

/** The refusal of a non-empty order note; it repeats nothing of the input (S-09). */
export const ORDER_NOTE_NOT_STORED =
  'An order note is not stored yet (open question Q-110); leave it out';

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
    /**
     * Refused unless empty (Q-110, temporary decision). The order has nowhere
     * to keep a note — no column, no event field — and where one should go is
     * an open product question. Accepting it dropped the buyer's text without
     * a word; refusing it says so. Trimmed first, so whitespace is empty.
     */
    note: plainText()
      .max(0, ORDER_NOTE_NOT_STORED)
      .optional()
      .describe(
        'Not supported yet: must be absent or empty. An order does not store a note ' +
          '(open question Q-110), so a non-empty one is refused with VALIDATION_FAILED ' +
          'rather than silently dropped.',
      ),
  })
  .strict();

export type CreateOrderDto = z.infer<typeof createOrderSchema>;

export const fulfillOrderSchema = z
  .object({
    /** A waybill or courier reference. Opaque to this service. */
    trackingReference: plainText().min(1).max(128).optional(),
    note: plainText().max(1000).optional(),
  })
  .strict();

export type FulfillOrderDto = z.infer<typeof fulfillOrderSchema>;

/** The refusal of a non-empty receipt note; it repeats nothing of the input (S-09). */
export const RECEIPT_NOTE_NOT_STORED =
  'A receipt confirmation note is not stored yet (open question Q-110); leave it out';

export const confirmReceiptSchema = z
  .object({
    /**
     * Refused unless empty (Q-110, temporary decision). Confirming receipt
     * records who confirmed and when — no column and no event field for a
     * note — and where a buyer's note should go is an open product question.
     * Accepting it dropped the text without a word; refusing it says so.
     * Trimmed first, so whitespace is empty.
     */
    note: plainText()
      .max(0, RECEIPT_NOTE_NOT_STORED)
      .optional()
      .describe(
        'Not supported yet: must be absent or empty. Confirming receipt does not store a ' +
          'note (open question Q-110), so a non-empty one is refused with VALIDATION_FAILED ' +
          'rather than silently dropped.',
      ),
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
    reason: plainText().min(10).max(1000),
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
    resolution: plainText().min(10).max(1000),
    /**
     * Who the operator holds responsible (ADR-052 §§ 1-b, 4 rule 13).
     *
     * Required, not inferred from `resolution` and not defaulted from
     * `outcome`: rule 14 forbids reading responsibility out of free text, and
     * `outcome` alone does not decide it — a `SETTLE` can still follow a
     * `PLATFORM` mistake, and a `REFUND` can follow one the platform never
     * caused. The operator states it, every time.
     */
    responsibility: z.enum(RESPONSIBILITY_ATTRIBUTION),
  })
  .strict();

export type ResolveDisputeDto = z.infer<typeof resolveDisputeSchema>;

export const cancelOrderSchema = z
  .object({
    reason: plainText().min(3).max(500),
  })
  .strict();

export type CancelOrderDto = z.infer<typeof cancelOrderSchema>;

export const submitReviewSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    comment: plainText().max(2000).optional(),
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
  /**
   * The commands **this caller** may issue on this order right now
   * (`order-actions.ts`).
   *
   * Per caller, not per order: the same record answers differently to its
   * buyer, its supplier and a platform operator, which is what lets a client
   * draw a stepper showing what this person may do next rather than every
   * transition that exists.
   *
   * It is not a permission check and must not be treated as one — every
   * command re-checks its own transition and its own party rule when it runs.
   * It exists because the real precondition of each command is spread across
   * the transition table, the per-command narrowing and `access.ts`, so a
   * client deriving it would get it wrong: reading the table alone concludes a
   * buyer may confirm receipt on a **disputed** order, which `confirmReceipt`
   * refuses.
   */
  availableActions: string[];
}
