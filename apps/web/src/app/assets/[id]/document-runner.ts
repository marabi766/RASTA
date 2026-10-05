import { redirect } from 'next/navigation';

import { BASELINE_FIELD, FLASH_PARAM } from '@/lib/form-fields';
import { FILE_FIELD, UPLOAD_TOKEN_FIELD } from '@/lib/asset-document-fields';
import {
  ATTACH_KEY_REUSED_MESSAGE,
  DOCUMENT_REFERENCE_REFUSED_MESSAGE,
  RESUME_FILE_CHANGED_MESSAGE,
  RESUME_KIND_CHANGED_MESSAGE,
  attachAssetDocument,
  attachDocumentFormValues,
  chosenFile,
  fingerprintOf,
  openAssetDocumentBaseline,
  openUploadedDocument,
  parseAttachDocumentForm,
  resumeMismatch,
  sealUploadedDocument,
  uploadDocument,
  type FileFingerprint,
} from '@/server/asset-documents';
import { verifyCsrf } from '@/server/csrf';
import { currentSession } from '@/server/current-session';
import { mintFlash } from '@/server/flash';
import { isBoundSubmissionId, mintSubmissionId, SUBMISSION_FIELD } from '@/server/submission';

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
 * ## A resend is not a second upload — while the answer to the first came back
 *
 * Once the file is registered, every outcome that is not a success carries
 * `resume`: a token, signed for this session, this machine and this submission,
 * that names the registered document **and the kind, size and digest it was
 * uploaded as**. A resend of the same submission brings it back, the file is not
 * uploaded again, and the attach goes to asset-service with the same
 * `documentId` under the same `Idempotency-Key` — which is the replay
 * asset-service recognises. A token that does not open for exactly this
 * session, machine and submission is refused like a forged one; a resend that
 * names another kind, or brings another file, is not a resend of that document and
 * is told to start afresh (below).
 *
 * ## What is NOT guaranteed, and what happens instead (Codex r1 on #225)
 *
 * If the attach succeeded and the **answer was lost** — the connection dropped,
 * the tab closed — the browser has no `resume`, and a resend uploads and
 * registers a **second** document (document-service has no key to recognise the
 * first by; its intent ids are its own). The attach then carries the same
 * `Idempotency-Key` with another `documentId`, which asset-service refuses with
 * `409 IDEMPOTENCY_KEY_REUSED`. So the guarantee is: **never two references**; a
 * lost answer may leave **one orphan document**. The refusal is not a dead end:
 * the person is told plainly to look at the list and, if the document is not
 * there, to send again — and the form is given a **fresh submission id**, so the
 * next send is a new submission rather than the same refused one.
 */
/**
 * The form as it was typed, with a message and a **new** submission id and no
 * resume token: the next send is a fresh submission (a new upload, a new key),
 * not the one that was refused. The file is not kept — a browser cannot be given
 * it back — so the person chooses it again.
 */
function startAfresh(
  session: Parameters<typeof mintSubmissionId>[0],
  values: ReturnType<typeof attachDocumentFormValues>,
  message: string,
): DocumentFormState {
  return {
    kind: 'INVALID',
    submissionId: mintSubmissionId(session),
    values,
    fieldErrors: {},
    message,
    resume: null,
  };
}

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

  if (uploaded) {
    // The token vouches for one document of one kind. A different kind would
    // attach the old file under a new label; a different file in the post would
    // be ignored while the person believes it was attached.
    const posted = chosenFile(form, FILE_FIELD);
    const mismatch = resumeMismatch(uploaded, {
      kind: parsed.body.kind,
      file: posted.ok ? await fingerprintOf(posted.file) : null,
    });
    if (mismatch !== null) {
      return startAfresh(
        session,
        values,
        mismatch === 'KIND' ? RESUME_KIND_CHANGED_MESSAGE : RESUME_FILE_CHANGED_MESSAGE,
      );
    }
  }

  let documentId = uploaded?.documentId ?? null;
  let fingerprint: FileFingerprint | null = uploaded
    ? { sizeBytes: uploaded.sizeBytes, sha256: uploaded.sha256 }
    : null;
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
        fingerprint = outcome.fingerprint;
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
  if (fingerprint === null) throw new Error('unreachable: a registered document has a fingerprint');
  const resume =
    resumeToken ??
    sealUploadedDocument(session, {
      assetId: baseline.assetId,
      submissionId,
      documentId,
      kind: parsed.body.kind,
      ...fingerprint,
    });

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
      // The key was already used for another document: a first send whose answer
      // was lost attached one. Never a second reference, and never a dead end —
      // a fresh submission, after a look at the list.
      if (result.message === ATTACH_KEY_REUSED_MESSAGE) {
        return startAfresh(session, values, ATTACH_KEY_REUSED_MESSAGE);
      }
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
