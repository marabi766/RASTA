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
 * retry one record; a service that ignores it — maintenance-service's and
 * asset-service's create paths today — relies on its own rules (a unique index
 * on the open request, on the serial number) and a retry can be refused or, for
 * some writes, applied twice. So nothing in the portal may say "a retry is not
 * a second record" of a write whose service is not known to store it;
 * `lib/unconfirmed-write.ts` is the honest state for a write whose outcome is
 * unknown.
 *
 * ## Bound to the session
 *
 * The id carries a MAC, keyed from the server's session secret, over the
 * session's subject, its CSRF token and the id's own nonce. A well-formed id
 * this server never issued, another person's id, and an id minted under an
 * earlier login are all refused before anything reaches the gateway.
 *
 * Every form uses this pair. There used to be a second, shape-only pair (a
 * random id and a regular-expression check) that proved an id was the right
 * length and alphabet and nothing about who issued it; once the last form moved
 * off it, it was removed rather than left as the easy thing to copy.
 */

/** What every id starts with, so a log line says what it is. */
const PREFIX = 'sub_';

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
