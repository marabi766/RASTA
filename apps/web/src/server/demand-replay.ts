import { z } from 'zod';

import { webServerEnv, type WebServerEnv } from './env';
import { ReleaseScope } from './release-scope';
import { signPayload, verifyPayload } from './signed-payload';
import type { WebSession } from './session';
import { mintSubmissionId } from './submission';
import { requestDigest, type UnresolvedScope } from './unresolved-request';

/**
 * Until when the demand form's request may be sent under its submission id,
 * signed by this server when the page drew the form — `project-create-replay.ts`'s
 * construction, for procurement-service.
 *
 * procurement-service answers a repeated `Idempotency-Key` from the same person
 * with the same body with its stored first response only while it keeps the key
 * (`PROCUREMENT_IDEMPOTENCY_TTL_HOURS`, counted from the stored answer, so never
 * earlier than from the moment the form was drawn). After that the same key and
 * body run as a **new** demand. The stamp's window is that retention, mirrored
 * (`WEB_PROCUREMENT_IDEMPOTENCY_TTL_HOURS`), less a margin
 * (`WEB_PROCUREMENT_REPLAY_MARGIN_SECONDS`, at least two clock skews and one
 * request: the service has no replay fence of its own), from when the form was
 * drawn, on the server's clock. At check time the earlier of the signed deadline
 * and the window **as configured now** applies: a setting may shorten it, never
 * extend it. Past it nothing is sent and the person is told to check the list.
 *
 * Bound to this login, the purpose and the submission id (`signed-payload.ts`);
 * readable, not secret.
 */

const PURPOSE = 'demand-submit-replay';

/** The signature's own expiry: far beyond any window, so "too late" is not "forged". */
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const replaySchema = z.object({
  submissionId: z.string().min(1).max(200),
  issuedAt: z.number().int().nonnegative(),
  deadline: z.number().int().nonnegative(),
});

type ReplayEnv = Pick<
  WebServerEnv,
  'WEB_PROCUREMENT_IDEMPOTENCY_TTL_HOURS' | 'WEB_PROCUREMENT_REPLAY_MARGIN_SECONDS'
>;

/** Seconds from the page being drawn until the same request may no longer be sent. */
export function demandReplayWindowSeconds(env: ReplayEnv = webServerEnv()): number {
  return (
    env.WEB_PROCUREMENT_IDEMPOTENCY_TTL_HOURS * 60 * 60 - env.WEB_PROCUREMENT_REPLAY_MARGIN_SECONDS
  );
}

/** The stamp for `submissionId`, from `now`. */
export function mintDemandStamp(
  session: WebSession,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): string {
  const deadline = now + demandReplayWindowSeconds(env) * 1000;
  return signPayload(
    session,
    PURPOSE,
    { submissionId, issuedAt: now, deadline },
    TOKEN_TTL_SECONDS,
    now,
  );
}

/** A fresh submission id for the demand form, with its stamp. */
export function mintDemandSubmission(
  session: WebSession,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): { readonly id: string; readonly replay: string } {
  const id = mintSubmissionId(session);
  return { id, replay: mintDemandStamp(session, id, now, env) };
}

export interface DemandStampTerms {
  readonly issuedAt: number;
  /** The signed deadline or the current window's, whichever is earlier. */
  readonly deadline: number;
  /** The current window in ms: bounds every later retry of a held request. */
  readonly windowMs: number;
  /** Whether `now` is past the deadline. */
  readonly expired: boolean;
}

/**
 * What a stamp this server issued to this login for `submissionId` says about
 * the request's time; null for every other token — forged, somebody else's, from
 * an earlier login, for another id, or missing.
 */
export function demandStampTerms(
  session: WebSession,
  token: unknown,
  submissionId: string,
  now: number = Date.now(),
  env: ReplayEnv = webServerEnv(),
): DemandStampTerms | null {
  const payload = verifyPayload(session, PURPOSE, token, replaySchema, now);
  if (payload === null || payload.submissionId !== submissionId) return null;
  const windowMs = demandReplayWindowSeconds(env) * 1000;
  const deadline = Math.min(payload.deadline, payload.issuedAt + windowMs);
  return { issuedAt: payload.issuedAt, deadline, windowMs, expired: now > deadline };
}

/** The purpose of every demand command's unresolved request (`unresolved-request-policy.ts`). */
export const DEMAND_UNRESOLVED_PURPOSE = 'procurement-demand';

/** Where the demand form's unresolved request is kept; the organization comes from the login. */
export const DEMAND_SUBMIT_UNRESOLVED: UnresolvedScope = {
  purpose: DEMAND_UNRESOLVED_PURPOSE,
  target: 'submit',
};

/** What the demand form's release acts on (`settleRelease`). */
export const DEMAND_SUBMIT_RELEASE = ReleaseScope.of(DEMAND_SUBMIT_UNRESOLVED);

/** The digest the unresolved request carries: of the body exactly as it is sent. */
export function demandBodyDigest(session: WebSession, body: unknown): string {
  return requestDigest(session, `${DEMAND_UNRESOLVED_PURPOSE}:submit`, body);
}
