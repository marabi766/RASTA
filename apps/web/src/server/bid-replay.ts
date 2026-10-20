import { z } from 'zod';

import { BID_COMMANDS } from '@/lib/bid-fields';
import type { BidSubmission, ReplayStamp } from '@/lib/unresolved-bid';

import type { BidBinding } from './tender-bids';
import { webServerEnv, type WebServerEnv } from './env';
import { signPayload, verifyPayload } from './signed-payload';
import type { WebSession } from './session';
import { mintSubmissionId } from './submission';

/**
 * Until when a bid command may be sent again under its original key, and
 * **what** it acts on — signed by this server when the page drew the form
 * (`server/statement-replay.ts` is the model; same construction, same reasons).
 *
 * ## Until when
 *
 * construction-service answers a submission's key with the stored receipt only
 * while its idempotency record lives (`CONSTRUCTION_IDEMPOTENCY_TTL_HOURS`);
 * the stamp's expiry is that retention, mirrored
 * (`WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS`), less a margin
 * (`WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS`), counted from when the form was
 * drawn, and accepted only while issuance plus the window **as configured now**
 * also holds.
 *
 * ## What
 *
 * The tender, the command, and for a replacement or a withdrawal the bid and
 * the revision the page showed: the action takes `expectedRevision` from the
 * verified stamp, never from the posted form, so a form drawn before the bid
 * moved is refused by the service (`409 OPTIMISTIC_LOCK_FAILED`) instead of
 * replacing or withdrawing a bid its author never saw. The content is typed,
 * so it is the form's; the stamp binds none of it and holds none of it.
 *
 * Bound to this login (`signed-payload.ts`); readable, not secret.
 */

const PURPOSE = 'bid-replay';

const replaySchema = z.object({
  tenderId: z.string().min(1).max(200),
  /** Null for a submission: there is no bid yet. */
  bidId: z.string().min(1).max(200).nullable(),
  submissionId: z.string().min(1).max(200),
  command: z.enum(BID_COMMANDS),
  /** When the page signed it, milliseconds since the epoch, server clock. */
  issuedAt: z.number().int().nonnegative(),
  /** The signed expiry again, in milliseconds, for the browser to draw the right controls. */
  until: z.number().int(),
  /** The bid's `revision` the page showed; null for a submission. */
  expectedRevision: z.number().int().min(1).nullable(),
});

type ReplayPayload = z.infer<typeof replaySchema>;

type ReplayEnv = Pick<
  WebServerEnv,
  'WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS' | 'WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS'
>;

/** What a stamp is for: one command on one tender's bid. */
export interface BidTarget extends BidBinding {
  readonly tenderId: string;
}

/** Seconds from the page being drawn until the same request may no longer be sent. */
export function bidReplayWindowSeconds(env: ReplayEnv = webServerEnv()): number {
  return (
    env.WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS * 60 * 60 -
    env.WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS
  );
}

function bindingOf(target: BidTarget): Omit<ReplayPayload, 'submissionId' | 'issuedAt' | 'until'> {
  return {
    tenderId: target.tenderId,
    bidId: target.bidId,
    command: target.command,
    expectedRevision: target.expectedRevision,
  };
}

/** The stamp for `submissionId` on `target`, from `now`. */
export function mintBidStamp(
  session: WebSession,
  target: BidTarget,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): ReplayStamp {
  const window = bidReplayWindowSeconds(env);
  const until = (Math.floor(now / 1000) + window) * 1000;
  return {
    token: signPayload(
      session,
      PURPOSE,
      { ...bindingOf(target), submissionId, issuedAt: now, until },
      window,
      now,
    ),
    until,
  };
}

/** A fresh submission id for one bid form on `target`, with its stamp. */
export function mintBidSubmission(
  session: WebSession,
  target: BidTarget,
  now: number = Date.now(),
): BidSubmission {
  const id = mintSubmissionId(session);
  return { id, replay: mintBidStamp(session, target, id, now) };
}

/** A stamp the action verified, with what it binds the request to. */
export interface VerifiedBidStamp extends ReplayStamp, BidBinding {}

/**
 * The stamp, only if this server issued it to this login, for this tender and
 * this submission id, it binds a bid exactly when its command acts on one, its
 * signed expiry has not passed and it is still inside the window as configured
 * now; otherwise null — one answer for every way it can be wrong.
 */
export function verifyBidStamp(
  session: WebSession,
  token: unknown,
  tenderId: string,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): VerifiedBidStamp | null {
  const payload = verifyPayload(session, PURPOSE, token, replaySchema, now);
  if (
    payload === null ||
    typeof token !== 'string' ||
    payload.tenderId !== tenderId ||
    payload.submissionId !== submissionId ||
    (payload.command === 'SUBMIT') !== (payload.bidId === null) ||
    (payload.bidId === null) !== (payload.expectedRevision === null)
  ) {
    return null;
  }
  const current = payload.issuedAt + bidReplayWindowSeconds(env) * 1000;
  if (now > current) return null;
  return {
    token,
    until: Math.min(payload.until, current),
    command: payload.command,
    bidId: payload.bidId,
    expectedRevision: payload.expectedRevision,
  };
}
