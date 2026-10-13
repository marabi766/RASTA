'use server';

import { redirect } from 'next/navigation';

import { currentSession } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { placeOrder, parsePlaceOrderForm, placeOrderFormValues } from '@/server/place-order';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';

import { withRetryNote, type PlaceOrderFormState } from './place-order-form-state';

/**
 * The place-order form's one server action.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * submission id, the form, then the gateway — each gate returning before the
 * next runs. An order is placed against an *offer*, which the form posts; the
 * service — not the portal — decides whether that offer is published, large
 * enough, and from another organization.
 *
 * On success the redirect goes to the order the service answered with, never
 * back to the form, so a refresh cannot place a second one.
 */
export async function submitPlaceOrder(
  previous: PlaceOrderFormState,
  form: FormData,
): Promise<PlaceOrderFormState> {
  const state = await attempt(form);
  if (previous.kind !== 'UNCONFIRMED') return state;

  // A retry of an unconfirmed submission: no answer to it but a successful one
  // (which redirects, above) may claim the first request did not commit. The
  // idempotency record can have expired and the offer can be gone, so a 404, 409
  // or 422 on the retry says nothing about the original. The state stays — the
  // original correlation id, key and values with it: a retry that itself came
  // back unconfirmed (a 5xx, a 401/405/429 the portal cannot tell from "maybe")
  // must not swap them for the retry's own.
  return withRetryNote(previous, state.kind === 'UNCONFIRMED' ? 'retryUnknown' : 'retryRefused');
}

async function attempt(form: FormData): Promise<PlaceOrderFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: 'NO_SESSION' };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isBoundSubmissionId(submissionId, session)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  const values = placeOrderFormValues(form);
  const parsed = parsePlaceOrderForm(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await placeOrder(session, parsed.request, submissionId);

  switch (result.kind) {
    case 'CREATED':
      redirect(`/orders/${encodeURIComponent(result.data.id)}?placed=1`);
      break;
    case 'INVALID':
      return {
        kind: 'INVALID',
        submissionId,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND', submissionId, values };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was ordered". In
      // progress is the same unknown: another request with this submission id
      // is still in flight. The values and the id come back so the retry is the
      // same request: same body, same key; the service replays or completes it.
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId, submissionId, values };
  }
}
