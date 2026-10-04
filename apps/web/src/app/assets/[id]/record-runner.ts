import { redirect } from 'next/navigation';

import { BASELINE_FIELD, FLASH_PARAM } from '@/lib/form-fields';
import type { RecordNotice } from '@/lib/asset-record-fields';
import {
  openAssetRecordBaseline,
  type AssetRecordKind,
  type ParsedRecordForm,
} from '@/server/asset-records';
import { verifyCsrf } from '@/server/csrf';
import { currentSession } from '@/server/current-session';
import { mintFlash } from '@/server/flash';
import type { WebSession } from '@/server/session';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import type { WriteResult } from '@/server/write';

import type { RecordFormState } from './record-form-state';

/**
 * The one path both record commands on `/assets/[id]` take.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * the submission id, which asset and form the post was drawn for, the form, and
 * only then the gateway. Each refusal is decided before the next step runs, so a
 * refused post never reaches it — which `record-actions.spec.ts` asserts for
 * each command.
 *
 * Not a `'use server'` module: that directive turns every export into a
 * network-callable action, and this is a helper the two actions share.
 *
 * ## Which asset
 *
 * The page's own. The form binds it to the action (`action.bind(null,
 * assetId)`), but that happens in a client component, so the bound id is a value
 * the browser sends back and could be changed on the way. The signed baseline
 * the page minted for this form (`sealAssetRecordBaseline`) names the asset and
 * the form, and the bound id must be the asset it names, or nothing is sent. No
 * field of the form names an asset.
 *
 * ## Why a second press is not a second record
 *
 * The submission id is minted for this render, bound to this session, and sent
 * as `Idempotency-Key`. asset-service stores the first answer under it: the same
 * form sent again — a double click, a browser retry, a resubmitted POST, a send
 * after an unconfirmed one — is that answer replayed, and records nothing. The
 * id stays on the form across an attempt that came back with something to read,
 * so the retry is the same submission; a fresh page mints a fresh one.
 */

export interface RecordCommand<V, B, F extends string> {
  /** Which of the two forms this is: a baseline minted for the other is refused. */
  readonly record: AssetRecordKind;
  readonly notice: RecordNotice;
  readonly valuesOf: (form: FormData) => V;
  readonly parse: (values: V) => ParsedRecordForm<B, F>;
  readonly send: (
    session: WebSession,
    assetId: string,
    body: B,
    submissionId: string,
  ) => Promise<WriteResult<{ id: string }, F>>;
}

const assetPath = (assetId: string, flash: string): string =>
  `/assets/${encodeURIComponent(assetId)}?${FLASH_PARAM}=${flash}`;

export async function runRecord<V, B, F extends string>(
  command: RecordCommand<V, B, F>,
  /**
   * The asset of the page this form was drawn on — bound by the form, never a
   * field of it, and acted on only when the signed baseline names it too.
   */
  assetId: string,
  form: FormData,
): Promise<RecordFormState<V, F>> {
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

  // Not issued to this session for this form, or for another asset than the one
  // the action is bound to: the post cannot be shown to be the page's own.
  // Another asset's genuine baseline is refused with the same answer as a forged
  // one, before anything is parsed or sent.
  const baseline = openAssetRecordBaseline(session, form.get(BASELINE_FIELD), command.record);
  if (!baseline || baseline.assetId !== assetId) return { kind: 'REFUSED', reason: 'BASELINE' };

  const values = command.valuesOf(form);
  const parsed = command.parse(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const result = await command.send(session, baseline.assetId, parsed.body, submissionId);

  if (result.kind === 'CREATED') {
    // Redirect, not state: a refreshed page must not resubmit, and the page the
    // person lands on reads the lists again, so it shows what was recorded.
    redirect(assetPath(baseline.assetId, mintFlash(session, baseline.assetId, command.notice)));
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
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe recorded, not confirmed: never "nothing was saved". The
      // portal does not retry for the person; pressing the button again carries
      // the same submission id, so if the first landed the second is its replay
      // and records nothing more.
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}
