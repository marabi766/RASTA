'use server';

import { redirect } from 'next/navigation';

import { EMPTY_DISPUTE_FORM, DISPUTE_COMMAND_FIELDS } from '@/lib/transaction-dispute-fields';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { verifyReplayStamp } from '@/server/dispute-replay';
import { mintFlash } from '@/server/flash';
import { FLASH_PARAM, REPLAY_FIELD } from '@/lib/form-fields';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import {
  boundDisputeRequest,
  disputeFormValues,
  issueDisputeCommand,
  parseDisputeCommand,
} from '@/server/transactions';

import { pastReplayDeadline, withRetryNote, type DisputeFormState } from './form-state';
import { pageContext } from '@/server/page-context';
import { withContext } from '@/lib/page-context';

/**
 * The one server action behind both dispute commands on `/transactions/[id]`.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * submission id, the form, then the gateway — each gate returning before the
 * next runs. One gate more than the others: the submission's **replay
 * deadline** (`server/dispute-replay.ts`), checked against the server's own
 * signed stamp before every send under the key, so a re-send cannot reach
 * economic-service after its idempotency record may have gone (PR 319 review
 * 2, finding 2). The transaction is bound, not posted, so a form cannot aim a
 * command at another transaction than the page it sits on.
 *
 * **Whether the command is allowed is not checked here.** economic-service
 * decides that against the record (roles, payer, state) when the command runs;
 * this action only refuses a `command` that is not one of the two at all.
 *
 * The unconfirmed path is `place-order-actions.ts`'s: once a command is
 * unconfirmed, no answer to a retry but a successful one (which redirects) may
 * claim the first request did not commit.
 */
export async function submitDisputeCommand(
  transactionId: string,
  previous: DisputeFormState,
  form: FormData,
): Promise<DisputeFormState> {
  const state = await attempt(transactionId, form);
  if (previous.kind !== 'UNCONFIRMED') return state;

  // A retry of an unconfirmed submission. The idempotency record can have
  // expired and the state can have moved, so a 403, 404, 409 or 422 on the
  // retry says nothing about the original. The original correlation id, key and
  // values stay; only the note changes. The one authoritative thing a retry can
  // learn is that this browser's session has ended (`NO_SESSION`) — not one
  // whose refresh is only unavailable for now (PR 319 review 2, finding 3).
  // Past the replay deadline nothing was sent, and nothing may be again.
  if (state.kind === 'REFUSED') {
    if (state.reason === 'NO_SESSION') return withRetryNote(previous, 'sessionEnded');
    if (state.reason === 'SESSION_UNAVAILABLE') return withRetryNote(previous, 'retryUnknown');
    if (state.reason === 'REPLAY') return pastReplayDeadline(previous);
  }
  return withRetryNote(previous, state.kind === 'UNCONFIRMED' ? 'retryUnknown' : 'retryRefused');
}

async function attempt(transactionId: string, form: FormData): Promise<DisputeFormState> {
  const session = await currentSession();
  if (!session) {
    // Ended, or only unavailable while its refresh is (`server/session-state.ts`).
    return { kind: 'REFUSED', reason: await missingSessionReason() };
  }

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isBoundSubmissionId(submissionId, session)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  // Checked here, just before the call, on every send under this key — the
  // first and each retry — against the deadline signed when the form was drawn.
  const replay = verifyReplayStamp(session, form.get(REPLAY_FIELD), transactionId, submissionId);
  if (!replay) return { kind: 'REFUSED', reason: 'REPLAY' };

  const input = disputeFormValues(form);
  const parsed = parseDisputeCommand(input);
  if (!parsed.ok) {
    if (parsed.command === null) return { kind: 'REFUSED', reason: 'COMMAND' };
    return {
      kind: 'INVALID',
      command: parsed.command,
      submissionId,
      values: input.values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  // A resolution names the dispute the page showed, from the stamp just
  // verified — the same on every send under this key (PR 325 review 1,
  // finding 1). A stamp that names none cannot carry a resolution.
  const request = boundDisputeRequest(parsed.request, replay.disputeId);
  if (!request) return { kind: 'REFUSED', reason: 'COMMAND' };

  const { command } = request;
  const result = await issueDisputeCommand(session, transactionId, request, submissionId);

  switch (result.kind) {
    case 'CREATED':
      // Back to the transaction, whose state has changed. A redirect, not a
      // returned state, so a refresh cannot repeat the command. The confirmation
      // is a token signed for this session, this transaction and this command
      // (`server/flash.ts`) — never a flag anybody could type (PR 319 review 1,
      // finding 3) — and the page removes it from the address once shown.
      redirect(
        withContext(
          pageContext(session),
          `/transactions/${encodeURIComponent(transactionId)}?${FLASH_PARAM}=${mintFlash(session, transactionId, command)}`,
        ),
      );
      break;
    case 'INVALID':
      return {
        kind: 'INVALID',
        command,
        submissionId,
        values: input.values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND' };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME': {
      // Sent, maybe committed, not confirmed: never "nothing changed". What is
      // kept for the retry is what was sent — the one field of the body, as the
      // service received it — so the retry is the same request.
      const field = DISPUTE_COMMAND_FIELDS[command];
      return {
        kind: 'UNCONFIRMED',
        command,
        correlationId: result.correlationId,
        submissionId,
        values: { ...EMPTY_DISPUTE_FORM, [field]: request.body[field] ?? '' },
        // The stamp as the browser keeps it; the dispute it names stays inside it.
        replay: { token: replay.token, until: replay.until },
      };
    }
  }
}
