import { z } from 'zod';
import { cursorPaginationSchema } from '@rasta/contracts';
import { BID_ACCESS_PURPOSES } from '../events/events';
import { bidContentSchema } from './bid.dto';

/**
 * Opening a tender's bids and the owner's reads of them (ADR-066 § 4-5).
 *
 * Nothing the caller sends decides who, when or against what: the organization is the
 * token's, the instant is the database's, the head is audit-service's.
 */

export const listBidAccessLogQuerySchema = cursorPaginationSchema.strict();
export type ListBidAccessLogQuery = z.infer<typeof listBidAccessLogQuerySchema>;

/** The answer to `open-bids`: what happened, never what the bids say. */
export const bidsOpenedViewSchema = z
  .object({
    tenderId: z.string(),
    status: z.string(),
    openedAt: z.string(),
    openedBy: z.string(),
    bidCount: z.number().int().describe('Bids opened: submitted and not withdrawn.'),
    alreadyOpened: z
      .boolean()
      .describe(
        'True when the bids had been opened before; nothing was done and no event written.',
      ),
  })
  .strict();
export type BidsOpenedView = z.infer<typeof bidsOpenedViewSchema>;

/**
 * The proposal a withdrawal names (task 060): the instant it was made, as every answer that shows a
 * proposal gives it (`proposedAt`). A proposal is who and when; the caller is the who.
 */
export const withdrawProposalSchema = z
  .object({
    proposedAt: z
      .string()
      .datetime({
        message: 'A time is ISO 8601 in UTC with a trailing Z, e.g. 2026-10-31T12:00:00.000Z',
      })
      .describe(
        'The `proposedAt` of the proposal to withdraw, as answered by proposing or by GET ' +
          '/tenders/{id}/bids. Another proposal standing is 409 `PROPOSAL_SUPERSEDED`: nothing is withdrawn.',
      ),
  })
  .strict();
export type WithdrawProposalDto = z.infer<typeof withdrawProposalSchema>;

/** The answer to `open-bids/proposal`: who proposed the opening, and when (four-eyes, Q-91). */
export const bidOpeningProposalViewSchema = z
  .object({
    tenderId: z.string(),
    proposedBy: z.string(),
    proposedAt: z
      .string()
      .describe('When the proposal that stands was made: what a withdrawal of it names.'),
    alreadyProposed: z
      .boolean()
      .describe('True when the opening had been proposed before; the first proposal stands.'),
  })
  .strict();
export type BidOpeningProposalView = z.infer<typeof bidOpeningProposalViewSchema>;

/** The answer to `open-bids/proposal/withdraw`: whose proposal was taken back; anyone eligible may now propose. */
export const bidOpeningProposalWithdrawnViewSchema = z
  .object({
    tenderId: z.string(),
    withdrawnProposal: z
      .string()
      .describe(
        'The user id the proposal was made under: the caller, or the same person under another user id (#188).',
      ),
    proposedAt: z
      .string()
      .describe('When the withdrawn proposal was made: the one the request named.'),
  })
  .strict();
export type BidOpeningProposalWithdrawnView = z.infer<typeof bidOpeningProposalWithdrawnViewSchema>;

/** One bid, opened: identity, state and the content the receipts vouch for. */
export const openedBidViewSchema = z
  .object({
    bidId: z.string(),
    tenderId: z.string(),
    bidderOrganizationId: z.string(),
    status: z.string(),
    revision: z.number().int(),
    receivedAt: z.string(),
    contentCommitment: z.string(),
    content: bidContentSchema,
  })
  .strict();
export type OpenedBidView = z.infer<typeof openedBidViewSchema>;

/**
 * The owner's view of a tender's bids. Before the opening: how many, and when each was
 * received — **not** who, not what (ADR-066 § 4). After it: every standing bid, opened.
 */
export const tenderBidsViewSchema = z
  .object({
    tenderId: z.string(),
    opened: z.boolean(),
    bidCount: z.number().int(),
    receivedAt: z
      .array(z.string())
      .describe('Before the opening: when each standing bid was received, oldest first.'),
    bids: z.array(openedBidViewSchema).describe('Empty until the bids are opened.'),
    proposal: z
      .object({ proposedBy: z.string(), proposedAt: z.string() })
      .strict()
      .nullable()
      .describe(
        'Before the opening: the proposal to open that stands (four-eyes, Q-91) — who and when, what a ' +
          'withdrawal names — else null. Always null once the bids are opened.',
      ),
  })
  .strict();
export type TenderBidsView = z.infer<typeof tenderBidsViewSchema>;

export const bidAccessLogEntrySchema = z
  .object({
    id: z.string(),
    tenderId: z.string(),
    bidId: z.string().nullable(),
    accessorOrganizationId: z.string(),
    accessorUserId: z.string(),
    purpose: z.enum(BID_ACCESS_PURPOSES),
    outcome: z.enum(['GRANTED', 'REFUSED']),
    accessedAt: z.string(),
  })
  .strict();
export type BidAccessLogEntry = z.infer<typeof bidAccessLogEntrySchema>;
