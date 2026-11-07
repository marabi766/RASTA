import { z } from 'zod';

import type { TopUpFormState } from '@/app/wallet/form-state';
import { seal, type WebSession } from './session';
import { submissionBinding } from './submission';
import { requestDigest } from './unresolved-request';
import { restoreRequestSnapshot } from './request-snapshot';

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
  const restored = await restoreRequestSnapshot(
    session,
    topUpScope(walletId),
    snapshotKey(session, walletId),
    snapshotSchema,
  );
  return restored.kind === 'HELD'
    ? {
        kind: 'HELD',
        releaseToken: restored.releaseToken,
        submissionId: restored.submissionId,
        values: { amountMinor: restored.snapshot.amountMinor },
      }
    : restored;
}
