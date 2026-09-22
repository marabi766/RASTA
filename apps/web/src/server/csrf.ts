import { CSRF_FIELD } from '@/lib/form-fields';

import { csrfMatches, type WebSession } from './session';

/**
 * The CSRF check every state-changing request goes through (ADR-059 § 5).
 *
 * The session cookie is `SameSite=Strict`, and that alone stops most
 * cross-site submissions. "Most" is not a control for a write: an older
 * browser, a same-site subdomain that is not this application, a link
 * followed from an in-app browser that does not honour the attribute — each
 * is a way for a request to arrive with the cookie and without the person's
 * intent. So the session carries a token, every form echoes it, and a write
 * that does not echo the right one is refused **before** anything reaches the
 * gateway. `SameSite` is the belt; this is the braces.
 *
 * The comparison is the constant-time one from `session.ts`; this module only
 * names the ways it can fail so a handler can answer each honestly.
 */

export { CSRF_FIELD };

export type CsrfVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'MISSING' | 'MISMATCH' };

export function verifyCsrf(session: WebSession, form: FormData): CsrfVerdict {
  const received = form.get(CSRF_FIELD);
  if (typeof received !== 'string' || received.length === 0) {
    return { ok: false, reason: 'MISSING' };
  }
  // A token from another session — stale after a re-login, or forged — is
  // the same refusal as a wrong one. Naming them apart would tell a forger
  // which of its guesses came close.
  return csrfMatches(session.csrfToken, received)
    ? { ok: true }
    : { ok: false, reason: 'MISMATCH' };
}
