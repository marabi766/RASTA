import { mintBidSubmission } from '@/server/bid-replay';
import type { WebSession } from '@/server/session';
import { bidOffers, type BidderCaller, type BidNote, type BidReceipt } from '@/server/tender-bids';
import type { OpenTenderDetail, ReadResult } from '@/server/tenders';

import type { OfferedBidCommand } from './BidCommands';

/**
 * The bid forms the page draws for this caller on this tender, each with a
 * fresh submission and the stamp that binds it — the bid and the revision the
 * page read for a replacement or a withdrawal. Which commands, and why none,
 * is `bidOffers`, a copy of construction-service's checks.
 */
export function bidCommandOffers(
  session: WebSession,
  caller: BidderCaller,
  tenderId: string,
  tender: ReadResult<OpenTenderDetail>,
  own: ReadResult<BidReceipt> | null,
  now: number = Date.now(),
): { readonly offered: readonly OfferedBidCommand[]; readonly note: BidNote } {
  const { offers, note } = bidOffers(caller, tender, own, now);
  return {
    note,
    offered: offers.map((offer) => ({
      command: offer.command,
      submission: mintBidSubmission(
        session,
        offer.command === 'SUBMIT'
          ? { tenderId, command: 'SUBMIT', bidId: null, expectedRevision: null }
          : {
              tenderId,
              command: offer.command,
              bidId: offer.bidId,
              expectedRevision: offer.expectedRevision,
            },
        now,
      ),
    })),
  };
}
