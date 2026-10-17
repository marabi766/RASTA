'use client';

import { useEffect, useState } from 'react';

import type { StatementCommand } from '@/lib/statement-fields';
import {
  restoreUnresolvedStatement,
  type RestoredStatement,
  type StatementSubmission,
} from '@/lib/unresolved-statement';
import type { Binding } from '@/lib/unresolved-order';

import {
  StatementCommandForm,
  unconfirmedFrom,
  type MilestoneOption,
} from './StatementCommandForm';

export interface OfferedStatementCommand {
  readonly command: StatementCommand;
  readonly submission: StatementSubmission;
}

export interface StatementCommandsProps {
  readonly contractId: string;
  /** Null for the contract's draft form; the statement otherwise. */
  readonly statementId: string | null;
  /** What this viewer may issue now, each with a fresh submission (`server/contract-statements.ts`). */
  readonly offered: readonly OfferedStatementCommand[];
  readonly csrfToken: string;
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
  readonly milestones?: readonly MilestoneOption[];
  readonly pageHref: string;
}

/**
 * The statement commands of one scope — the contract's draft, or one
 * statement — drawn only **after** this browser has been asked whether a
 * command there is still unresolved (`lib/unresolved-statement.ts`).
 *
 * If one is, only its uncertainty view is drawn, whatever the page would now
 * offer — the outcome-unknown marker included: the same request is reconciled
 * under its original key before any fresh form, with a fresh key, is offered.
 * Nothing is drawn until that question is answered.
 */
export function StatementCommands({
  contractId,
  statementId,
  offered,
  csrfToken,
  binding,
  sessionMaxAgeSeconds,
  milestones,
  pageHref,
}: StatementCommandsProps) {
  const [checked, setChecked] = useState<{ readonly restored: RestoredStatement | null } | null>(
    null,
  );
  const { owner, session } = binding;

  useEffect(() => {
    setChecked({
      restored: restoreUnresolvedStatement(
        { contractId, statementId },
        { owner, session },
        sessionMaxAgeSeconds,
      ),
    });
  }, [contractId, statementId, owner, session, sessionMaxAgeSeconds]);

  if (checked === null) return null;
  const scope = { contractId, statementId };

  const { restored } = checked;
  if (restored) {
    return (
      <div className="flex flex-col gap-4">
        <StatementCommandForm
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

  if (offered.length === 0) return null;
  return (
    <div className="flex flex-col gap-4">
      {offered.map(({ command, submission }) => (
        <StatementCommandForm
          key={command}
          scope={scope}
          command={command}
          csrfToken={csrfToken}
          submissionId={submission.id}
          replay={submission.replay}
          binding={binding}
          sessionMaxAgeSeconds={sessionMaxAgeSeconds}
          milestones={milestones}
          pageHref={pageHref}
        />
      ))}
    </div>
  );
}
