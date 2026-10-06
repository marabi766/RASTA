import { redirect } from 'next/navigation';

import type { AvailabilityNotice } from '@/lib/fleet-availability-fields';
import { BASELINE_FIELD, FLASH_PARAM } from '@/lib/form-fields';
import {
  declareAvailability,
  declareAvailabilityFormValues,
  openAvailabilityBaseline,
  parseDeclareAvailabilityForm,
  revokeAvailability,
  type AvailabilityBaseline,
} from '@/server/fleet-availability';
import { verifyCsrf } from '@/server/csrf';
import { currentSession } from '@/server/current-session';
import { mintFlash } from '@/server/flash';
import type { WebSession } from '@/server/session';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import type { WriteResult } from '@/server/write';

import type { DeclareFormState, RevokeFormState } from './availability-form-state';
import type { RecordFormState } from './record-form-state';

/**
 * The one path both availability commands on `/assets/[id]` take.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * the submission id, which machine (and window) the post was drawn for, the
 * form, and only then the gateway. Each refusal is decided before the next step
 * runs, so a refused post never reaches it — which `availability-actions.spec.ts`
 * asserts for each command.
 *
 * Not a `'use server'` module: that directive turns every export into a
 * network-callable action, and this is a helper the two actions share.
 *
 * ## Which machine, which window
 *
 * The page's own. The form binds them to the action, but that happens in a
 * client component, so a bound id is a value the browser sends back and could
 * change on the way. The signed baseline names the machine — and, for a revoke,
 * the window — and the bound ids must be the ones it names, or nothing is sent.
 * No field of either form names a machine or a window.
 */

const assetPath = (assetId: string, flash: string): string =>
  `/assets/${encodeURIComponent(assetId)}?${FLASH_PARAM}=${flash}`;

/** Everything before the form is read; `null` plus the refusal to return when it fails. */
async function authorize(
  command: 'declare' | 'revoke',
  assetId: string,
  windowId: string | null,
  form: FormData,
): Promise<
  | { readonly ok: true; readonly session: WebSession; readonly submissionId: string }
  | { readonly ok: false; readonly state: RecordFormState<never, never> }
> {
  const session = await currentSession();
  if (!session) return { ok: false, state: { kind: 'REFUSED', reason: 'NO_SESSION' } };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { ok: false, state: { kind: 'REFUSED', reason: 'CSRF' } };

  const submissionId = form.get(SUBMISSION_FIELD);
  // Bound to this session: a well-formed id this server never issued, another
  // person's id, and an id from an earlier login are all refused here.
  if (!isBoundSubmissionId(submissionId, session)) {
    return { ok: false, state: { kind: 'REFUSED', reason: 'SUBMISSION' } };
  }

  // Not issued to this session for this command, or for another machine or
  // window than the ones the action is bound to: the post cannot be shown to be
  // the page's own. Another's genuine baseline is refused with the same answer
  // as a forged one, before anything is parsed or sent.
  const baseline: AvailabilityBaseline | null = openAvailabilityBaseline(
    session,
    form.get(BASELINE_FIELD),
    command,
  );
  if (!baseline || baseline.assetId !== assetId || (baseline.windowId ?? null) !== windowId) {
    return { ok: false, state: { kind: 'REFUSED', reason: 'BASELINE' } };
  }
  return { ok: true, session, submissionId };
}

/** What every command says for an outcome that is not a success and not a field problem. */
function failureState(
  result: Exclude<WriteResult<unknown, never>, { kind: 'CREATED' | 'INVALID' }>,
): RecordFormState<never, never> {
  switch (result.kind) {
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND', correlationId: result.correlationId };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe applied, not confirmed: never "nothing was saved". Pressing
      // the button again carries the same submission id, so for a declaration
      // that landed the second send is its replay and declares nothing more.
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}

export async function runDeclare(
  /** The machine of the page this form was drawn on — bound by the form, never a field of it. */
  assetId: string,
  form: FormData,
): Promise<DeclareFormState> {
  const gate = await authorize('declare', assetId, null, form);
  if (!gate.ok) return gate.state;

  const values = declareAvailabilityFormValues(form);
  const parsed = parseDeclareAvailabilityForm(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId: gate.submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await declareAvailability(gate.session, assetId, parsed.body, gate.submissionId);

  if (result.kind === 'CREATED') {
    // Redirect, not state: a refreshed page must not resubmit, and the page the
    // person lands on reads availability again, so it shows what was declared.
    const notice: AvailabilityNotice = 'availabilityDeclared';
    redirect(assetPath(assetId, mintFlash(gate.session, assetId, notice)));
  }
  if (result.kind === 'INVALID') {
    return {
      kind: 'INVALID',
      submissionId: gate.submissionId,
      values,
      fieldErrors: result.fieldErrors,
      message: result.message,
    };
  }
  return failureState(result);
}

export async function runRevoke(
  /** The machine and the window of the control this form was drawn for — bound, never fields. */
  assetId: string,
  windowId: string,
  form: FormData,
): Promise<RevokeFormState> {
  const gate = await authorize('revoke', assetId, windowId, form);
  if (!gate.ok) return gate.state;

  const result = await revokeAvailability(gate.session, windowId, gate.submissionId);

  if (result.kind === 'CREATED') {
    const notice: AvailabilityNotice = 'availabilityRevoked';
    redirect(assetPath(assetId, mintFlash(gate.session, assetId, notice)));
  }
  if (result.kind === 'INVALID') {
    // No field: the one thing fleet-service refuses a revoke for is that the
    // declaration is already withdrawn, and its sentence says so.
    return {
      kind: 'INVALID',
      submissionId: gate.submissionId,
      values: {},
      fieldErrors: {},
      message: result.message,
    };
  }
  return failureState(result);
}
