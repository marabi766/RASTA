import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { SUBMISSION_FIELD } from '@/lib/form-fields';

import { webServerEnv } from './env';
import { tokenPerson } from './realm-roles';
import type { WebSession } from './session';
import { actingOrganizationId, sessionOrganization } from './session-organization';

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
 * retry one record — maintenance-service's create path does since issue 157,
 * and so do its six repair-order writes (start, complete, withdraw, and a part,
 * labour or other cost), answering the same key and body with the original 201 while the key lives
 * (MAINTENANCE_IDEMPOTENCY_TTL_HOURS, 24 by default), or, while the first is
 * still being processed, with 409 CONFLICT and Retry-After (`IN_PROGRESS` in
 * `write.ts`); asset-service's create path does the same since #193
 * (`ASSET_IDEMPOTENCY_TTL_HOURS`, 24 by default) and requires the header.
 * A service that ignores it relies on its own rules — asset-service's other
 * writes (edit, activate, change status, decommission) store no key and are
 * guarded by the version the page was drawn at instead (`expectedVersion`, a
 * second send is a 409, not a replayed answer) — and a retry can be refused or,
 * for some writes, applied twice. So nothing in the portal may say "a retry is
 * not a second record" of a write whose service is not known to store it;
 * `lib/unconfirmed-write.ts` is the honest state for a write whose outcome is
 * unknown.
 *
 * ## Bound to the session
 *
 * The id carries a MAC, keyed from the server's session secret, over the
 * session's subject, its CSRF token, **the organization the access token acts
 * for** and the id's own nonce. A well-formed id this server never issued,
 * another person's id, an id minted under an earlier login, and an id minted
 * while the token acted for another organization are all refused before
 * anything reaches the gateway.
 *
 * The organization is the one the access token acts for, read through
 * `session-organization.ts` like every other consumer: after the person
 * switches their active organization elsewhere the next refresh sends every
 * write for the new one (task 095). A form drawn for the old organization — a
 * member picked from its list, a record of its own — is then refused as stale
 * (`REFUSED`, `SUBMISSION`: refresh the page), never sent for the new one. A
 * refresh that keeps the organization keeps every form valid. A session whose
 * organization cannot be told mints no id and verifies none (task 100).
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
const KEY_PURPOSE = 'rasta-web/submission-id/v2';

function macFor(session: WebSession, nonce: string): Buffer | null {
  const organizationId = sessionOrganization(session);
  if (organizationId === undefined) return null;
  const key = createHmac('sha256', webServerEnv().WEB_SESSION_SECRET).update(KEY_PURPOSE).digest();
  const organization = organizationId ?? '';
  return createHmac('sha256', key)
    .update(`${session.subject}\n${session.csrfToken}\n${organization}\n${nonce}`)
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
  const mac = macFor(session, nonce);
  // `readSession()` refuses such a session; a caller that got one anyway draws no form.
  if (mac === null)
    throw new Error('No submission id for a session whose organization is unknown.');
  return `${PREFIX}${nonce}${mac.toString('base64url')}`;
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
  if (expected === null) return false;

  // Constant-time, and only between equal lengths: `timingSafeEqual` throws on
  // unequal ones, and the regex above has already fixed the length.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// ---------------------------------------------------------------------------
// What the browser may remember about whose submission it was
// ---------------------------------------------------------------------------

/** 12 bytes → 16 base64url characters: enough to tell two logins apart, not to be a credential. */
const BINDING_BYTES = 12;

const BINDING_PURPOSE = 'rasta-web/unresolved-submission-binding/v1';

/**
 * The one-way tags the page hands to a form that keeps an unresolved submission
 * in `sessionStorage` (`lib/unresolved-tenancy.ts`), so the browser can tell
 * *whose* entry it is without the entry holding anything of the session.
 *
 * - `person`: this person, whichever organization they act for. An entry of
 *   another person is removed on this person's first page (an account boundary).
 * - `owner`: this person acting for **this** organization — the one the access
 *   token acts for (`actingOrganizationId`). Entries are kept, and keyed, per
 *   owner: an entry of the same person for another organization stays in
 *   storage untouched, but is neither shown nor resolved here, so after a
 *   switch from A to B nothing of A's appears on B's pages, and back on A it is
 *   all still there (PR 405 review 1, F1).
 * - `session`: this login, for this organization. The submission id is bound
 *   to the login's CSRF token and the organization (`mintSubmissionId`), so
 *   after a re-login the stored id is refused and the entry can only be shown,
 *   never re-sent.
 * - `legacy`: the `owner` tags an entry written before entries were keyed per
 *   organization may carry for this person — one per organization the token
 *   lists them as a member of, and none. Such an entry cannot say which
 *   organization it was sent for (the tag was the login's organization, not
 *   necessarily the token's), so it is never retagged and never guessed: it is
 *   kept for this person and shown view-only, never re-sent.
 *
 * Keyed MACs of the session's own values: no tag reveals, nor can be used to
 * derive, the subject, an organization, the CSRF token or any token.
 */
export interface SubmissionBinding {
  readonly person: string;
  readonly owner: string;
  readonly session: string;
  readonly legacy: readonly string[];
}

export function submissionBinding(session: WebSession): SubmissionBinding {
  const key = createHmac('sha256', webServerEnv().WEB_SESSION_SECRET)
    .update(BINDING_PURPOSE)
    .digest();
  const tag = (text: string): string =>
    createHmac('sha256', key)
      .update(text)
      .digest()
      .subarray(0, BINDING_BYTES)
      .toString('base64url');
  const ownerOf = (organizationId: string | null) =>
    tag(`owner\n${session.subject}\n${organizationId ?? ''}`);
  const organizationId = actingOrganizationId(session);
  const owner = `${session.subject}\n${organizationId ?? ''}`;
  const memberships = tokenPerson(session.accessToken)?.memberships ?? [];
  const legacy = [...new Set([null, organizationId, ...memberships].map(ownerOf))].sort();
  return {
    person: tag(`person\n${session.subject}`),
    owner: ownerOf(organizationId),
    session: tag(`session\n${owner}\n${session.csrfToken}`),
    legacy,
  };
}

export { SUBMISSION_FIELD };
