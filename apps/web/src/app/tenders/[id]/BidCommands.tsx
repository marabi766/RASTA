'use client';

import { useEffect, useState } from 'react';

import type { BidCommand } from '@/lib/bid-fields';
import {
  restoreUnresolvedBid,
  subscribeUnresolvedBids,
  type BidSubmission,
  type UnresolvedBid,
} from '@/lib/unresolved-bid';

import { BidCommandForm, unconfirmedFrom, type CriterionOption } from './BidCommandForm';

export interface OfferedBidCommand {
  readonly command: BidCommand;
  readonly submission: BidSubmission;
}

export interface BidCommandsProps {
  readonly tenderId: string;
  /** What this contractor may issue now, each with a fresh submission (`server/tender-bids.ts`). */
  readonly offered: readonly OfferedBidCommand[];
  readonly criteria: readonly CriterionOption[];
  readonly csrfToken: string;
  readonly owner: string;
  readonly pageHref: string;
}

/**
 * The bid commands of one tender — its one slot — drawn only **after** this
 * browser has been asked whether a command there is still unresolved
 * (`lib/unresolved-bid.ts`). Drawn for every bidder on the tender, even when
 * nothing is offered (after the deadline, say), so that a command in doubt
 * still shows after a reload.
 *
 * A record of none of the forms drawn now — this page was drawn after it was
 * sent — shows only its uncertainty view, beside the receipt the page read,
 * until the person sets it aside. A record of one of them: that form keeps it,
 * in place, and the others wait (`heldBy`). The question is asked again
 * whenever the record changes.
 */
export function BidCommands({
  tenderId,
  offered,
  criteria,
  csrfToken,
  owner,
  pageHref,
}: BidCommandsProps) {
  const [checked, setChecked] = useState<{ readonly restored: UnresolvedBid | null } | null>(null);

  useEffect(() => {
    const read = () => setChecked({ restored: restoreUnresolvedBid(tenderId, owner) });
    read();
    return subscribeUnresolvedBids(read);
  }, [tenderId, owner]);

  if (checked === null) return null;
  const { restored } = checked;
  const drawnHere =
    restored !== null && offered.some(({ submission }) => submission.id === restored.submissionId);

  if (restored && !drawnHere) {
    return (
      <div className="flex flex-col gap-4">
        <BidCommandForm
          key={restored.submissionId}
          tenderId={tenderId}
          command={restored.command}
          criteria={criteria}
          csrfToken={csrfToken}
          submissionId={restored.submissionId}
          replay={null}
          owner={owner}
          pageHref={pageHref}
          initial={unconfirmedFrom(restored)}
        />
      </div>
    );
  }

  if (offered.length === 0) return null;
  return (
    <div className="flex flex-col gap-4">
      {offered.map(({ command, submission }) => (
        <BidCommandForm
          key={command}
          tenderId={tenderId}
          command={command}
          criteria={criteria}
          csrfToken={csrfToken}
          submissionId={submission.id}
          replay={submission.replay}
          owner={owner}
          pageHref={pageHref}
          heldBy={restored?.submissionId ?? null}
        />
      ))}
    </div>
  );
}
