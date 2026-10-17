import { z } from 'zod';

import type { DisputeTarget } from '@/lib/transaction-dispute-fields';
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
 * ## Which dispute a resolution decides
 *
 * A resolution's stamp also signs **the dispute the page showed**
 * (`DisputeTarget`, docs/23 D-053), and the action sends that identity — from
 * the verified stamp, never from the form and never read again — so the first
 * send and every retry under the key name the same dispute. economic-service
 * applies it only while the transaction still holds that dispute (PR 325
 * review 1, finding 1). A stamp that names none (opening a dispute, or a stamp
 * signed before this field existed) cannot carry a resolution.
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
  /** The dispute a resolution decides; absent or null when it decides none. */
  disputeId: z.string().min(1).max(64).nullable().optional(),
});

/** A transaction id alone is a target that decides no dispute. */
const targetOf = (target: DisputeTarget | string): DisputeTarget =>
  typeof target === 'string' ? { transactionId: target, disputeId: null } : target;

type ReplayEnv = Pick<
  WebServerEnv,
  'WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS' | 'WEB_DISPUTE_REPLAY_MARGIN_SECONDS'
>;

/** Seconds from the page being drawn until the same request may no longer be sent. */
export function replayWindowSeconds(env: ReplayEnv = webServerEnv()): number {
  return env.WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS * 60 * 60 - env.WEB_DISPUTE_REPLAY_MARGIN_SECONDS;
}

/** The stamp for `submissionId` on the target (a transaction, and the dispute a resolution decides), from `now`. */
export function mintReplayStamp(
  session: WebSession,
  target: DisputeTarget | string,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): ReplayStamp {
  const { transactionId, disputeId } = targetOf(target);
  const window = replayWindowSeconds(env);
  // The same instant `signPayload` signs as its expiry. Advisory in the
  // browser; the action decides from the signed expiry itself.
  const until = (Math.floor(now / 1000) + window) * 1000;
  return {
    token: signPayload(
      session,
      PURPOSE,
      { transactionId, submissionId, issuedAt: now, until, disputeId },
      window,
      now,
    ),
    until,
  };
}

/** A fresh submission id for a dispute form on the target, with its stamp. */
export function mintDisputeSubmission(
  session: WebSession,
  target: DisputeTarget | string,
  now: number = Date.now(),
): DisputeSubmission {
  const id = mintSubmissionId(session);
  return { id, replay: mintReplayStamp(session, target, id, now) };
}

/** A stamp the action verified, with the dispute it binds the request to. */
export interface VerifiedReplayStamp extends ReplayStamp {
  readonly disputeId: string | null;
}

/**
 * The stamp, only if this server issued it to this login, for this
 * transaction and this submission id, its signed expiry has not passed, **and**
 * it is still inside the window as configured now, counted from when it was
 * issued; otherwise null — one answer for every way it can be wrong. The
 * returned `until` is the earlier of the two deadlines; `disputeId` is the
 * dispute it was signed for, or null.
 */
export function verifyReplayStamp(
  session: WebSession,
  token: unknown,
  transactionId: string,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): VerifiedReplayStamp | null {
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
  return { token, until: Math.min(payload.until, current), disputeId: payload.disputeId ?? null };
}
