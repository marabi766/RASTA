import { z } from 'zod';

import type { TopUpFormState } from '@/app/wallet/form-state';
import { open, seal, type WebSession } from './session';
import { mintSubmissionId, submissionBinding } from './submission';
import { readUnresolved, releaseToken, requestDigest } from './unresolved-request';

export const topUpScope = (walletId: string): { purpose: string; target: string } => ({
  purpose: 'wallet-top-up',
  target: walletId,
});

// Reuse the store's opaque ref for an encrypted snapshot; no amount is stored in clear text.
const snapshotSchema = z.object({ submissionId: z.string(), amountMinor: z.string() }).strict();
const snapshotKey = (session: WebSession, walletId: string): string =>
  requestDigest(session, 'wallet-top-up-snapshot', {
    walletId,
    login: submissionBinding(session).session,
  });

export function topUpSnapshot(
  session: WebSession,
  walletId: string,
  submissionId: string,
  amountMinor: string,
): string {
  return seal({ submissionId, amountMinor }, snapshotKey(session, walletId));
}

/** A held top-up is reconciliation-only: no fresh key, no automatic replay after backend retention. */
export async function restoreTopUp(
  session: WebSession,
  walletId: string,
): Promise<TopUpFormState & { submissionId: string }> {
  const pending = await readUnresolved(session, topUpScope(walletId));
  if (pending.kind === 'NONE') return { kind: 'IDLE', submissionId: mintSubmissionId(session) };
  const token =
    pending.kind === 'PENDING'
      ? releaseToken(session, topUpScope(walletId), pending.request)
      : undefined;
  if (pending.kind === 'PENDING' && !pending.request.former && pending.request.ref) {
    const saved = open(pending.request.ref, snapshotKey(session, walletId), snapshotSchema);
    if (saved && saved.submissionId === pending.request.key) {
      return {
        kind: 'HELD',
        releaseToken: token,
        submissionId: saved.submissionId,
        values: { amountMinor: saved.amountMinor },
      };
    }
  }
  // Missing, corrupt, foreign or unavailable: no usable key and no writable form.
  return { kind: 'NOT_CHECKED', submissionId: '', releaseToken: token };
}
