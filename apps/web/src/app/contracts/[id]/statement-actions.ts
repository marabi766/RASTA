'use server';

import { redirect } from 'next/navigation';

import { FLASH_PARAM, REPLAY_FIELD } from '@/lib/form-fields';
import { draftFormLines, parseDraft } from '@/lib/statement-draft';
import type { StatementCommand } from '@/lib/statement-fields';
import {
  issueDraftStatement,
  issueStepCommand,
  stepRequestBody,
  type StatementCommandResult,
} from '@/server/contract-statements';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { mintFlash } from '@/server/flash';
import type { WebSession } from '@/server/session';
import { verifyStatementStamp, type VerifiedStatementStamp } from '@/server/statement-replay';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';

import { afterRetry, type StatementFormState } from './statement-form-state';
import { pageContext } from '@/server/page-context';
import { withContext } from '@/lib/page-context';

/**
 * The server actions behind the statement forms on `/contracts/[id]` and
 * `/contracts/[id]/statements/[statementId]`.
 *
 * The order of every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * submission id, the signed replay stamp (`server/statement-replay.ts`), the
 * form, then the gateway — each gate returning before the next runs. The
 * contract and the statement are bound, not posted; a submit's or a
 * decision's whole body comes from the verified stamp.
 *
 * **Whether the command is allowed is not decided here.** contract-service
 * decides — roles, side, state, the step's authority, separation of duties —
 * and its refusal is said in fixed words; the page only chose what to draw.
 *
 * Once a command is unconfirmed, no answer to a retry but a successful one
 * (which redirects) may claim the first request did not commit.
 */

type Attempt = (
  session: WebSession,
  stamp: VerifiedStatementStamp,
  form: FormData,
) => Promise<StatementFormState>;

async function gated(
  contractId: string,
  statementId: string | null,
  form: FormData,
  attempt: Attempt,
): Promise<StatementFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: await missingSessionReason() };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isBoundSubmissionId(submissionId, session)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  // On every send under this key — the first and each retry — against the
  // deadline and the binding signed when the form was drawn.
  const stamp = verifyStatementStamp(
    session,
    form.get(REPLAY_FIELD),
    contractId,
    statementId,
    submissionId,
  );
  if (!stamp) return { kind: 'REFUSED', reason: 'REPLAY' };
  return attempt(session, stamp, form);
}

function outcome(
  result: StatementCommandResult,
  command: StatementCommand,
  submissionId: string,
  stamp: VerifiedStatementStamp,
  onDone: (statementId: string) => never,
  draft: Pick<Extract<StatementFormState, { kind: 'INVALID' }>, 'rows'> & {
    lines: Extract<StatementFormState, { kind: 'UNCONFIRMED' }>['lines'];
  },
): StatementFormState {
  switch (result.kind) {
    case 'CREATED':
      return onDone(result.data.id);
    case 'INVALID':
      return {
        kind: 'INVALID',
        command,
        submissionId,
        rows: draft.rows,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return {
        kind: 'FORBIDDEN',
        correlationId: result.correlationId,
        reasons: result.reasons ?? [],
      };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND' };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing changed". What is
      // kept for the retry is what was sent, so the retry is the same request.
      return {
        kind: 'UNCONFIRMED',
        command,
        correlationId: result.correlationId,
        submissionId,
        lines: draft.lines,
        replay: { token: stamp.token, until: stamp.until },
      };
  }
}

/** Back to the statement, with a confirmation this session earned for it — never a typed flag. */
function toStatement(session: WebSession, contractId: string, command: StatementCommand) {
  return (statementId: string): never =>
    redirect(
      withContext(
        pageContext(session),
        `/contracts/${encodeURIComponent(contractId)}/statements/${encodeURIComponent(statementId)}?${FLASH_PARAM}=${mintFlash(session, statementId, command)}`,
      ),
    );
}

/** The contractor drafts a statement of `contractId`. */
export async function submitStatementDraft(
  contractId: string,
  previous: StatementFormState,
  form: FormData,
): Promise<StatementFormState> {
  const state = await gated(contractId, null, form, async (session, stamp, sent) => {
    if (stamp.command !== 'DRAFT') return { kind: 'REFUSED', reason: 'COMMAND' };
    const submissionId = sent.get(SUBMISSION_FIELD) as string;
    const rows = draftFormLines(sent);
    // The service checks each line's milestone against the contract.
    const parsed = parseDraft(rows, null);
    if (!parsed.ok) {
      return {
        kind: 'INVALID',
        command: 'DRAFT',
        submissionId,
        rows,
        fieldErrors: parsed.fieldErrors,
        message: parsed.message,
      };
    }
    const result = await issueDraftStatement(
      session,
      contractId,
      parsed.lines,
      parsed.rows,
      submissionId,
    );
    return outcome(
      result,
      'DRAFT',
      submissionId,
      stamp,
      toStatement(session, contractId, 'DRAFT'),
      {
        rows,
        lines: parsed.lines,
      },
    );
  });
  return previous.kind === 'UNCONFIRMED' ? afterRetry(previous, state) : state;
}

/** Submit, approve or reject statement `statementId` of `contractId` — which one, the stamp says. */
export async function submitStatementCommand(
  contractId: string,
  statementId: string,
  previous: StatementFormState,
  form: FormData,
): Promise<StatementFormState> {
  const state = await gated(contractId, statementId, form, async (session, stamp, sent) => {
    const { command, expectedVersion, chain, stepOrder } = stamp;
    if (command === 'DRAFT' || expectedVersion === null) {
      return { kind: 'REFUSED', reason: 'COMMAND' };
    }
    const body = stepRequestBody({ command, expectedVersion, chain, stepOrder });
    if (!body) return { kind: 'REFUSED', reason: 'COMMAND' };
    const submissionId = sent.get(SUBMISSION_FIELD) as string;
    const result = await issueStepCommand(
      session,
      contractId,
      statementId,
      command,
      body,
      submissionId,
    );
    return outcome(
      result,
      command,
      submissionId,
      stamp,
      toStatement(session, contractId, command),
      {
        rows: [],
        lines: [],
      },
    );
  });
  return previous.kind === 'UNCONFIRMED' ? afterRetry(previous, state) : state;
}
