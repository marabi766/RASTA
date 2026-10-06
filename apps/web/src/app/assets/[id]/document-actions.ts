'use server';

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
  _previous: DocumentFormState,
  form: FormData,
): Promise<DocumentFormState> {
  return runAttachDocument(assetId, form);
}
