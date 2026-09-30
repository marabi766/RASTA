'use server';

import { redirect } from 'next/navigation';

import { currentSession } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { isSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import { parseUpdateAssetForm, updateAsset, updateAssetFormValues } from '@/server/asset-commands';

import type { UpdateAssetFormState } from './form-state';

/**
 * The `/assets/[id]` edit form's server action.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5). The asset id is
 * not form content: a `useActionState` action only ever receives
 * `(previousState, formData)`, so the form calls this bound
 * (`action.bind(null, assetId)`, the Next.js way to carry a value a form does
 * not collect), which also means the id cannot be tampered with through a
 * field the way a value can.
 */

export async function submitUpdateAsset(
  assetId: string,
  _previous: UpdateAssetFormState,
  form: FormData,
): Promise<UpdateAssetFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: 'NO_SESSION' };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isSubmissionId(submissionId)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  const values = updateAssetFormValues(form);
  const parsed = parseUpdateAssetForm(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await updateAsset(session, assetId, parsed.request, submissionId);

  if (result.kind === 'CREATED') {
    redirect(`/assets/${encodeURIComponent(assetId)}?updated=1`);
  }

  switch (result.kind) {
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
      return { kind: 'NOT_FOUND', correlationId: result.correlationId };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was saved".
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}
