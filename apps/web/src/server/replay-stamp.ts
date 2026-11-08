import { z } from 'zod';

import type { WebServerEnv } from './env';
import { webServerEnv } from './env';
import { signPayload, verifyPayload } from './signed-payload';
import type { WebSession } from './session';
import { mintSubmissionId } from './submission';

/**
 * The signed stamp a keyed create form carries, and the one place its rules live:
 * until when the form's request may still be sent under its submission id. Each
 * keyed create of construction-service (`project-create-replay.ts`,
 * `project-need-replay.ts`) is this factory with its own purpose, so the window,
 * the "earlier of signed and configured" rule and the `EXPIRED` / `null` split
 * cannot drift between them.
 *
 * construction-service answers a keyed create's key with the stored first
 * response only while its idempotency record lives
 * (`CONSTRUCTION_IDEMPOTENCY_TTL_HOURS`). After that the same key and body run as
 * a **new** create, so a form left open past it and pressed again could make a
 * second record of a request that did commit. The window is that retention,
 * mirrored (`WEB_CONSTRUCTION_IDEMPOTENCY_TTL_HOURS`) less a margin
 * (`WEB_CONSTRUCTION_REPLAY_MARGIN_SECONDS`), counted from when the form was
 * drawn, on the server's clock. The deadline is signed into the stamp at issue
 * time; at check time the earlier of that and the window **as configured now**
 * applies — a setting may shorten it, never extend it.
 *
 * Past the window the action sends nothing and says the list must be checked
 * first (`EXPIRED`), never a create. The token itself outlives the window by far,
 * so an expired form is told apart from a forged one (`null`).
 *
 * Bound to this login (`signed-payload.ts`) and, when the create is *about*
 * something (a need is created under one project), to that target: a stamp drawn
 * for one project does not open for another. Readable, not secret.
 *
 * A create *under* a versioned parent also signs the parent's version as the page
 * read it (`version`): a need is added to the project's editing episode the form
 * was drawn in, and construction-service compares it under the project's row lock
 * (`expectedProjectVersion`). The caller takes it from the stamp, never from a
 * field of the form; a stamp minted without one has `version: null`.
 */

/** The signature's own expiry: far beyond any window, so "too late" is not "forged". */
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const stampSchema = z.object({
  submissionId: z.string().min(1).max(200),
  /** What the create is about (a project id); `''` for a create about nothing. */
  target: z.string().max(200).prefault(''),
  /** When the page signed it, milliseconds since the epoch, server clock. */
  issuedAt: z.number().int().nonnegative(),
  /**
   * The last instant the request may be sent, fixed when the page was drawn:
   * issue time plus the window **as configured then**. The service's own record
   * of the key expires on a clock that was fixed at claim time, so a setting
   * raised later cannot lengthen it.
   */
  deadline: z.number().int().nonnegative(),
  /** The parent's version when the page drew the form; null for a create about no versioned parent. */
  version: z.number().int().min(1).max(2_147_483_647).nullable().prefault(null),
});

export type ReplayEnv = Pick<
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

export interface StampTerms {
  readonly issuedAt: number;
  readonly deadline: number;
  readonly windowMs: number;
  /** The parent version signed at issue (`null` when none was). */
  readonly version: number | null;
}

export interface ReplayStamps {
  /** The stamp for `submissionId` (about `target`, at the parent's `version`), from `now`. */
  readonly mint: (
    session: WebSession,
    submissionId: string,
    target?: string,
    now?: number,
    env?: ReplayEnv,
    version?: number | null,
  ) => string;
  /** A fresh submission id with its stamp. */
  readonly mintSubmission: (
    session: WebSession,
    target?: string,
    now?: number,
    env?: ReplayEnv,
    version?: number | null,
  ) => { readonly id: string; readonly replay: string };
  /**
   * What a stamp this login holds says about the request's time: when it was issued, its effective
   * deadline (the signed one or the current configuration's, whichever is earlier) and the current
   * window in ms. Null for a stamp that is not ours, not for this submission id or not for this target.
   */
  readonly terms: (
    session: WebSession,
    token: unknown,
    submissionId: string,
    target?: string,
    now?: number,
    env?: ReplayEnv,
  ) => StampTerms | null;
  /**
   * `OK` while the request may still be sent, `EXPIRED` once it may not, and `null` for a stamp this
   * server did not issue to this login for this submission id and target — forged, somebody else's,
   * from an earlier login, for another id or project, or missing.
   */
  readonly check: (
    session: WebSession,
    token: unknown,
    submissionId: string,
    target?: string,
    now?: number,
    env?: ReplayEnv,
  ) => 'OK' | 'EXPIRED' | null;
}

export function replayStamps(purpose: string): ReplayStamps {
  const terms: ReplayStamps['terms'] = (
    session,
    token,
    submissionId,
    target = '',
    now = Date.now(),
    env = webServerEnv(),
  ) => {
    const payload = verifyPayload(session, purpose, token, stampSchema, now);
    if (payload === null || payload.submissionId !== submissionId || payload.target !== target) {
      return null;
    }
    const windowMs = createReplayWindowSeconds(env) * 1000;
    return {
      issuedAt: payload.issuedAt,
      deadline: Math.min(payload.deadline, payload.issuedAt + windowMs),
      windowMs,
      version: payload.version,
    };
  };

  const mint: ReplayStamps['mint'] = (
    session,
    submissionId,
    target = '',
    now = Date.now(),
    env = webServerEnv(),
    version = null,
  ) => {
    const deadline = now + createReplayWindowSeconds(env) * 1000;
    return signPayload(
      session,
      purpose,
      // No `version` key at all without one: a create stamp stays the bytes it was.
      { submissionId, target, issuedAt: now, deadline, ...(version === null ? {} : { version }) },
      TOKEN_TTL_SECONDS,
      now,
    );
  };

  return {
    mint,
    mintSubmission: (
      session,
      target = '',
      now = Date.now(),
      env = webServerEnv(),
      version = null,
    ) => {
      const id = mintSubmissionId(session);
      return { id, replay: mint(session, id, target, now, env, version) };
    },
    terms,
    check: (session, token, submissionId, target = '', now = Date.now(), env = webServerEnv()) => {
      const held = terms(session, token, submissionId, target, now, env);
      if (held === null) return null;
      return now > held.deadline ? 'EXPIRED' : 'OK';
    },
  };
}
