import type { UnconfirmedWriteState } from '@/lib/unconfirmed-write';
import type { UpdateAssetField, UpdateAssetFormValues } from '@/lib/asset-form-fields';

/**
 * What the `/assets/[id]` edit form knows after an attempt.
 *
 * Success has no state to render: the action redirects to a fresh read of the
 * dossier (`?updated=1`), which is also what makes a refresh unable to
 * resubmit.
 */
export type UpdateAssetFormState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'INVALID';
      readonly submissionId: string;
      readonly values: UpdateAssetFormValues;
      readonly fieldErrors: Partial<Record<UpdateAssetField, string>>;
      readonly message: string | null;
    }
  | { readonly kind: 'REFUSED'; readonly reason: 'NO_SESSION' | 'CSRF' | 'SUBMISSION' }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  /**
   * The machine is no longer visible to this person: it was another
   * organization's, or has moved, between the render and the submit. The
   * platform answers "absent" and "not yours" the same way, so this says no
   * more than that.
   */
  | { readonly kind: 'NOT_FOUND'; readonly correlationId: string }
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string }
  | UnconfirmedWriteState;

export const IDLE_UPDATE_ASSET_FORM: UpdateAssetFormState = { kind: 'IDLE' };
