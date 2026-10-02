'use server';

import { redirect } from 'next/navigation';

import { BASELINE_FIELD, FLASH_PARAM } from '@/lib/form-fields';
import { currentSession } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { mintFlash } from '@/server/flash';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import {
  ASSET_EDIT_CONFLICT_MESSAGE,
  changedUpdateFields,
  openAssetBaseline,
  parseUpdateAssetForm,
  updateAsset,
  updateAssetFormValues,
} from '@/server/asset-commands';

import type { UpdateAssetFormState } from './form-state';

/**
 * The `/assets/[id]` edit form's server action.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5), with two steps
 * an edit adds:
 *
 * 1. **The baseline.** The form carries a signed token holding the values and
 *    version it was drawn from (`server/asset-commands.ts`). The action diffs the
 *    submission against *that* and sends only what the person changed, with the
 *    version, so an edit cannot restore a field somebody else has since saved and
 *    asset-service refuses (409) an edit made against a version that is gone.
 * 2. **A conflict goes to a fresh read.** When the service says the machine
 *    changed, the typed values are not offered back for another try against the
 *    same stale baseline — that would conflict again — the person is sent to the
 *    page as it is now, with a sentence saying their edit was not saved.
 *
 * The asset id is not form content: a `useActionState` action only ever receives
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
  // Bound to this session: a well-formed id this server never issued, another
  // person's id, and an id from an earlier login are all refused here, before
  // anything is sent.
  if (!isBoundSubmissionId(submissionId, session)) {
    return { kind: 'REFUSED', reason: 'SUBMISSION' };
  }

  const baseline = openAssetBaseline(session, form.get(BASELINE_FIELD), assetId);
  // Not issued to this session for this machine, or too old: nothing here says
  // what the person was shown, so nothing can be diffed or sent.
  if (!baseline) return { kind: 'REFUSED', reason: 'BASELINE' };

  const values = updateAssetFormValues(form);
  const changed = changedUpdateFields(values, baseline.values);
  if (changed.length === 0) {
    // Nothing to send, and saying so is the honest answer: a request that
    // changes nothing would only move the version.
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: {},
      message: 'چیزی تغییر نکرده است؛ مقداری را عوض کنید و دوباره ذخیره کنید.',
    };
  }

  const parsed = parseUpdateAssetForm(values, changed);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await updateAsset(
    session,
    assetId,
    parsed.request,
    baseline.version,
    submissionId,
  );

  if (result.kind === 'CREATED') {
    redirect(
      `/assets/${encodeURIComponent(assetId)}?${FLASH_PARAM}=${mintFlash(session, assetId, 'updated')}`,
    );
  }

  switch (result.kind) {
    case 'INVALID':
      if (result.message === ASSET_EDIT_CONFLICT_MESSAGE) {
        redirect(
          `/assets/${encodeURIComponent(assetId)}?${FLASH_PARAM}=${mintFlash(session, assetId, 'conflict')}`,
        );
      }
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
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was saved". In
      // progress is the same unknown (asset-service stores no submission id, so
      // it never says this; the gateway's answer is handled all the same).
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}
