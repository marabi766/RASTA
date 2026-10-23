import { z } from 'zod';

import type { WebServerEnv } from './env';
import { webServerEnv } from './env';
import { signPayload, verifyPayload } from './signed-payload';
import type { WebSession } from './session';
import { mintSubmissionId } from './submission';
import { requestDigest } from './unresolved-request';

/**
 * Until when the create form's request may be sent under its submission id,
 * signed by this server when the page drew the form (`server/bid-replay.ts` is
 * the model: same construction, same retention setting, same margin).
 *
 * construction-service answers a project create's key with the stored first
 * response only while its idempotency record lives
 * (`CONSTRUCTION_IDEMPOTENCY_TTL_HOURS`). After that the same key and body run
 * as a **new** create, so a form left open past it and pressed again could make a
 * second project of a request that did commit. The stamp's window is that
 * retention, mirrored (`WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS`) less a margin
 * (`WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS`), counted from when the form was
 * drawn, on the server's clock. The deadline is signed into the stamp at issue
 * time; at check time the earlier of that and the window **as configured now**
 * applies — a setting may shorten it, never extend it.
 *
 * Past the window the action sends nothing and says the project list must be
 * checked first (`EXPIRED`), never a create. The token itself outlives the window
 * by far, so an expired form is told apart from a forged one (`null`).
 *
 * Bound to this login (`signed-payload.ts`); readable, not secret.
 */

const PURPOSE = 'project-create-replay';

/** The signature's own expiry: far beyond any window, so "too late" is not "forged". */
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const replaySchema = z.object({
  submissionId: z.string().min(1).max(200),
  /** When the page signed it, milliseconds since the epoch, server clock. */
  issuedAt: z.number().int().nonnegative(),
  /**
   * The last instant the request may be sent, fixed when the page was drawn:
   * issue time plus the window **as configured then**. The service's own record
   * of the key expires on a clock that was fixed at claim time, so a setting
   * raised later cannot lengthen it.
   */
  deadline: z.number().int().nonnegative(),
});

type ReplayEnv = Pick<
  WebServerEnv,
  'WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS' | 'WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS'
>;

/** Seconds from the page being drawn until the same request may no longer be sent. */
export function createReplayWindowSeconds(env: ReplayEnv = webServerEnv()): number {
  return (
    env.WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS * 60 * 60 -
    env.WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS
  );
}

/** The stamp for `submissionId`, from `now`. */
export function mintCreateStamp(
  session: WebSession,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): string {
  const deadline = now + createReplayWindowSeconds(env) * 1000;
  return signPayload(
    session,
    PURPOSE,
    { submissionId, issuedAt: now, deadline },
    TOKEN_TTL_SECONDS,
    now,
  );
}

/** The signed deadline of a stamp this login holds, or null: for display next to an unresolved request. */
export function createStampDeadline(
  session: WebSession,
  token: unknown,
  submissionId: string,
  now: number = Date.now(),
): number | null {
  const payload = verifyPayload(session, PURPOSE, token, replaySchema, now);
  return payload === null || payload.submissionId !== submissionId ? null : payload.deadline;
}

/** A fresh submission id for the create form, with its stamp. */
export function mintCreateSubmission(
  session: WebSession,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): { readonly id: string; readonly replay: string } {
  const id = mintSubmissionId(session);
  return { id, replay: mintCreateStamp(session, id, now, env) };
}

/**
 * `OK` while the request may still be sent, `EXPIRED` once it may not, and `null`
 * for a stamp this server did not issue to this login for this submission id —
 * forged, somebody else's, from an earlier login, for another id, or missing.
 */
export function checkCreateStamp(
  session: WebSession,
  token: unknown,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): 'OK' | 'EXPIRED' | null {
  const payload = verifyPayload(session, PURPOSE, token, replaySchema, now);
  if (payload === null || payload.submissionId !== submissionId) return null;
  const deadline = Math.min(
    payload.deadline,
    payload.issuedAt + createReplayWindowSeconds(env) * 1000,
  );
  return now > deadline ? 'EXPIRED' : 'OK';
}

/** Where the create form's unresolved request is kept (`server/unresolved-request.ts`); the organization comes from the login. */
export const PROJECT_CREATE_UNRESOLVED = { purpose: 'project-create' } as const;

/** The digest the unresolved request carries: of the body as it is sent. */
export function createBodyDigest(session: WebSession, body: unknown): string {
  return requestDigest(session, PROJECT_CREATE_UNRESOLVED.purpose, body);
}
