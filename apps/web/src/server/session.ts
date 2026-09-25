import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * The session cookie: what it holds, and how it is sealed (ADR-059 § 4).
 *
 * **Encrypted, not merely signed.** A signed cookie is readable by anybody who
 * can read the cookie jar — a shared machine, a backup, a browser extension —
 * and what it would hand them is a working refresh token. Signing proves
 * nobody edited it; it does not stop anybody reading it, and here reading it is
 * the whole attack.
 *
 * `AES-256-GCM` because it authenticates as well as encrypts: a tampered
 * ciphertext fails to open rather than opening into something the caller then
 * has to validate. The nonce is fresh per seal, which is not optional for GCM
 * — reusing one with the same key breaks the cipher outright.
 *
 * The authentication tag length is stated to both halves rather than left to
 * the default. Node will otherwise verify against whatever length the tag it
 * is handed happens to be, and a short tag is a weak tag: sixteen bytes is a
 * one-in-2^128 forgery, four bytes is one in 2^32. The slice below already
 * takes exactly sixteen, so this is belt and braces — and it is the pair of
 * them, because a rule that only the reader enforces is a rule that stops
 * being enforced the day somebody refactors the reader.
 *
 * ## What is not in here
 *
 * No roles. They are inside the access token, the gateway and each service
 * read them there, and a second copy in a cookie is a copy that can disagree
 * with the first. No domain data: this cookie travels on every request.
 */

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** What a sealed session carries. Every field is needed by the server. */
export const sessionSchema = z.object({
  /** OIDC subject — the stable user id Keycloak issues. */
  subject: z.string().min(1),
  /** For display in the shell. Never used for a decision. */
  username: z.string().min(1),
  /** The organization this session is acting for, as identity reported it. */
  organizationId: z.string().min(1).nullable(),
  accessToken: z.string().min(1),
  /** Seconds since the epoch. Compared against the server clock, never the browser's. */
  accessTokenExpiresAt: z.number().int().positive(),
  refreshToken: z.string().min(1),
  /** Paired with a form field on every state-changing handler (ADR-059 § 5). */
  csrfToken: z.string().min(1),
  /**
   * Seconds since the epoch at which the login completed. Set once, by the
   * callback, and carried unchanged through every refresh: it is what the
   * absolute lifetime below is measured from, and a refresh that moved it
   * would turn a ceiling into a session that never ends while it is used.
   *
   * Required, so a cookie sealed before this field existed fails to open and
   * the person signs in once more — the one-time cost of a lifetime that is
   * actually enforced.
   */
  issuedAt: z.number().int().positive(),
});

export type WebSession = z.infer<typeof sessionSchema>;

export const SESSION_COOKIE = 'rasta_session';

/**
 * Cookie attributes, in one place so no handler can set a weaker combination.
 *
 * `sameSite: 'strict'` is the CSRF control the ADR names first; `httpOnly`
 * is what keeps the tokens away from any script on the page, including an
 * injected one.
 */
export function sessionCookieOptions(options: { secure: boolean; maxAgeSeconds: number }) {
  return {
    httpOnly: true,
    secure: options.secure,
    sameSite: 'strict' as const,
    path: '/',
    maxAge: options.maxAgeSeconds,
  };
}

/**
 * Seconds this session has left before `WEB_SESSION_MAX_AGE_SECONDS` ends it;
 * zero or less once it has.
 *
 * Enforced here, on the server, against the sealed `issuedAt`. The cookie's
 * own `Max-Age` is an instruction to the browser, and a copied cookie obeys
 * nobody: before this check a sealed session opened for as long as its
 * refresh token kept working, whatever the configured ceiling said. Every
 * read of the session goes through this (`current-session.ts`,
 * `session-refresh.ts`).
 */
export function sessionSecondsLeft(
  session: WebSession,
  maxAgeSeconds: number,
  now: number = Date.now(),
): number {
  return session.issuedAt + maxAgeSeconds - Math.floor(now / 1000);
}

/**
 * Derives the 32-byte key from the configured secret.
 *
 * SHA-256 of the secret rather than the secret's bytes: the environment
 * carries a string of unknown length, and AES-256 needs exactly 32 bytes. This
 * is a key derivation for length, not a password hash — the secret is already
 * high-entropy by configuration (`WEB_SESSION_SECRET`, minimum 32 characters),
 * which is why a slow KDF would buy nothing here.
 */
function keyFrom(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * Seals any JSON-serialisable value into the opaque string a cookie carries.
 *
 * Generic because two cookies need it: the session, and the short-lived login
 * attempt that holds the PKCE verifier between the redirect out and the
 * redirect back. One implementation rather than two means the second one
 * cannot quietly be the weaker one.
 */
export function seal(value: unknown, secret: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFrom(secret), nonce, { authTagLength: TAG_BYTES });
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
}

/** Opens a sealed value and validates its shape, or returns null. */
export function open<T>(sealed: string, secret: string, schema: z.ZodType<T>): T | null {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length <= NONCE_BYTES + TAG_BYTES) return null;

    const nonce = raw.subarray(0, NONCE_BYTES);
    const tag = raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const body = raw.subarray(NONCE_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, keyFrom(secret), nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    const opened = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');

    const parsed = schema.safeParse(JSON.parse(opened));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Seals a session into the opaque string the cookie carries. */
export function sealSession(session: WebSession, secret: string): string {
  return seal(sessionSchema.parse(session), secret);
}

/**
 * Opens a sealed session, or returns null.
 *
 * Null rather than throwing, for every way it can fail: a tampered cookie, a
 * cookie sealed with a retired key, a cookie from an older shape of this
 * object. All three mean the same thing to a caller — there is no usable
 * session — and turning each into an exception would push the same `catch`
 * into every handler.
 */
export function openSession(sealed: string, secret: string): WebSession | null {
  return open(sealed, secret, sessionSchema);
}

/** A CSRF token, and the comparison that goes with it. */
export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Constant-time-ish comparison for the CSRF token.
 *
 * Length is compared first and then every character is examined, so the
 * duration does not depend on where the first difference is. `timingSafeEqual`
 * would be stricter, but it throws on a length mismatch — which is itself the
 * leak it was meant to avoid — and would need the guard anyway.
 */
export function csrfMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ received.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * What a page may know about the person, with nothing a template could leak.
 *
 * Every server component that renders the shell takes this rather than the
 * session itself, so a token cannot reach a React tree by accident — and a
 * React tree is serialized into the page for hydration.
 */
export interface SessionView {
  readonly subject: string;
  readonly username: string;
  readonly organizationId: string | null;
}

export function viewOf(session: WebSession): SessionView {
  return {
    subject: session.subject,
    username: session.username,
    organizationId: session.organizationId,
  };
}
