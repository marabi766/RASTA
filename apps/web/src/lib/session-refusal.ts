/**
 * Why a write found no session to act with, and how a form says so.
 *
 * Two different things, which every form in this portal keeps apart (PR 319
 * review 2, finding 3):
 *
 * - `NO_SESSION` — the session has ended: no cookie, one that does not open,
 *   one past its lifetime, or a refresh the identity provider refused for good.
 *   Signing in again is the only way on.
 * - `SESSION_UNAVAILABLE` — the access token ran out and its refresh is
 *   unavailable right now (`server/session-state.ts`): the login may still come
 *   back, so the person is told to try again shortly, not that they were
 *   signed out.
 *
 * The action decides which (`missingSessionReason` in
 * `server/current-session.ts`); nothing was sent in either case.
 */
export type SessionRefusal = 'NO_SESSION' | 'SESSION_UNAVAILABLE';

export const SESSION_REFUSAL_MESSAGES: Readonly<Record<SessionRefusal, string>> = {
  NO_SESSION: 'نشست شما پایان یافته است. دوباره وارد شوید و فرم را بفرستید.',
  SESSION_UNAVAILABLE:
    'نشست شما همین حالا در دسترس نیست و درخواست ارسال نشد. چند لحظه بعد دوباره بفرستید؛ اگر باز هم نشد، دوباره وارد شوید.',
};

export function isSessionRefusal(reason: string): reason is SessionRefusal {
  return reason === 'NO_SESSION' || reason === 'SESSION_UNAVAILABLE';
}

/**
 * How long `/auth/session` is given to answer (PR 405 review 5, R6). A fixed
 * deadline: past it the session is not known to have ended, whatever answers
 * later.
 */
export const SESSION_PROBE_DEADLINE_MS = 5_000;

/**
 * Whether the portal says, authoritatively, that this browser's session has
 * ended (`/auth/session` → `401`). Anything else — `204`, `503` (the refresh is
 * unavailable for now), another status, no answer, no answer within
 * `deadlineMs` — is not that.
 *
 * Asked after a send whose call itself failed: Next rejects a dropped response
 * and the request gate's `401` to an action POST the same way, so the failure
 * alone says nothing about the session (PR 319 review 1, finding 4).
 *
 * Bounded: the timer is cleared on every path, the request is aborted at the
 * deadline, and an answer that arrives after it — even from a `fetch` that
 * ignores the abort — is ignored. The answer's body is never read and is
 * cancelled on every path. It never rejects.
 */
export function sessionHasEnded(deadlineMs: number = SESSION_PROBE_DEADLINE_MS): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const controller = new AbortController();
    let settled = false;
    // Called only once `timer` is set: by the timer itself, or by the request below.
    const finish = (ended: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ended);
    };
    const timer = setTimeout(() => {
      finish(false);
      controller.abort();
    }, deadlineMs);
    try {
      Promise.resolve(
        fetch('/auth/session', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        }),
      ).then(
        (response) => {
          // Only the status is read. The body is given up here, on every path
          // — an answer after the deadline too — so a portal that stalls or
          // trickles it holds no connection once the timer is cleared (#507 r1 F1).
          void response.body?.cancel().catch(() => undefined);
          finish(response.status === 401);
        },
        () => finish(false),
      );
    } catch {
      finish(false);
    }
  });
}

/** A redirect from a server action reaches the client as a rejection whose digest says so. */
export function isRedirect(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}
