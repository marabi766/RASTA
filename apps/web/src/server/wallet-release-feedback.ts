import { z } from 'zod';

import type { WebSession } from './session';
import { signPayload, verifyPayload } from './signed-payload';
import type { ReleaseOutcome } from './unresolved-request';

const PURPOSE = 'wallet-release-feedback';
const FLASH_TTL_SECONDS = 30;
const schema = z.object({
  walletId: z.string(),
  outcome: z.enum(['RELEASED', 'GONE', 'STALE', 'IN_PROGRESS', 'UNAVAILABLE']),
});

export function walletReleaseFeedback(
  session: WebSession,
  walletId: string,
  outcome: ReleaseOutcome,
): string {
  return signPayload(session, PURPOSE, { walletId, outcome }, FLASH_TTL_SECONDS);
}

export function readWalletReleaseFeedback(
  session: WebSession,
  walletId: string,
  token: unknown,
  idle: boolean,
): ReleaseOutcome | undefined {
  const flash = verifyPayload(session, PURPOSE, token, schema);
  if (!flash || flash.walletId !== walletId) return undefined;
  // A signed success can be replayed within its TTL. A newer hold or an unreadable store wins.
  if (!idle && (flash.outcome === 'RELEASED' || flash.outcome === 'GONE')) return undefined;
  return flash.outcome;
}
