import { z } from 'zod';

import { RETURN_COMMANDS, type ReturnCommand } from '@/lib/return-fields';
import type { ReplayStamp, ReturnScope, ReturnSubmission } from '@/lib/unresolved-return';

import { webServerEnv, type WebServerEnv } from './env';
import { signPayload, verifyPayload } from './signed-payload';
import type { WebSession } from './session';
import { mintSubmissionId } from './submission';

/**
 * Until when a return command may be sent again under its original key, and
 * **what** it is — decided by this server, from a stamp it signed when the
 * page drew the form (`server/dispute-replay.ts` is the original; same
 * construction, same reasons).
 *
 * ## Until when
 *
 * marketplace-service answers the same key with its stored response only
 * while its idempotency record lives (`MARKETPLACE_IDEMPOTENCY_TTL_HOURS`);
 * past that the same request runs **as new** — and a return request run again
 * is a second request for the same goods. The stamp's signed expiry is that
 * retention (`WEB_MARKETPLACE_IDEMPOTENCY_TTL_HOURS`, mirroring it) less a
 * margin (`WEB_RETURN_REPLAY_MARGIN_SECONDS`), counted from when the page drew
 * the form — before the first send could leave. It is accepted only while that
 * and issuance plus the window **as configured now** both hold, so a retention
 * shortened later shortens every stamp already out.
 *
 * ## What
 *
 * A stamp binds **the order** (a request) or **the return request** (a
 * decision or a withdrawal), the submission id and the command. A decision's
 * whole body is the command (`AUTHORIZE` or `REJECT`), and a withdrawal has
 * none, so the action builds both from the verified stamp — never from the
 * posted form — and the first send and every retry under the key are the same
 * request. A request's reason and lines are typed, so its stamp binds the
 * order and the command only; the unconfirmed view re-sends the body it kept
 * (`lib/unresolved-return.ts`). marketplace-service's return DTOs take no
 * `expectedVersion`, so nothing here can carry one.
 *
 * Bound to this login (`signed-payload.ts`); readable, not secret, not a
 * credential for anything.
 */

const PURPOSE = 'return-replay';

const replaySchema = z.object({
  scope: z.enum(['ORDER', 'RETURN']),
  /** The order for a request; the return request otherwise. */
  targetId: z.string().min(1).max(200),
  submissionId: z.string().min(1).max(200),
  command: z.enum(RETURN_COMMANDS),
  /** When the page signed it, milliseconds since the epoch, server clock. */
  issuedAt: z.number().int().nonnegative(),
  /** The signed expiry again, in milliseconds, for the browser to draw the right controls. */
  until: z.number().int(),
});

/** What a stamp is for: a request on an order, or one command on one return request. */
export type ReturnTarget =
  | { readonly command: 'REQUEST'; readonly orderId: string }
  | { readonly command: Exclude<ReturnCommand, 'REQUEST'>; readonly returnId: string };

type ReplayEnv = Pick<
  WebServerEnv,
  'WEB_MARKETPLACE_IDEMPOTENCY_TTL_HOURS' | 'WEB_RETURN_REPLAY_MARGIN_SECONDS'
>;

/** Seconds from the page being drawn until the same request may no longer be sent. */
export function returnReplayWindowSeconds(env: ReplayEnv = webServerEnv()): number {
  return env.WEB_MARKETPLACE_IDEMPOTENCY_TTL_HOURS * 60 * 60 - env.WEB_RETURN_REPLAY_MARGIN_SECONDS;
}

function scopeOf(target: ReturnTarget): ReturnScope {
  return target.command === 'REQUEST'
    ? { kind: 'ORDER', orderId: target.orderId }
    : { kind: 'RETURN', returnId: target.returnId };
}

function bindingOf(scope: ReturnScope): { scope: 'ORDER' | 'RETURN'; targetId: string } {
  return scope.kind === 'ORDER'
    ? { scope: 'ORDER', targetId: scope.orderId }
    : { scope: 'RETURN', targetId: scope.returnId };
}

/** The stamp for `submissionId` on `target`, from `now`. */
export function mintReturnStamp(
  session: WebSession,
  target: ReturnTarget,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): ReplayStamp {
  const window = returnReplayWindowSeconds(env);
  const until = (Math.floor(now / 1000) + window) * 1000;
  return {
    token: signPayload(
      session,
      PURPOSE,
      {
        ...bindingOf(scopeOf(target)),
        command: target.command,
        submissionId,
        issuedAt: now,
        until,
      },
      window,
      now,
    ),
    until,
  };
}

/** A fresh submission id for one return form on `target`, with its stamp. */
export function mintReturnSubmission(
  session: WebSession,
  target: ReturnTarget,
  now: number = Date.now(),
): ReturnSubmission {
  const id = mintSubmissionId(session);
  return { id, replay: mintReturnStamp(session, target, id, now) };
}

/** A stamp the action verified, with the command it binds the request to. */
export interface VerifiedReturnStamp extends ReplayStamp {
  readonly command: ReturnCommand;
}

/**
 * The stamp, only if this server issued it to this login, for this slot (the
 * order, or the return request) and this submission id, its signed expiry has
 * not passed and it is still inside the window as configured now; otherwise
 * null — one answer for every way it can be wrong.
 */
export function verifyReturnStamp(
  session: WebSession,
  token: unknown,
  scope: ReturnScope,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): VerifiedReturnStamp | null {
  const payload = verifyPayload(session, PURPOSE, token, replaySchema, now);
  const bound = bindingOf(scope);
  if (
    payload === null ||
    typeof token !== 'string' ||
    payload.scope !== bound.scope ||
    payload.targetId !== bound.targetId ||
    payload.submissionId !== submissionId ||
    (payload.command === 'REQUEST') !== (scope.kind === 'ORDER')
  ) {
    return null;
  }
  const current = payload.issuedAt + returnReplayWindowSeconds(env) * 1000;
  if (now > current) return null;
  return { token, until: Math.min(payload.until, current), command: payload.command };
}
