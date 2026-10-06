'use server';

import type { DeclareFormState, RevokeFormState } from './availability-form-state';
import { runDeclare, runRevoke } from './availability-runner';

/**
 * The two availability commands on a machine's page: declare, and revoke a
 * declaration. They run through `availability-runner.ts`.
 *
 * Neither reads an asset or a window id from the form: they are the page's own,
 * bound to the action by the form (`action.bind(null, assetId[, windowId])`) and
 * named by the signed baseline the page minted for that form.
 */

export async function submitDeclareAvailability(
  assetId: string,
  _previous: DeclareFormState,
  form: FormData,
): Promise<DeclareFormState> {
  return runDeclare(assetId, form);
}

export async function submitRevokeAvailability(
  assetId: string,
  windowId: string,
  _previous: RevokeFormState,
  form: FormData,
): Promise<RevokeFormState> {
  return runRevoke(assetId, windowId, form);
}
