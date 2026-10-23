import { createHash, createHmac } from 'node:crypto';

import { cookies } from 'next/headers';
import { z } from 'zod';

import { webServerEnv } from './env';
import type { WebSession } from './session';
import { sessionCookieOptions } from './session';
import { signPayload, verifyPayload } from './signed-payload';

/**
 * Keeps one **unresolved write request** across navigation: the key it was sent
 * under, a digest of what it carried, and until when that key may be sent again.
 *
 * ## Why
 *
 * A write whose answer was lost may have committed. The form that sent it is
 * gone after a reload, and a page drawn afterwards mints a fresh key — so the
 * same inputs pressed again would be a second record. A filtered list cannot
 * settle that either (the new record may simply not match the filter). So the
 * request is remembered until a confirmed outcome, or until the person says,
 * knowingly, that they checked the full list and want a new one.
 *
 * ## Where
 *
 * A signed `httpOnly` cookie, written by the server action and read by the
 * server page, so the notice renders without any script. It is the same
 * construction as every other token of the portal (`signed-payload.ts`): bound
 * to this login's subject and CSRF token — another person, or the same person
 * after a new login, reads nothing — and, here, to the organization the login
 * acted for. Logout removes every such cookie (`app/auth/logout/route.ts`).
 *
 * It holds **no body**, only a keyed digest of it: a body can be longer than a
 * cookie, and what it says is not this module's business. A caller that wants
 * "the same request" asks the person to send the same values, and refuses a
 * different digest under the remembered key.
 *
 * ## What it is keyed by
 *
 * `purpose` (what kind of request, a slug) and an optional `target` (the object
 * it is about, when one request per object may be unresolved). Nothing here
 * knows about projects.
 */

export const UNRESOLVED_COOKIE_PREFIX = 'rasta_ur_';

const SIGNING_PURPOSE = 'unresolved-request';
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const PURPOSE_SLUG = /^[a-z0-9-]{1,40}$/;

export interface UnresolvedScope {
  readonly purpose: string;
  readonly target?: string;
}

export interface UnresolvedRequest {
  /** The idempotency key the request was sent under. */
  readonly key: string;
  /** `requestDigest` of the body it carried. */
  readonly digest: string;
  /** Last instant the key may be sent again (ms since the epoch); null when the service has no limit. */
  readonly deadline: number | null;
  /** Opaque, short: whatever the caller must hand back to its form (a signed stamp). */
  readonly ref: string | null;
}

const recordSchema = z.object({
  scope: z.string().min(1).max(300),
  organizationId: z.string().max(200),
  key: z.string().min(1).max(200),
  digest: z.string().min(1).max(100),
  deadline: z.number().int().nonnegative().nullable(),
  ref: z.string().max(800).nullable(),
});

function scopeLabel(scope: UnresolvedScope): string {
  if (!PURPOSE_SLUG.test(scope.purpose)) throw new Error('unresolved-request: bad purpose');
  return `${scope.purpose}\n${scope.target ?? ''}`;
}

/** The cookie's name for a scope: fixed characters, whatever the target holds. */
export function unresolvedCookieName(scope: UnresolvedScope): string {
  const hash = createHash('sha256').update(scopeLabel(scope)).digest('hex').slice(0, 24);
  return `${UNRESOLVED_COOKIE_PREFIX}${hash}`;
}

/**
 * A keyed digest of `body` for this person and purpose: equal bodies give equal
 * digests (keys sorted, so property order does not matter), and the digest of a
 * guessable body cannot be checked by anybody without the server's secret.
 * The caller canonicalizes values first (decimals, line endings, instants).
 */
export function requestDigest(session: WebSession, purpose: string, body: unknown): string {
  const key = createHmac('sha256', webServerEnv().WEB_SESSION_SECRET)
    .update(`rasta-web/request-digest/v1:${purpose}`)
    .digest();
  return createHmac('sha256', key)
    .update(`${session.subject}\n${canonicalJson(body)}`)
    .digest('base64url');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Remembers `request` for `scope`. Only a server action or route handler may call it. */
export async function rememberUnresolved(
  session: WebSession,
  scope: UnresolvedScope,
  request: UnresolvedRequest,
  now: number = Date.now(),
): Promise<void> {
  const token = signPayload(
    session,
    SIGNING_PURPOSE,
    {
      scope: scopeLabel(scope),
      organizationId: session.organizationId ?? '',
      key: request.key,
      digest: request.digest,
      deadline: request.deadline,
      ref: request.ref,
    },
    TOKEN_TTL_SECONDS,
    now,
  );
  (await cookies()).set(
    unresolvedCookieName(scope),
    token,
    sessionCookieOptions({
      secure: webServerEnv().WEB_COOKIE_SECURE,
      maxAgeSeconds: TOKEN_TTL_SECONDS,
    }),
  );
}

/**
 * The request still unresolved for `scope` by this person, acting for this
 * organization, in this login — or null. It is returned **past its deadline**
 * too: an expired key is still an unresolved request, the person must reconcile
 * it; `deadline` says whether it may be sent again.
 */
export async function readUnresolved(
  session: WebSession,
  scope: UnresolvedScope,
  now: number = Date.now(),
): Promise<UnresolvedRequest | null> {
  const token = (await cookies()).get(unresolvedCookieName(scope))?.value;
  const payload = verifyPayload(session, SIGNING_PURPOSE, token, recordSchema, now);
  if (payload === null) return null;
  if (payload.scope !== scopeLabel(scope)) return null;
  if (payload.organizationId !== (session.organizationId ?? '')) return null;
  return {
    key: payload.key,
    digest: payload.digest,
    deadline: payload.deadline,
    ref: payload.ref,
  };
}

/** Forgets the request for `scope`: a confirmed outcome, or the person's informed release. */
export async function clearUnresolved(scope: UnresolvedScope): Promise<void> {
  (await cookies()).delete(unresolvedCookieName(scope));
}

/** True while `request` may still be sent: no deadline, or not yet reached. */
export function mayResend(request: UnresolvedRequest, now: number = Date.now()): boolean {
  return request.deadline === null || now <= request.deadline;
}
