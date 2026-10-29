'use client';

import { useEffect, useState } from 'react';

import type { ReturnCommand } from '@/lib/return-fields';
import type { Binding } from '@/lib/unresolved-order';
import {
  restoreUnresolvedReturn,
  subscribeUnresolvedReturns,
  type RestoredReturn,
  type ReturnScope,
  type ReturnSubmission,
} from '@/lib/unresolved-return';

import { ReturnCommandForm, unconfirmedFrom, type ReturnFormLine } from './ReturnCommandForm';

export interface OfferedReturnCommand {
  readonly command: ReturnCommand;
  readonly submission: ReturnSubmission;
}

export interface ReturnCommandsProps {
  readonly scope: ReturnScope;
  /** What this viewer may issue now, each with a fresh submission (`server/returns.ts`). */
  readonly offered: readonly OfferedReturnCommand[];
  readonly csrfToken: string;
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
  readonly lines?: readonly ReturnFormLine[];
  readonly pageHref: string;
  /** Said when there is nothing to offer and nothing unresolved; nothing is said when absent. */
  readonly emptyNote?: string;
}

/**
 * The return commands of one slot — an order's request form, or one return
 * request's decisions and withdrawal — drawn only **after** this browser has
 * been asked whether a command there is still unresolved
 * (`lib/unresolved-return.ts`).
 *
 * If one is, and none of the forms drawn now is the one that sent it (a
 * reload), only its uncertainty view is drawn, whatever the page would now
 * offer — the outcome-unknown marker included: the same request is reconciled
 * under its original key before any fresh form, with a fresh key, is offered.
 * Nothing is drawn until that question is answered.
 *
 * The question is asked again **whenever the slot's record changes**, not only
 * on mount: when one of the forms drawn here is sent and its outcome is not
 * confirmed, every other form becomes view-only with the uncertainty notice
 * (`heldBy`) while the one in doubt keeps its own retry — same key, same body —
 * until a definite answer, or the person, resolves it.
 */
export function ReturnCommands({
  scope,
  offered,
  csrfToken,
  binding,
  sessionMaxAgeSeconds,
  lines,
  pageHref,
  emptyNote,
}: ReturnCommandsProps) {
  const [checked, setChecked] = useState<{ readonly restored: RestoredReturn | null } | null>(null);
  const kind = scope.kind;
  const target = scope.kind === 'ORDER' ? scope.orderId : scope.returnId;

  useEffect(() => {
    const slot: ReturnScope =
      kind === 'ORDER' ? { kind, orderId: target } : { kind, returnId: target };
    const read = () =>
      setChecked({
        restored: restoreUnresolvedReturn(slot, binding, sessionMaxAgeSeconds),
      });
    read();
    return subscribeUnresolvedReturns(read);
  }, [kind, target, binding, sessionMaxAgeSeconds]);

  if (checked === null) return null;

  const { restored } = checked;
  // A record of none of the forms drawn now — this page was drawn after it was
  // sent (a reload): only its uncertainty view. A record of one of them: that
  // form keeps it, in place, and the others wait (`heldBy`).
  const drawnHere =
    restored !== null &&
    offered.some(({ submission }) => submission.id === restored.entry.submissionId);
  if (restored && !drawnHere) {
    return (
      <div className="flex flex-col gap-4">
        <ReturnCommandForm
          key={restored.entry.submissionId}
          scope={scope}
          command={restored.entry.command}
          csrfToken={csrfToken}
          submissionId={restored.entry.submissionId}
          replay={restored.entry.replay}
          binding={binding}
          sessionMaxAgeSeconds={sessionMaxAgeSeconds}
          pageHref={pageHref}
          initial={unconfirmedFrom(restored)}
        />
      </div>
    );
  }

  if (offered.length === 0) {
    return emptyNote ? <p className="text-sm text-content-muted">{emptyNote}</p> : null;
  }
  return (
    <div className="flex flex-col gap-4">
      {offered.map(({ command, submission }) => (
        <ReturnCommandForm
          key={command}
          scope={scope}
          command={command}
          csrfToken={csrfToken}
          submissionId={submission.id}
          replay={submission.replay}
          binding={binding}
          sessionMaxAgeSeconds={sessionMaxAgeSeconds}
          lines={lines}
          pageHref={pageHref}
          heldBy={restored?.entry.submissionId ?? null}
        />
      ))}
    </div>
  );
}
