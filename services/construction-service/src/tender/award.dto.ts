import { z } from 'zod';

/**
 * Awarding an evaluated tender (ADR-067 § 3): the owner's person picks one QUALIFIED bid. The
 * platform ranks and shows; it chooses nothing, so the bid is always named. Nothing the caller
 * sends decides who awards, when, or under which organization: the awarder is the token's, the
 * instant the database's, the organization the tender's owner.
 */

const identifier = z.string().min(1).max(64);

export const MAX_JUSTIFICATION_LENGTH = 2000;

export const awardTenderSchema = z
  .object({
    bidId: identifier.describe('The QUALIFIED bid of this tender the owner awards it to.'),
    justification: z
      .string()
      .trim()
      .min(1)
      .max(MAX_JUSTIFICATION_LENGTH)
      .optional()
      .describe(
        'Required unless the bid is the single first rank of the frozen matrix: a choice of any ' +
          'other rank, or among a tie, is justified in words (ADR-067 § 3, Q-89). Kept in the ' +
          'database; never on an event and never shown to a bidder.',
      ),
  })
  .strict();
export type AwardTenderDto = z.infer<typeof awardTenderSchema>;

export const tenderAwardViewSchema = z
  .object({
    tenderId: z.string(),
    status: z.string().describe('AWARDED.'),
    bidId: z.string().describe('The winning bid.'),
    bidderOrganizationId: z.string().describe('The winning contractor.'),
    amountMinor: z
      .string()
      .describe(
        'The price the winner bid, in minor units (rials), a decimal string; never a float.',
      ),
    rank: z
      .number()
      .int()
      .describe('The winner’s rank in the frozen matrix: 1 + the number of bids strictly better.'),
    tied: z
      .boolean()
      .describe('Whether another bid shares that rank (a tie never makes a winner).'),
    justification: z.string().nullable(),
    matrixDigest: z
      .string()
      .describe(
        'SHA-256 (hex) of the frozen matrix the choice was made against (BIDS_EVALUATED’s).',
      ),
    standingAsOf: z
      .string()
      .describe('When supplier-service said the winner was still eligible (Q-85).'),
    awardedAt: z.string(),
    awardedBy: z.string(),
    alreadyAwarded: z
      .boolean()
      .describe('True when this very award had been made before; nothing was written.'),
  })
  .strict();
export type TenderAwardView = z.infer<typeof tenderAwardViewSchema>;
