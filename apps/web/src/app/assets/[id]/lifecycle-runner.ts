import { redirect } from 'next/navigation';

import { BASELINE_FIELD, FLASH_PARAM } from '@/lib/form-fields';
import type { AssetLifecycleCommand, AssetLifecycleNotice } from '@/lib/asset-lifecycle-fields';
import {
  ASSET_LIFECYCLE_CONFLICT_MESSAGE,
  openAssetLifecycleBaseline,
  type AssetLifecycleBaseline,
  type ParsedLifecycleForm,
} from '@/server/asset-lifecycle-commands';
import { verifyCsrf } from '@/server/csrf';
import { currentSession } from '@/server/current-session';
import { mintFlash } from '@/server/flash';
import type { WebSession } from '@/server/session';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import type { WriteResult } from '@/server/write';

import type { LifecycleFormState } from './lifecycle-form-state';

/**
 * The one path every lifecycle command on `/assets/[id]` takes.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * the submission id, what the command was drawn from, the form, and only then
 * the gateway. Each refusal is decided before the next step runs, so a refused
 * post never reaches it — which `lifecycle-actions.spec.ts` asserts for each
 * command.
 *
 * Not a `'use server'` module: that directive turns every export into a
 * network-callable action, and this is a helper the three actions share.
 *
 * ## Which asset
 *
 * The asset is the page's own, bound by the form, and the signed baseline must
 * name the same one. The baseline still carries the version, the status shown
 * and the name; the binding is what stops a valid baseline for one asset from
 * being posted in another asset's form.
 *
 * ## Why a second press is not a second write
 *
 * Every command is sent with the version its page was drawn at. The first press
 * moves the version, so a second send of the same form — a double click, a
 * browser retry, a resubmitted POST — is a `409` from asset-service, which this
 * runner sends to a fresh read of the dossier with a sentence saying nothing was
 * written this time (`lifecycleConflict`).
 */

export interface LifecycleCommand<V, B, F extends string> {
  readonly command: AssetLifecycleCommand;
  readonly notice: AssetLifecycleNotice;
  readonly valuesOf: (form: FormData) => V;
  /** `baseline.status` is what the page showed, which the offered choices came from. */
  readonly parse: (values: V, baseline: AssetLifecycleBaseline) => ParsedLifecycleForm<B, F>;
  readonly send: (
    session: WebSession,
    baseline: AssetLifecycleBaseline,
    body: B,
    submissionId: string,
  ) => Promise<WriteResult<{ id: string }, F>>;
}

const assetPath = (assetId: string, flash: string): string =>
  `/assets/${encodeURIComponent(assetId)}?${FLASH_PARAM}=${flash}`;

export async function runLifecycle<V, B, F extends string>(
  command: LifecycleCommand<V, B, F>,
  /**
   * The asset of the page this form was drawn on — the route's id, bound to the
   * action by the form (`action.bind(null, assetId)`), never a field of it.
   */
  assetId: string,
  form: FormData,
): Promise<LifecycleFormState<V, F>> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: 'NO_SESSION' };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  // Bound to this session: a well-formed id this server never issued, another
  // person's id, and an id from an earlier login are all refused here.
  if (!isBoundSubmissionId(submissionId, session)) {
    return { kind: 'REFUSED', reason: 'SUBMISSION' };
  }

  // The asset, its version and the status shown come from here and from nowhere
  // else. Not issued to this session for this command, or too old: nothing says
  // what the person was shown, so nothing can be sent.
  const baseline = openAssetLifecycleBaseline(session, form.get(BASELINE_FIELD), command.command);
  if (!baseline) return { kind: 'REFUSED', reason: 'BASELINE' };

  // A baseline is valid for **its** asset, and this form belongs to the page's.
  // Another asset's genuine baseline for this same person and command (it
  // opens above) must not act here: the person confirmed this page's name, and
  // a swapped token would retire the other machine under it. Refused before
  // anything is parsed or sent, with the same answer as any other bad baseline.
  if (baseline.assetId !== assetId) return { kind: 'REFUSED', reason: 'BASELINE' };

  const values = command.valuesOf(form);
  const parsed = command.parse(values, baseline);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await command.send(session, baseline, parsed.body, submissionId);

  if (result.kind === 'CREATED') {
    // Redirect, not state: a refreshed page must not resubmit, and the page the
    // person lands on reads the asset again, so it shows what the command did.
    redirect(assetPath(baseline.assetId, mintFlash(session, baseline.assetId, command.notice)));
  }

  switch (result.kind) {
    case 'INVALID':
      if (result.message === ASSET_LIFECYCLE_CONFLICT_MESSAGE) {
        // The same stale baseline would conflict again, so the typed values are
        // not offered back for another try: the person sees the page as it is.
        redirect(
          assetPath(baseline.assetId, mintFlash(session, baseline.assetId, 'lifecycleConflict')),
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
      // Sent, maybe committed, not confirmed: never "nothing was changed". The
      // portal does not retry for the person; pressing the button again carries
      // the same version, so if the first landed the second is a 409 and
      // changes nothing.
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}
