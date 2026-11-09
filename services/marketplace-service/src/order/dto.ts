import { z } from 'zod';
import {
  plainText,
  numberInput,
  boundsForAll,
  isWithin,
  textWithin,
  TRANSACTION_TEXT_BOUNDS,
} from '@rasta/contracts';
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
 *
 * What a line carries instead is `offerVersion` — **required** — the `version`
 * of the offer the buyer read (`OfferView.version`). It names the price the
 * buyer agreed to without stating one: the server still prices from the locked
 * offer row, and refuses with `409 OPTIMISTIC_LOCK_FAILED` (`details[].code`
 * `OFFER_VERSION_CHANGED`) when that row is at any other version (D-156,
 * `pricing.ts`). There is no default: a line that names no version agreed to
 * nothing, and "the current one" is exactly the price nobody saw.
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
            // `offer.version` is an INT column; a larger number names no version.
            offerVersion: z.number().int().min(1).max(2_147_483_647),
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
     *
     * The saga sends it as the economic dispute's `reason`, so it is bounded
     * by that body's own bounds (`TRANSACTION_TEXT_BOUNDS`, FU-134).
     */
    reason: textWithin(plainText(), TRANSACTION_TEXT_BOUNDS.disputeReason),
  })
  .strict();

export type RaiseDisputeDto = z.infer<typeof raiseDisputeSchema>;

/**
 * The bounds of a REFUND resolution: it is sent both as the economic
 * resolution and as the refund's or cancellation's reason, so it must fit both.
 */
export const REFUND_RESOLUTION_BOUNDS = boundsForAll(
  TRANSACTION_TEXT_BOUNDS.disputeResolution,
  TRANSACTION_TEXT_BOUNDS.closingReason,
);

/** The refusal of a REFUND resolution that does not fit; it repeats nothing of the input (S-09). */
export const REFUND_RESOLUTION_OUT_OF_BOUNDS =
  `A REFUND resolution is also the refund's reason: between ${REFUND_RESOLUTION_BOUNDS.min} and ` +
  `${REFUND_RESOLUTION_BOUNDS.max} characters`;

export const resolveDisputeSchema = z
  .object({
    /**
     * The dispute this decision is about: the order's open dispute as the
     * operator saw it (`openDisputeId` on the order). Refused `409 CONFLICT`,
     * `details[].code` `DISPUTE_DECISION_STALE`, unless the order still holds
     * exactly that dispute — a decision about one dispute never decides another
     * raised since.
     */
    disputeId: z
      .string()
      .regex(/^DSP_[0-9A-HJKMNP-TV-Z]{26}$/, 'disputeId must be a dispute identifier'),
    /**
     * What happens to the money.
     *
     * `SETTLE` lifts the dispute and resumes the order where the dispute found
     * it (D-083). It does not settle, and it does not confirm receipt: a dispute
     * raised after the buyer confirmed receipt returns the order to
     * `RECEIPT_CONFIRMED`, and the saga settles it; one raised before returns it
     * to `FUNDS_HELD`, `CONFIRMED` or `AWAITING_RECEIPT_CONFIRMATION`, and
     * settlement still waits for the supplier's delivery and the buyer's
     * confirmation — reminders only, never automatic (ADR-043). A dispute whose
     * origin is not recorded is refused SETTLE (`DISPUTE_ORIGIN_UNKNOWN`).
     * `REFUND` cancels the order and returns the held funds. There is no third
     * option, because a dispute that is neither settled nor refunded leaves the
     * money held forever.
     */
    outcome: z.enum(['SETTLE', 'REFUND']),
    /**
     * Sent by the saga as the economic resolution (either outcome), and on
     * REFUND also as the refund's or cancellation's `reason`: it becomes the
     * order's `cancellationReason`. So it is bounded by every body it goes into
     * — on REFUND by {@link REFUND_RESOLUTION_BOUNDS}, refused below (FU-134).
     */
    resolution: textWithin(plainText(), TRANSACTION_TEXT_BOUNDS.disputeResolution).describe(
      `At most ${TRANSACTION_TEXT_BOUNDS.disputeResolution.max} characters; with outcome REFUND ` +
        `at most ${TRANSACTION_TEXT_BOUNDS.closingReason.max}, because a REFUND resolution is also ` +
        "the refund's reason. A longer one is refused with VALIDATION_FAILED before anything changes.",
    ),
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
  .strict()
  // Refused here, before any state changes, rather than by economic-service
  // inside the saga once the order is CANCELLING: there the refund's refusal
  // ended the saga with the funds held (FU-134). Not shortened either: the
  // operator's words are the record, and shortening them would happen in the
  // saga, out of the operator's sight.
  .superRefine((dto, ctx) => {
    if (dto.outcome === 'REFUND' && !isWithin(dto.resolution, REFUND_RESOLUTION_BOUNDS)) {
      ctx.addIssue({
        code: 'custom',
        path: ['resolution'],
        message: REFUND_RESOLUTION_OUT_OF_BOUNDS,
      });
    }
  });

export type ResolveDisputeDto = z.infer<typeof resolveDisputeSchema>;

export const cancelOrderSchema = z
  .object({
    /** The saga sends it as the refund's or cancellation's `reason`, so it has that body's bounds. */
    reason: textWithin(plainText(), TRANSACTION_TEXT_BOUNDS.closingReason),
  })
  .strict();

export type CancelOrderDto = z.infer<typeof cancelOrderSchema>;

export const submitReviewSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    qualityRating: z.number().int().min(1).max(5).optional(),
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
    role: z.enum(['BUYER', 'SUPPLIER']).prefault('BUYER'),
    cursor: z.string().optional(),
    limit: numberInput(z.number().int().min(1).max(100)).prefault(25),
  })
  .strict();

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface OrderLineView {
  /** The order line a return request names (RUN-005); stable for the life of the order. */
  id: string;
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
   * The dispute the order holds now, or null. What an operator's decision
   * names (`resolveDisputeSchema.disputeId`), so the decision is about the
   * dispute the operator saw.
   */
  openDisputeId: string | null;
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
