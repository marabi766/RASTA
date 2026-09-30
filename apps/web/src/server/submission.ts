import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { SUBMISSION_FIELD } from '@/lib/form-fields';

import { webServerEnv } from './env';
import type { WebSession } from './session';

/**
 * A per-render reference for one form: minted when the form is rendered and
 * sent back with it, so a retry of the same form says the same thing twice.
 *
 * ## What it is, and what it is not
 *
 * It is a **reference**. The portal sends it in both shapes the platform
 * understands: as the `Idempotency-Key` header, which the gateway demands on
 * the prefixes with financial or irreversible effects (docs/06 § 6.8), and as
 * the body's `clientReference` where a service dedupes at the record level, as
 * `usage-records` does.
 *
 * Whether a repeat of it produces **one** record is entirely the receiving
 * service's decision, and services differ: a service that stores it makes a
 * retry one record — maintenance-service's create path does since issue 157, and
 * answers the same key and body with the original 201 while the key lives (24 hours by default,
 * MAINTENANCE_IDEMPOTENCY_TTL_HOURS); a service
 * that ignores it relies on its own rules and a retry can be refused or, for
 * some writes, applied twice. So nothing in the portal may say "a retry is not
 * a second record" of a write whose service is not known to store it;
 * `lib/unconfirmed-write.ts` is the honest state for a write whose outcome is
 * unknown.
 *
 * ## Two kinds of id
 *
 * `newSubmissionId` / `isSubmissionId` are the original pair: a random id, and
 * a check on its **shape only**. The shape check stops a client choosing an id
 * short enough to collide on purpose or long enough to exceed what a service
 * stores; it does not prove this server issued it.
 *
 * `mintSubmissionId` / `isBoundSubmissionId` are bound to the signed-in
 * session: the id carries a MAC, keyed from the server's session secret, over
 * the session's subject, its CSRF token and the id's own nonce. A well-formed
 * id this server never issued, another person's id, and an id minted under
 * an earlier login are all refused. The two kinds differ in length, so neither
 * verifier accepts the other's ids — an old-style id cannot be presented where
 * a bound one is required.
 */

/** Twenty base64url characters of entropy behind a prefix that says what it is. */
const PREFIX = 'sub_';
const ENTROPY_BYTES = 15;

export function newSubmissionId(): string {
  return `${PREFIX}${randomBytes(ENTROPY_BYTES).toString('base64url')}`;
}

/**
 * The shape the server accepts back for an unbound id.
 *
 * Fixed length and alphabet, so a client cannot choose an id that is short
 * enough to collide on purpose or long enough to exceed what a service stores
 * (`clientReference` is bounded at 8–128 characters).
 */
const SUBMISSION_ID = /^sub_[A-Za-z0-9_-]{20}$/;

/** Shape only. See the header: this does not prove the server issued the id. */
export function isSubmissionId(value: unknown): value is string {
  return typeof value === 'string' && SUBMISSION_ID.test(value);
}

// ---------------------------------------------------------------------------
// Bound to the session
// ---------------------------------------------------------------------------

/** 12 random bytes → 16 base64url characters. */
const NONCE_BYTES = 12;
const NONCE_CHARS = 16;

/** The MAC, cut to 16 bytes → 22 base64url characters. Enough to be unguessable. */
const MAC_BYTES = 16;
const MAC_CHARS = 22;

/** Forty-two characters in all, inside `clientReference`'s 8–128. */
const BOUND_SUBMISSION_ID = new RegExp(`^sub_[A-Za-z0-9_-]{${NONCE_CHARS + MAC_CHARS}}$`);

/** A purpose for the key, so this MAC cannot be confused with any other use of the secret. */
const KEY_PURPOSE = 'rasta-web/submission-id/v1';

function macFor(session: WebSession, nonce: string): Buffer {
  const key = createHmac('sha256', webServerEnv().WEB_SESSION_SECRET).update(KEY_PURPOSE).digest();
  return createHmac('sha256', key)
    .update(`${session.subject}\n${session.csrfToken}\n${nonce}`)
    .digest()
    .subarray(0, MAC_BYTES);
}

/**
 * A submission id for this person's form, issued by this server.
 *
 * `csrfToken` is per login, so an id does not survive a re-login — the same
 * lifetime the form's CSRF token has, which is the lifetime of the page that
 * carries both.
 */
export function mintSubmissionId(session: WebSession): string {
  const nonce = randomBytes(NONCE_BYTES).toString('base64url');
  return `${PREFIX}${nonce}${macFor(session, nonce).toString('base64url')}`;
}

/** True only for an id `mintSubmissionId` issued to **this** session. */
export function isBoundSubmissionId(value: unknown, session: WebSession): value is string {
  if (typeof value !== 'string' || !BOUND_SUBMISSION_ID.test(value)) return false;

  const body = value.slice(PREFIX.length);
  const nonce = body.slice(0, NONCE_CHARS);
  const macText = body.slice(NONCE_CHARS);
  const received = Buffer.from(macText, 'base64url');

  // The last base64url character of a 16-byte MAC carries four spare bits, so
  // several strings decode to the same bytes. Only the canonical one is an id
  // this server issued; the others would be distinct references that all
  // verify, which is exactly the looseness binding exists to remove.
  if (received.toString('base64url') !== macText) return false;

  const expected = macFor(session, nonce);

  // Constant-time, and only between equal lengths: `timingSafeEqual` throws on
  // unequal ones, and the regex above has already fixed the length.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export { SUBMISSION_FIELD };
