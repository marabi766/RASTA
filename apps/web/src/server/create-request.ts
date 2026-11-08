import { z } from 'zod';
import type { RequestNotChecked } from '@/lib/request-not-checked';
import { REGISTER_ASSET_FIELDS } from '@/lib/asset-form-fields';
import { CREATE_DRIVER_FIELDS } from '@/lib/driver-fields';
import { seal, type WebSession } from './session';
import { submissionBinding } from './submission';
import { restoreRequestSnapshot } from './request-snapshot';
import {
  requestDigest,
  reserveUnresolved,
  settleUnresolved,
  releaseUnresolved,
} from './unresolved-request';
import { MAX_REQUEST_REF_LENGTH } from './unresolved-request-store';
import { isProvenRefusal, type WriteResult } from './write';

const snapshotSchema = z
  .object({
    submissionId: z.string(),
    values: z.record(z.string(), z.string()),
  })
  .strict();

/** Same reservation/ref/restore mechanism as top-ups; these services have no replay fence. */
function createRequest<F extends string>(purpose: string, fields: readonly F[]) {
  type Values = Readonly<Record<F, string>>;
  type Hold = { kind: 'HELD'; submissionId: string; values: Values; releaseToken: string };
  const scope = { purpose };
  const key = (session: WebSession): string =>
    requestDigest(session, `${purpose}-snapshot`, {
      login: submissionBinding(session).session,
    });
  const values = (input: Values): Values =>
    Object.fromEntries(
      fields.map((field) => [field, input[field].replace(/\r\n?/g, '\n')]),
    ) as Record<F, string>;
  async function restore(
    session: WebSession,
  ): Promise<
    Hold | { kind: 'IDLE'; submissionId: string } | (RequestNotChecked & { submissionId: string })
  > {
    const state = await restoreRequestSnapshot(session, scope, key(session), snapshotSchema);
    if (state.kind !== 'HELD') return state;
    const saved = state.snapshot.values;
    if (
      Object.keys(saved).length !== fields.length ||
      !fields.every((f) => Object.hasOwn(saved, f))
    )
      return {
        kind: 'NOT_CHECKED',
        reason: 'SNAPSHOT_UNREADABLE',
        submissionId: '',
        releaseToken: state.releaseToken,
      };
    return {
      kind: 'HELD',
      submissionId: state.submissionId,
      values: saved as Values,
      releaseToken: state.releaseToken,
    };
  }
  const snapshot = (session: WebSession, submissionId: string, heldValues: Values): string =>
    seal({ submissionId, values: heldValues }, key(session));
  async function send<T>(
    session: WebSession,
    submissionId: string,
    heldValues: Values,
    body: unknown,
    dispatch: () => Promise<WriteResult<T, F>>,
  ): Promise<
    | Hold
    | RequestNotChecked
    | {
        kind: 'UNCONFIRMED';
        correlationId: string;
        releaseToken?: string;
        submissionId: string;
        values: Values;
      }
    | { kind: 'RESULT'; result: WriteResult<T, F> }
  > {
    const ref = snapshot(session, submissionId, heldValues);
    if (ref.length > MAX_REQUEST_REF_LENGTH)
      return { kind: 'NOT_CHECKED', reason: 'SNAPSHOT_TOO_LARGE' };
    const reserved = await reserveUnresolved(session, scope, {
      key: submissionId,
      digest: requestDigest(session, purpose, body),
      ref,
      issuedAt: Date.now(),
      deadline: null,
      windowMs: null,
    });
    if (reserved.kind === 'CAPACITY') return { kind: 'NOT_CHECKED', reason: 'CAPACITY' };
    if (reserved.kind !== 'RESERVED') {
      const state = await restore(session);
      return state.kind === 'IDLE' ? { kind: 'NOT_CHECKED', reason: 'STORE_UNAVAILABLE' } : state;
    }
    let result: WriteResult<T, F>;
    try {
      result = await dispatch();
    } catch (error) {
      await settleUnresolved(reserved.attempt, 'UNRESOLVED');
      throw error;
    }
    const ambiguous =
      result.kind === 'UNKNOWN_OUTCOME' ||
      result.kind === 'IN_PROGRESS' ||
      (result.kind === 'UNAVAILABLE' &&
        !result.neverSent &&
        !isProvenRefusal(result.status, result.code));
    await settleUnresolved(
      reserved.attempt,
      result.kind === 'CREATED' ? 'CONFIRMED' : ambiguous ? 'UNRESOLVED' : 'REFUSED',
    );
    const restored = ambiguous ? await restore(session) : null;
    return ambiguous
      ? {
          kind: 'UNCONFIRMED',
          releaseToken: restored && 'releaseToken' in restored ? restored.releaseToken : undefined,
          correlationId: result.correlationId,
          submissionId,
          values: heldValues,
        }
      : { kind: 'RESULT', result };
  }
  return {
    restore,
    snapshot,
    send,
    values,
    release: (session: WebSession, token: unknown) => releaseUnresolved(session, scope, token),
  };
}

export const assetRegistrationRequest = createRequest('asset-register', REGISTER_ASSET_FIELDS);
export const driverCreationRequest = createRequest('driver-create', CREATE_DRIVER_FIELDS);
