import { z } from 'zod';
import { plainText } from '@rasta/contracts';
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
    role: z.enum(['BUYER', 'SUPPLIER']).default('BUYER'),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
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
}
