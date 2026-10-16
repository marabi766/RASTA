/**
 * Why a request has no usable session — the one thing middleware knows that a
 * route or an action cannot see for itself (PR 319 review 2, finding 3).
 *
 * Middleware hides a session from the render in two different situations
 * (`middleware.ts`, `session-refresh.ts`):
 *
 *   - **ended** — the cookie does not open, is past its lifetime, or the
 *     provider refused its refresh token for good. Signing in again is the
 *     only way on.
 *   - **refresh unavailable** — the access token has run out and its refresh
 *     was refused or went unanswered for a reason that may pass (no answer, a
 *     5xx, a race with another replica). The login itself may well still be
 *     good; the next request may find it renewed.
 *
 * Both reach a route as "no session". Middleware says which by a request
 * header it sets itself — and removes from whatever the browser sent, so a
 * request cannot claim it — and only the second is ever marked. A route or
 * action that reads it can then say "unavailable, try again" instead of "your
 * session has ended" where the latter would not be true.
 */

export const SESSION_STATE_HEADER = 'x-rasta-session-state';
export const REFRESH_UNAVAILABLE = 'refresh-unavailable';

/** True when middleware marked this request's missing session as possibly temporary. */
export function isRefreshUnavailable(headers: Pick<Headers, 'get'>): boolean {
  return headers.get(SESSION_STATE_HEADER) === REFRESH_UNAVAILABLE;
}
