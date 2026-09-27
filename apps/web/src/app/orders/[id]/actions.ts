'use server';

import { redirect } from 'next/navigation';

import { currentSession } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { isSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import { issueOrderCommand, orderCommandFormValues, parseOrderCommand } from '@/server/orders';

import type { OrderCommandFormState } from './form-state';

/**
 * The one server action behind every command on `/orders/[id]`.
 *
 * One action rather than seven, because the seven differ only in which
 * fields they read and which path they post to — both decided by
 * `parseOrderCommand` from the `command` field. The order is bound, not posted,
 * so a form cannot aim a command at a different order than the page it sits on.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * submission id, the form, then the gateway — each gate returning before the
 * next runs.
 *
 * **Which command is allowed is not checked here.** marketplace-service
 * decides that against the record when the command runs; this action only
 * refuses a `command` value that is not one of the seven at all. Re-checking
 * `availableActions` here would be the portal claiming an authority it does
 * not have, and would be stale the moment the other party acted.
 */
export async function submitOrderCommand(
  orderId: string,
  _previous: OrderCommandFormState,
  form: FormData,
): Promise<OrderCommandFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: 'NO_SESSION' };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isSubmissionId(submissionId)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  const values = orderCommandFormValues(form);
  const parsed = parseOrderCommand(values);
  if (!parsed.ok) {
    if (parsed.command === null) return { kind: 'REFUSED', reason: 'COMMAND' };
    return {
      kind: 'INVALID',
      command: parsed.command,
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await issueOrderCommand(session, orderId, parsed.request, submissionId);

  switch (result.kind) {
    case 'CREATED':
      // Back to the order, whose status and actions have changed. A redirect,
      // not a returned state, so a refresh cannot repeat the command — and on
      // `orders` a repeat would replay, not act twice, but the page should not
      // lean on that.
      redirect(`/orders/${encodeURIComponent(orderId)}?done=${parsed.request.command}`);
      break;
    case 'INVALID':
      return {
        kind: 'INVALID',
        command: parsed.request.command,
        submissionId,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND' };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was saved".
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}
