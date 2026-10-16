'use client';

import { useEffect, useState } from 'react';

import type { DisputeCommand } from '@/lib/transaction-dispute-fields';
import {
  restoreUnresolvedDispute,
  type DisputeSubmission,
  type RestoredDispute,
} from '@/lib/unresolved-dispute';
import type { Binding } from '@/lib/unresolved-order';

import { DisputeCommandForm, unconfirmedFrom } from './DisputeCommandForm';

export interface DisputeCommandsProps {
  readonly transactionId: string;
  /** The commands this viewer may issue now (`disputeCommandsFor`). */
  readonly commands: readonly DisputeCommand[];
  readonly csrfToken: string;
  /** One fresh submission per command: each id is its own idempotency key, with its replay deadline. */
  readonly submissions: Readonly<Partial<Record<DisputeCommand, DisputeSubmission>>>;
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
}

/**
 * The dispute commands of one transaction, **after** this browser has been
 * asked whether a command on it is still unresolved (`lib/unresolved-dispute.ts`).
 *
 * If one is, only its uncertainty view is drawn — whatever the record now
 * allows: the same request is reconciled under its original key before any
 * fresh action is offered (PR 319 review 1, finding 2). That includes the
 * outcome-unknown marker an expired or logged-out entry is reduced to: no
 * fresh form until the person acknowledges it (PR 319 review 2, finding 1). Nothing is drawn until
 * that question is answered, so no fresh form with a new key is on screen in
 * between.
 */
export function DisputeCommands({
  transactionId,
  commands,
  csrfToken,
  submissions,
  binding,
  sessionMaxAgeSeconds,
}: DisputeCommandsProps) {
  const [checked, setChecked] = useState<{ readonly restored: RestoredDispute | null } | null>(
    null,
  );
  const { owner, session } = binding;

  useEffect(() => {
    setChecked({
      restored: restoreUnresolvedDispute(transactionId, { owner, session }, sessionMaxAgeSeconds),
    });
  }, [transactionId, owner, session, sessionMaxAgeSeconds]);

  if (checked === null) return null;

  const { restored } = checked;
  if (restored) {
    return (
      <div className="mt-4">
        <DisputeCommandForm
          key={restored.dispute.submissionId}
          transactionId={transactionId}
          command={restored.dispute.command}
          csrfToken={csrfToken}
          submissionId={restored.dispute.submissionId}
          replay={restored.dispute.replay}
          binding={binding}
          sessionMaxAgeSeconds={sessionMaxAgeSeconds}
          initial={unconfirmedFrom(restored)}
        />
      </div>
    );
  }

  const offered = commands.flatMap((command) => {
    const submission = submissions[command];
    return submission ? [{ command, submission }] : [];
  });
  if (offered.length === 0) return null;
  return (
    <div className="mt-4 flex flex-col gap-4">
      {offered.map(({ command, submission }) => (
        <DisputeCommandForm
          key={command}
          transactionId={transactionId}
          command={command}
          csrfToken={csrfToken}
          submissionId={submission.id}
          replay={submission.replay}
          binding={binding}
          sessionMaxAgeSeconds={sessionMaxAgeSeconds}
        />
      ))}
    </div>
  );
}
