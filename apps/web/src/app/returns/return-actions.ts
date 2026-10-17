'use server';

import { redirect } from 'next/navigation';

import { FLASH_PARAM, REPLAY_FIELD } from '@/lib/form-fields';
import type { ReturnCommand } from '@/lib/return-fields';
import { parseReturnRequest, returnRequestFormValues } from '@/lib/return-request';
import type { ReturnScope } from '@/lib/unresolved-return';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { mintFlash } from '@/server/flash';
import { verifyReturnStamp, type VerifiedReturnStamp } from '@/server/return-replay';
import {
  fetchReturn,
  issueReturnCommand,
  issueReturnRequest,
  portalSendsCancel,
  type ReturnWriteResult,
} from '@/server/returns';
import type { WebSession } from '@/server/session';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';

import { afterRetry, type ReturnFormState } from './return-form-state';

/**
 * The server actions behind the return forms on `/orders/[id]` (asking for a
 * return) and `/returns/[id]` (authorizing, rejecting, withdrawing).
 *
 * The order of every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * submission id, the signed replay stamp (`server/return-replay.ts`), the
 * form, then the gateway — each gate returning before the next runs. The order
 * and the request are bound, not posted; a decision's or a withdrawal's whole
 * body comes from the verified stamp.
 *
 * **Whether the command is allowed is not decided here.** marketplace-service
 * decides — roles, side, state, the return window — and its refusal is said in
 * fixed words; the page only chose what to draw. One narrowing is the
 * portal's own: a withdrawal is sent only for a request re-read just before
 * as not yet authorized (`PORTAL_CANCEL_FROM`, `portalSendsCancel`), so a form
 * drawn earlier, or a crafted stamp, cannot withdraw an authorized one.
 *
 * Once a command is unconfirmed, no answer to a retry but a successful one
 * (which redirects) may claim the first request did not commit.
 */

type Attempt = (
  session: WebSession,
  stamp: VerifiedReturnStamp,
  submissionId: string,
  form: FormData,
) => Promise<ReturnFormState>;

async function gated(
  scope: ReturnScope,
  form: FormData,
  attempt: Attempt,
): Promise<ReturnFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: await missingSessionReason() };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isBoundSubmissionId(submissionId, session)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  // On every send under this key — the first and each retry — against the
  // deadline and the binding signed when the form was drawn.
  const stamp = verifyReturnStamp(session, form.get(REPLAY_FIELD), scope, submissionId);
  if (!stamp) return { kind: 'REFUSED', reason: 'REPLAY' };
  return attempt(session, stamp, submissionId, form);
}

function outcome(
  result: ReturnWriteResult,
  sent: Extract<ReturnFormState, { kind: 'UNCONFIRMED' }>,
  values: Extract<ReturnFormState, { kind: 'INVALID' }>['values'],
  onDone: (returnId: string) => never,
): ReturnFormState {
  switch (result.kind) {
    case 'CREATED':
      return onDone(result.data.id);
    case 'INVALID':
      return {
        kind: 'INVALID',
        command: sent.command,
        submissionId: sent.submissionId,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND' };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing changed". What is
      // kept for the retry is what was sent, so the retry is the same request.
      return { ...sent, correlationId: result.correlationId };
  }
}

/** To the request, with a confirmation this session earned for it — never a typed flag. */
function toReturn(session: WebSession, command: ReturnCommand) {
  return (returnId: string): never =>
    redirect(
      `/returns/${encodeURIComponent(returnId)}?${FLASH_PARAM}=${mintFlash(session, returnId, command)}`,
    );
}

/** The buyer asks to return goods of `orderId`. */
export async function submitReturnRequest(
  orderId: string,
  previous: ReturnFormState,
  form: FormData,
): Promise<ReturnFormState> {
  const scope: ReturnScope = { kind: 'ORDER', orderId };
  const state = await gated(scope, form, async (session, stamp, submissionId, sent) => {
    if (stamp.command !== 'REQUEST') return { kind: 'REFUSED', reason: 'COMMAND' };
    const values = returnRequestFormValues(sent);
    // Which lines are the order's, and how many each allows, is the service's
    // to check, under the order's lock.
    const parsed = parseReturnRequest(values, null);
    if (!parsed.ok) {
      return {
        kind: 'INVALID',
        command: 'REQUEST',
        submissionId,
        values,
        fieldErrors: parsed.fieldErrors,
        message: parsed.message,
      };
    }
    const result = await issueReturnRequest(session, orderId, parsed.body, submissionId);
    return outcome(
      result,
      {
        kind: 'UNCONFIRMED',
        command: 'REQUEST',
        correlationId: null,
        submissionId,
        body: parsed.body,
        replay: { token: stamp.token, until: stamp.until },
      },
      values,
      toReturn(session, 'REQUEST'),
    );
  });
  return previous.kind === 'UNCONFIRMED' ? afterRetry(previous, state) : state;
}

/** Authorize, reject or withdraw return request `returnId` — which one, the stamp says. */
export async function submitReturnCommand(
  returnId: string,
  previous: ReturnFormState,
  form: FormData,
): Promise<ReturnFormState> {
  const scope: ReturnScope = { kind: 'RETURN', returnId };
  const state = await gated(scope, form, async (session, stamp, submissionId) => {
    const { command } = stamp;
    if (command === 'REQUEST') return { kind: 'REFUSED', reason: 'COMMAND' };
    if (command === 'CANCEL') {
      const current = await fetchReturn(session, returnId);
      if (current.kind === 'NOT_FOUND') return { kind: 'NOT_FOUND' };
      if (current.kind !== 'OK') return { kind: 'REFUSED', reason: 'CANCEL_UNCHECKED' };
      if (!portalSendsCancel(current.data)) {
        return { kind: 'REFUSED', reason: 'CANCEL_NOT_IN_PORTAL' };
      }
    }
    const result = await issueReturnCommand(session, returnId, command, submissionId);
    return outcome(
      result,
      {
        kind: 'UNCONFIRMED',
        command,
        correlationId: null,
        submissionId,
        body: null,
        replay: { token: stamp.token, until: stamp.until },
      },
      null,
      toReturn(session, command),
    );
  });
  return previous.kind === 'UNCONFIRMED' ? afterRetry(previous, state) : state;
}
