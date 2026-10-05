import type { UnconfirmedWriteState } from '@/lib/unconfirmed-write';
import type { AttachDocumentField, AttachDocumentFormValues } from '@/lib/asset-document-fields';

/**
 * What the attach-document form knows after an attempt.
 *
 * The same family as `RecordFormState`, with one addition: `resume`. Attaching
 * is a chain (upload, register, attach — `server/asset-documents.ts`), and once
 * the file is registered the chain must not run again from the top, so every
 * state that can follow a registered file carries the signed token that lets a
 * resend of the same submission attach it again.
 *
 * A module of its own because `document-actions.ts` is a `'use server'` file and
 * may export only async functions.
 *
 * Success has no state to render: the action redirects to a fresh read of the
 * dossier (a signed `?flash=`), which is also what makes a refresh unable to
 * resubmit.
 */
export type DocumentFormState =
  | { readonly kind: 'IDLE' }
  /** The person's own values, kept so the form is not emptied under them — all but the file, which a browser cannot be given back. */
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: AttachDocumentFormValues;
      readonly fieldErrors: Partial<Record<AttachDocumentField, string>>;
      /** A problem the service did not attach to a field. */
      readonly message: string | null;
      readonly resume: string | null;
    }
  /**
   * The machine is no longer visible to this person. The platform answers
   * "absent" and "not yours" the same way, so this says no more than that.
   */
  | { readonly kind: 'NOT_FOUND'; readonly correlationId: string }
  /** The post could not be trusted as this person's own. */
  | {
      readonly kind: 'REFUSED';
      readonly reason: 'NO_SESSION' | 'CSRF' | 'SUBMISSION' | 'BASELINE' | 'UPLOAD';
    }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  | {
      readonly kind: 'FAILED';
      readonly status: number;
      readonly correlationId: string;
      readonly resume: string | null;
    }
  | (UnconfirmedWriteState & { readonly resume: string | null });

export const IDLE_DOCUMENT_FORM = { kind: 'IDLE' } as const;
