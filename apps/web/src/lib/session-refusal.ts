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
 * Whether the portal says, authoritatively, that this browser's session has
 * ended (`/auth/session` → `401`). Anything else — `204`, `503` (the refresh is
 * unavailable for now), another status, no answer — is not that.
 *
 * Asked after a send whose call itself failed: Next rejects a dropped response
 * and the request gate's `401` to an action POST the same way, so the failure
 * alone says nothing about the session (PR 319 review 1, finding 4).
 */
export async function sessionHasEnded(): Promise<boolean> {
  try {
    const response = await fetch('/auth/session', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return response.status === 401;
  } catch {
    return false;
  }
}

/** A redirect from a server action reaches the client as a rejection whose digest says so. */
export function isRedirect(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}
