import { z } from 'zod';

import type { DisputeSubmission, ReplayStamp } from '@/lib/unresolved-dispute';

import { webServerEnv, type WebServerEnv } from './env';
import { signPayload, verifyPayload } from './signed-payload';
import type { WebSession } from './session';
import { mintSubmissionId } from './submission';

/**
 * Until when a dispute command may be sent again under its original key —
 * decided by this server, from a time it signed itself (PR 319 review 2,
 * finding 2).
 *
 * ## Why the browser cannot decide it
 *
 * economic-service answers the same key with its stored result only while its
 * idempotency record lives (`ECONOMIC_IDEMPOTENCY_TTL_HOURS`, from the moment
 * the request first reached it). Past that it **deletes the record and runs
 * the request as new** — and a dispute command run again can act on a newer
 * dispute (`lib/unresolved-dispute.ts`). A check in the browser before sending
 * cannot see how long the request then takes to arrive, and its clock and its
 * storage are the browser's to change.
 *
 * ## What is signed, and when
 *
 * When the page draws a form, it mints the submission id and, with it, a
 * stamp for **this transaction and this id** whose signed expiry is the
 * deadline: the service's retention (`WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS`,
 * mirroring it) less a margin for the trip from here to the service
 * (`WEB_DISPUTE_REPLAY_MARGIN_SECONDS`). The page is drawn before the first
 * send can leave, so the service's record — if the request ever reached it —
 * is younger than the stamp, and expires later than the stamp says plus the
 * margin. The stamp is never re-issued for an id: every send under it, the
 * first and each retry, is checked against the same deadline, in the action,
 * just before the call.
 *
 * ## When the retention is shortened later
 *
 * The stamp also signs **when it was issued**, and is accepted only while both
 * hold: its own signed expiry, and issuance plus the window **as configured
 * now** (PR 319 review 3, finding 1). Otherwise a stamp issued under 24 hours
 * would outlive a change to 1 hour by up to 23, and a re-send could reach
 * economic-service after its shorter-lived record had gone. A longer window
 * never extends a stamp: its signed expiry still binds.
 *
 * It is `signed-payload.ts`' construction: bound to this login, readable by
 * whoever holds it (nothing secret in it), not a credential for anything.
 */

const PURPOSE = 'dispute-replay';

const replaySchema = z.object({
  transactionId: z.string().min(1).max(200),
  submissionId: z.string().min(1).max(200),
  /** When the page signed it, milliseconds since the epoch, server clock. */
  issuedAt: z.number().int().nonnegative(),
  /** The signed expiry again, in milliseconds, for the browser to draw the right controls. */
  until: z.number().int(),
});

type ReplayEnv = Pick<
  WebServerEnv,
  'WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS' | 'WEB_DISPUTE_REPLAY_MARGIN_SECONDS'
>;

/** Seconds from the page being drawn until the same request may no longer be sent. */
export function replayWindowSeconds(env: ReplayEnv = webServerEnv()): number {
  return env.WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS * 60 * 60 - env.WEB_DISPUTE_REPLAY_MARGIN_SECONDS;
}

/** The stamp for `submissionId` on `transactionId`, from `now`. */
export function mintReplayStamp(
  session: WebSession,
  transactionId: string,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): ReplayStamp {
  const window = replayWindowSeconds(env);
  // The same instant `signPayload` signs as its expiry. Advisory in the
  // browser; the action decides from the signed expiry itself.
  const until = (Math.floor(now / 1000) + window) * 1000;
  return {
    token: signPayload(
      session,
      PURPOSE,
      { transactionId, submissionId, issuedAt: now, until },
      window,
      now,
    ),
    until,
  };
}

/** A fresh submission id for a dispute form on `transactionId`, with its stamp. */
export function mintDisputeSubmission(
  session: WebSession,
  transactionId: string,
  now: number = Date.now(),
): DisputeSubmission {
  const id = mintSubmissionId(session);
  return { id, replay: mintReplayStamp(session, transactionId, id, now) };
}

/**
 * The stamp, only if this server issued it to this login, for this
 * transaction and this submission id, its signed expiry has not passed, **and**
 * it is still inside the window as configured now, counted from when it was
 * issued; otherwise null — one answer for every way it can be wrong. The
 * returned `until` is the earlier of the two deadlines.
 */
export function verifyReplayStamp(
  session: WebSession,
  token: unknown,
  transactionId: string,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): ReplayStamp | null {
  const payload = verifyPayload(session, PURPOSE, token, replaySchema, now);
  if (
    payload === null ||
    payload.transactionId !== transactionId ||
    payload.submissionId !== submissionId ||
    typeof token !== 'string'
  ) {
    return null;
  }
  const current = payload.issuedAt + replayWindowSeconds(env) * 1000;
  if (now > current) return null;
  return { token, until: Math.min(payload.until, current) };
}
