import type { z } from 'zod';
import type { RequestNotChecked } from '@/lib/request-not-checked';
import { open, type WebSession } from './session';
import { mintSubmissionId } from './submission';
import { readUnresolved, releaseToken, type UnresolvedScope } from './unresolved-request';

/** Restore the encrypted ref used by reconciliation-only creates, including wallet top-ups. */
export async function restoreRequestSnapshot<T extends { submissionId: string }>(
  session: WebSession,
  scope: UnresolvedScope,
  key: string,
  schema: z.ZodType<T>,
): Promise<
  | { kind: 'IDLE'; submissionId: string }
  | { kind: 'HELD'; submissionId: string; snapshot: T; releaseToken: string }
  | (RequestNotChecked & { submissionId: string })
> {
  const pending = await readUnresolved(session, scope, true);
  if (pending.kind === 'NONE') return { kind: 'IDLE', submissionId: mintSubmissionId(session) };
  if (pending.kind === 'UNAVAILABLE')
    return { kind: 'NOT_CHECKED', submissionId: '', reason: pending.reason ?? 'STORE_UNAVAILABLE' };
  const token =
    pending.kind === 'PENDING' ? releaseToken(session, scope, pending.request) : undefined;
  if (
    token !== undefined &&
    pending.kind === 'PENDING' &&
    !pending.request.former &&
    pending.request.ref
  ) {
    const saved = open(pending.request.ref, key, schema);
    if (saved && saved.submissionId === pending.request.key)
      return {
        kind: 'HELD',
        submissionId: saved.submissionId,
        snapshot: saved,
        releaseToken: token,
      };
  }
  return {
    kind: 'NOT_CHECKED',
    submissionId: '',
    releaseToken: token,
    reason: pending.request.former ? 'FORMER_COPY' : 'SNAPSHOT_UNREADABLE',
  };
}
