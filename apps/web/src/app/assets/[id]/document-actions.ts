'use server';

import { keepUnconfirmedWith } from '@/server/unconfirmed-retry';
import type { DocumentFormState } from './document-form-state';
import { runAttachDocument } from './document-runner';

/**
 * The attach-document command on a machine's page. It runs through
 * `document-runner.ts`.
 *
 * It reads no asset id from the form: the asset is the page's own, bound to the
 * action by the form (`action.bind(null, assetId)`) and named by the signed
 * baseline the page minted for it.
 */
export async function submitAttachDocument(
  assetId: string,
  previous: DocumentFormState,
  form: FormData,
): Promise<DocumentFormState> {
  return keepUnconfirmedWith(
    previous,
    () => runAttachDocument(assetId, form),
    // A resend must not upload the file again: the token the retry came back with,
    // else the one the form already held (both are opened again on the next post).
    (correlationId, state, held) => ({
      kind: 'UNCONFIRMED',
      correlationId,
      resume: resumeOf(state) ?? resumeOf(held),
    }),
  );
}

function resumeOf(state: DocumentFormState): string | null {
  return 'resume' in state && typeof state.resume === 'string' ? state.resume : null;
}
