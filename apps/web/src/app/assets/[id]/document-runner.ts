import { redirect } from 'next/navigation';

import { BASELINE_FIELD, FLASH_PARAM } from '@/lib/form-fields';
import { FILE_FIELD, UPLOAD_TOKEN_FIELD } from '@/lib/asset-document-fields';
import {
  DOCUMENT_REFERENCE_REFUSED_MESSAGE,
  attachAssetDocument,
  attachDocumentFormValues,
  chosenFile,
  openAssetDocumentBaseline,
  openUploadedDocument,
  parseAttachDocumentForm,
  sealUploadedDocument,
  uploadDocument,
} from '@/server/asset-documents';
import { verifyCsrf } from '@/server/csrf';
import { currentSession } from '@/server/current-session';
import { mintFlash } from '@/server/flash';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';

import type { DocumentFormState } from './document-form-state';

/**
 * The one path the attach-document command on `/assets/[id]` takes.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * the submission id, which asset the post was drawn for, the form, and only then
 * the gateway — each refusal decided before the next step runs, so a refused
 * post never reaches it (`document-actions.spec.ts` asserts it).
 *
 * Not a `'use server'` module: that directive turns every export into a
 * network-callable action, and this is a helper.
 *
 * ## The text is judged before the file moves
 *
 * The title and dates are parsed first. A form that will be refused for its
 * title must not leave a registered document behind, so nothing is uploaded
 * until what will be attached to it is known to be well-formed.
 *
 * ## A resend is not a second upload
 *
 * Once the file is registered, every outcome that is not a success carries
 * `resume`: a token, signed for this session, this machine and this submission,
 * that names the registered document. A resend of the same submission brings it
 * back, the file is not uploaded again, and the attach goes to asset-service
 * with the same `documentId` under the same `Idempotency-Key` — which is the
 * replay asset-service recognises. A token that does not open for exactly this
 * session, machine and submission is refused like a forged one.
 */
export async function runAttachDocument(
  /** The machine of the page this form was drawn on — bound by the form, never a field of it. */
  assetId: string,
  form: FormData,
): Promise<DocumentFormState> {
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

  // Not issued to this session, or for another machine than the one the action
  // is bound to: the post cannot be shown to be the page's own.
  const baseline = openAssetDocumentBaseline(session, form.get(BASELINE_FIELD));
  if (!baseline || baseline.assetId !== assetId) return { kind: 'REFUSED', reason: 'BASELINE' };

  // A resend names the document this submission already registered — or nothing.
  const rawToken = form.get(UPLOAD_TOKEN_FIELD);
  const hasToken = typeof rawToken === 'string' && rawToken !== '';
  const uploaded = hasToken
    ? openUploadedDocument(session, rawToken, { assetId: baseline.assetId, submissionId })
    : null;
  if (hasToken && !uploaded) return { kind: 'REFUSED', reason: 'UPLOAD' };
  const resumeToken = hasToken ? rawToken : null;

  const values = attachDocumentFormValues(form);
  const parsed = parseAttachDocumentForm(values);
  const file = uploaded ? null : chosenFile(form, FILE_FIELD);

  if (!parsed.ok || (file !== null && !file.ok)) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: {
        ...(parsed.ok ? {} : parsed.fieldErrors),
        ...(file !== null && !file.ok ? { file: file.message } : {}),
      },
      message: null,
      resume: resumeToken,
    };
  }

  let documentId = uploaded?.documentId ?? null;
  if (documentId === null) {
    if (file === null || !file.ok) throw new Error('unreachable: no file and no uploaded document');
    const outcome = await uploadDocument(session, {
      assetId: baseline.assetId,
      kind: parsed.body.kind,
      file: file.file,
      submissionId,
    });
    switch (outcome.kind) {
      case 'REGISTERED':
        documentId = outcome.documentId;
        break;
      case 'REFUSED':
        return {
          kind: 'INVALID',
          submissionId,
          values,
          fieldErrors: { file: outcome.message },
          message: null,
          resume: null,
        };
      case 'FORBIDDEN':
        return { kind: 'FORBIDDEN', correlationId: outcome.correlationId };
      case 'FAILED':
        return {
          kind: 'FAILED',
          status: outcome.status,
          correlationId: outcome.correlationId,
          resume: null,
        };
      case 'UNCONFIRMED':
        return { kind: 'UNCONFIRMED', correlationId: outcome.correlationId, resume: null };
    }
  }

  // Whatever follows, a resend must not upload this file again.
  const resume =
    resumeToken ??
    sealUploadedDocument(session, { assetId: baseline.assetId, submissionId, documentId });

  const result = await attachAssetDocument(
    session,
    baseline.assetId,
    documentId,
    parsed.body,
    submissionId,
  );

  if (result.kind === 'CREATED') {
    // Redirect, not state: a refreshed page must not resubmit, and the page the
    // person lands on reads the dossier again, so it lists what was attached.
    redirect(
      `/assets/${encodeURIComponent(baseline.assetId)}?${FLASH_PARAM}=${mintFlash(session, baseline.assetId, 'documentAttached')}`,
    );
  }

  switch (result.kind) {
    case 'INVALID':
      return {
        kind: 'INVALID',
        submissionId,
        values,
        fieldErrors: result.fieldErrors,
        // The file is registered; say that, so the person does not re-pick it.
        message: result.message ?? DOCUMENT_REFERENCE_REFUSED_MESSAGE,
        resume,
      };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND', correlationId: result.correlationId };
    case 'UNAVAILABLE':
      return {
        kind: 'FAILED',
        status: result.status,
        correlationId: result.correlationId,
        resume,
      };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe attached, not confirmed: never "nothing was saved". The
      // portal does not retry for the person; pressing the button again carries
      // the same submission id and the same document, so if the first landed the
      // second is its replay and attaches nothing more.
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId, resume };
  }
}
