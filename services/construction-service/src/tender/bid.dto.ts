import { z } from 'zod';
import { cursorPaginationSchema } from '@rasta/contracts';
import { ownEvaluationViewSchema } from './evaluation.dto';

/**
 * A bid, as the bidder writes it and as it is answered (ADR-066, ADR-065 § 1).
 *
 * `.strict()` everywhere: the bidder, the tender's owner, the revision, the
 * receipt and every time are decided by the token, the row and the database clock,
 * never by the body. The content is **structured text** (a price as a decimal
 * string of whole minor units — money is never a float — the answer to each
 * criterion, an optional note); attachments are not in the MVP (Q-86).
 */

export const MAX_ANSWER_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 4000;
export const MAX_ANSWERS = 50;

const expectedRevision = z.number().int().min(1).max(2_147_483_647);

export const bidContentSchema = z
  .object({
    priceMinor: z
      .string()
      .regex(/^(0|[1-9]\d{0,18})$/, 'A price is whole minor units as a decimal string')
      // zod runs this even when the pattern above failed, so it must not throw on text
      // that is not a number.
      .refine(
        (value) => /^\d{1,19}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
        'The price is out of range',
      )
      .describe('The bid price in minor units (rials) as a decimal string; never a float.'),
    answers: z
      .array(
        z
          .object({
            criterionCode: z.string().trim().min(1).max(64),
            response: z.string().trim().min(1).max(MAX_ANSWER_LENGTH),
          })
          .strict(),
      )
      .max(MAX_ANSWERS)
      .refine((items) => new Set(items.map((item) => item.criterionCode)).size === items.length, {
        message: 'Each criterion is answered at most once',
      })
      .describe(
        'Answers to the tender’s criteria, by code. A code the tender does not have is 422.',
      ),
    note: z.string().trim().min(1).max(MAX_NOTE_LENGTH).optional(),
  })
  .strict();

export type BidContent = z.infer<typeof bidContentSchema>;

export const submitBidSchema = z.object({ content: bidContentSchema }).strict();
export type SubmitBidDto = z.infer<typeof submitBidSchema>;

export const reviseBidSchema = z.object({ expectedRevision, content: bidContentSchema }).strict();
export type ReviseBidDto = z.infer<typeof reviseBidSchema>;

export const withdrawBidSchema = z.object({ expectedRevision }).strict();
export type WithdrawBidDto = z.infer<typeof withdrawBidSchema>;

export const listOpenTendersQuerySchema = cursorPaginationSchema.strict();
export type ListOpenTendersQuery = z.infer<typeof listOpenTendersQuerySchema>;

/**
 * What a bidder is given back: the receipt and the state, never the content
 * (before the opening nobody reads it, the bidder included; ADR-066 § 4).
 */
export const bidReceiptViewSchema = z
  .object({
    bidId: z.string(),
    tenderId: z.string(),
    status: z.string(),
    revision: z.number().int(),
    receivedAt: z.string(),
    contentCommitment: z.string(),
    receipt: z.string().describe('The new head of the tender’s receipt chain at this revision.'),
    withdrawnAt: z.string().nullable(),
  })
  .strict();
export type BidReceiptView = z.infer<typeof bidReceiptViewSchema>;

/**
 * A bidder's own bid after the opening (ADR-066 § 4): what it sealed, read back against the
 * receipts audit-service holds, its status, and what the evaluation says of **it** — never of
 * another bidder's bid, the winner or the amount (Q-89).
 */
export const ownOpenedBidViewSchema = z
  .object({
    bidId: z.string(),
    tenderId: z.string(),
    status: z.string(),
    revision: z.number().int(),
    receivedAt: z.string(),
    contentCommitment: z.string(),
    content: bidContentSchema,
    evaluation: ownEvaluationViewSchema,
  })
  .strict();
export type OwnOpenedBidView = z.infer<typeof ownOpenedBidViewSchema>;

/** A tender as a bidder sees it: frozen criteria, the window, nothing of the owner's drafting. */
export const openTenderViewSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    scopeOfWork: z.string(),
    procurementNature: z.string().nullable(),
    visibility: z.string(),
    bidOpeningAt: z.string(),
    bidClosingAt: z.string(),
    criteria: z.array(
      z
        .object({
          code: z.string(),
          label: z.string(),
          weightBp: z.number().int(),
          scoringMethod: z.string(),
          maxScore: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();
export type OpenTenderView = z.infer<typeof openTenderViewSchema>;
