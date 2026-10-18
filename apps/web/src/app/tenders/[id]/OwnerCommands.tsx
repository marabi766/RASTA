'use client';

import { useEffect, useState } from 'react';

import type { OwnerCommand } from '@/lib/tender-owner-fields';
import {
  restoreUnresolvedOwnerCommand,
  subscribeUnresolvedOwnerCommands,
  type OwnerSubmission,
  type UnresolvedOwnerCommand,
} from '@/lib/unresolved-tender-command';

import {
  OwnerCommandForm,
  unconfirmedFrom,
  type AwardFormTerms,
  type ScoreRow,
} from './OwnerCommandForm';

export interface OfferedOwnerCommand {
  readonly command: OwnerCommand;
  readonly execute?: boolean;
  /** The bidder a bid's command is about, said with its label. */
  readonly subject?: string;
  /** The bid, for the form's own ids. */
  readonly scope?: string;
  readonly scoreRows?: readonly ScoreRow[];
  readonly award?: AwardFormTerms;
  readonly submission: OwnerSubmission;
}

export interface OwnerCommandsProps {
  readonly tenderId: string;
  /** The forms of this group (`server/tender-owner.ts`), each with a fresh submission. */
  readonly offered: readonly OfferedOwnerCommand[];
  readonly csrfToken: string;
  readonly owner: string;
  readonly pageHref: string;
  /**
   * Whether a command in doubt is drawn here when none of these forms holds it:
   * exactly one group on the page does, so a reload shows it once.
   */
  readonly showsRestored?: boolean;
  /** Every owner form's submission id on the page, both groups' — what "drawn here" means. */
  readonly pageSubmissionIds?: readonly string[];
}

/**
 * One group of the owner's forms on a tender — the publication's, the
 * opening's, the evaluation's or the award's — drawn only after this browser has been asked whether an owner
 * command of this tender is still unresolved (`lib/unresolved-tender-command.ts`;
 * one slot for the tender). A record of none of the forms drawn now (a reload)
 * shows only its uncertainty view, in the group that `showsRestored`; a record
 * of one of them keeps it in place and the others wait (`heldBy`).
 */
export function OwnerCommands({
  tenderId,
  offered,
  csrfToken,
  owner,
  pageHref,
  showsRestored = false,
  pageSubmissionIds = [],
}: OwnerCommandsProps) {
  const [checked, setChecked] = useState<{
    readonly restored: UnresolvedOwnerCommand | null;
  } | null>(null);

  useEffect(() => {
    const read = () => setChecked({ restored: restoreUnresolvedOwnerCommand(tenderId, owner) });
    read();
    return subscribeUnresolvedOwnerCommands(read);
  }, [tenderId, owner]);

  if (checked === null) return null;
  const { restored } = checked;
  const drawnOnPage =
    restored !== null &&
    (pageSubmissionIds.includes(restored.submissionId) ||
      offered.some(({ submission }) => submission.id === restored.submissionId));

  if (restored && !drawnOnPage && showsRestored) {
    return (
      <div className="flex flex-col gap-4">
        <OwnerCommandForm
          key={restored.submissionId}
          tenderId={tenderId}
          command={restored.command}
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
      {offered.map(({ command, execute, subject, scope, scoreRows, award, submission }) => (
        <OwnerCommandForm
          key={submission.id}
          tenderId={tenderId}
          command={command}
          execute={execute}
          subject={subject}
          scope={scope}
          scoreRows={scoreRows}
          award={award}
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
