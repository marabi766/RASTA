'use client';

import { useEffect, useState } from 'react';

import type { ContractCommand, ContractSide, ContractSlot } from '@/lib/contract-command-fields';
import type { ContractFormValues } from '@/lib/contract-command-input';
import {
  restoreUnresolvedContractCommand,
  subscribeUnresolvedContractCommands,
  type ContractSubmission,
  type RestoredContractCommand,
} from '@/lib/unresolved-contract-command';
import type { Binding } from '@/lib/unresolved-order';

import { ContractCommandForm, unconfirmedFrom, type ReasonOption } from './ContractCommandForm';

export interface OfferedContractCommand {
  readonly command: ContractCommand;
  readonly submission: ContractSubmission;
  /** For a signature: the side it is drawn for. */
  readonly side?: ContractSide | null;
  readonly reasons?: readonly ReasonOption[];
  readonly defaults?: ContractFormValues;
}

/** What every form of a page shares. */
export interface ContractFormContext {
  readonly csrfToken: string;
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
  readonly pageHref: string;
}

export interface ContractCommandsProps {
  readonly contractId: string;
  readonly slot: ContractSlot;
  /** The amendment or milestone of an `AMENDMENT` or `MILESTONE` slot; null otherwise. */
  readonly subjectId: string | null;
  readonly subjectLabel?: string | null;
  /** What this viewer may issue now, each with a fresh submission (`server/contract-commands.ts`). */
  readonly offered: readonly OfferedContractCommand[];
  readonly context: ContractFormContext;
  /**
   * When set, offered forms are folded under a disclosure with this label
   * (a milestone's change form, one per row). An unresolved command is never
   * folded: its uncertainty view is drawn open.
   */
  readonly collapsedLabel?: string | null;
}

/**
 * The contract commands of one slot — the contract's signature and
 * cancellation, a new amendment, one amendment, a new milestone, one milestone
 * — drawn only **after** this browser has been asked whether a command there
 * is still unresolved (`lib/unresolved-contract-command.ts`).
 *
 * If one is, only its uncertainty view is drawn, whatever the page would now
 * offer — the outcome-unknown marker included: the same request is reconciled
 * under its original key before any fresh form, with a fresh key, is offered.
 * Nothing is drawn until that question is answered.
 *
 * The question is asked again **whenever the slot's record changes**: when one
 * of the forms drawn here is sent and its outcome is not confirmed, every
 * other form becomes view-only with the uncertainty notice (`heldBy`) while
 * the one in doubt keeps its own retry — same key, same body — until a
 * definite answer, or the person, resolves it. `StatementCommands`' rules.
 */
export function ContractCommands({
  contractId,
  slot,
  subjectId,
  subjectLabel = null,
  offered,
  context,
  collapsedLabel = null,
}: ContractCommandsProps) {
  const [checked, setChecked] = useState<{
    readonly restored: RestoredContractCommand | null;
  } | null>(null);
  const { csrfToken, binding, sessionMaxAgeSeconds, pageHref } = context;

  useEffect(() => {
    const read = () =>
      setChecked({
        restored: restoreUnresolvedContractCommand(
          { contractId, slot, subjectId },
          binding,
          sessionMaxAgeSeconds,
        ),
      });
    read();
    return subscribeUnresolvedContractCommands(read);
  }, [contractId, slot, subjectId, binding, sessionMaxAgeSeconds]);

  if (checked === null) return null;
  const scope = { contractId, slot, subjectId };

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
        <ContractCommandForm
          key={restored.entry.submissionId}
          scope={scope}
          command={restored.entry.command}
          subjectLabel={subjectLabel}
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

  if (offered.length === 0) return null;
  const forms = (
    <div className="flex flex-col gap-4">
      {offered.map(({ command, submission, side, reasons, defaults }) => (
        <ContractCommandForm
          key={command}
          scope={scope}
          command={command}
          side={side ?? null}
          subjectLabel={subjectLabel}
          csrfToken={csrfToken}
          submissionId={submission.id}
          replay={submission.replay}
          binding={binding}
          sessionMaxAgeSeconds={sessionMaxAgeSeconds}
          reasons={reasons}
          defaults={defaults}
          pageHref={pageHref}
          heldBy={restored?.entry.submissionId ?? null}
        />
      ))}
    </div>
  );
  if (collapsedLabel === null) return forms;
  // The same tree either way, so a form sent from inside keeps its state; a
  // form whose outcome is in doubt holds the disclosure open.
  return (
    <details className="rounded-md border border-border p-3" open={drawnHere || undefined}>
      <summary className="cursor-pointer text-sm font-medium">{collapsedLabel}</summary>
      <div className="mt-3">{forms}</div>
    </details>
  );
}
