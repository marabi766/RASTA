import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { webServerEnv } from './env';
import type { WebSession } from './session';

/**
 * A small piece of JSON the server hands to a browser and later accepts back,
 * which only this server could have written, only for the person it was
 * written for, and only until it expires.
 *
 * It is the same construction as `submission.ts`' bound ids — an HMAC keyed
 * from the session secret under a purpose label, over the session's subject and
 * CSRF token — but over a payload, so the two uses that need one (the flash a
 * redirect carries, and the baseline an edit form carries) share one reviewed
 * implementation instead of two.
 *
 * ## What it proves, and what it does not
 *
 * - **Not forged**: a payload this server never signed, or one whose bytes were
 *   changed, fails.
 * - **Not somebody else's**: another person's token, and one from an earlier
 *   login (the CSRF token is per login), fail.
 * - **Not for another purpose**: the purpose is inside the key, so a flash
 *   cannot be passed off as a baseline.
 * - **Not forever**: `exp` is signed with the rest.
 *
 * It does **not** make a token single-use, and it is not encryption — the
 * payload is readable by whoever holds the token, so nothing secret goes in it.
 */

const KEY_LABEL = 'rasta-web/signed-payload/v1';

/** Far larger than anything signed here; refuses a megabyte of junk before parsing it. */
const MAX_TOKEN_LENGTH = 4096;

/** A 32-byte MAC in base64url. */
const MAC_CHARS = 43;

const TOKEN_SHAPE = new RegExp(`^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{${MAC_CHARS}}$`);

function macFor(session: WebSession, purpose: string, body: string): Buffer {
  const key = createHmac('sha256', webServerEnv().WEB_SESSION_SECRET)
    .update(`${KEY_LABEL}:${purpose}`)
    .digest();
  return createHmac('sha256', key)
    .update(`${session.subject}\n${session.csrfToken}\n${body}`)
    .digest();
}

/** Signs `payload`, valid for `ttlSeconds` from `now`. */
export function signPayload(
  session: WebSession,
  purpose: string,
  payload: Readonly<Record<string, unknown>>,
  ttlSeconds: number,
  now: number = Date.now(),
): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  return `${body}.${macFor(session, purpose, body).toString('base64url')}`;
}

/**
 * The payload, if `token` is one `signPayload` issued to this session for this
 * purpose, has not expired, and matches `schema`; otherwise `null` — one answer
 * for every way it can be wrong, so a caller cannot be used to tell them apart.
 */
export function verifyPayload<S extends z.ZodRawShape>(
  session: WebSession,
  purpose: string,
  token: unknown,
  schema: z.ZodObject<S>,
  now: number = Date.now(),
): z.infer<z.ZodObject<S>> | null {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !TOKEN_SHAPE.test(token)) {
    return null;
  }

  const dot = token.indexOf('.');
  const body = token.slice(0, dot);
  const macText = token.slice(dot + 1);
  const received = Buffer.from(macText, 'base64url');

  // 32 bytes leave two spare bits in the last character, so several strings
  // decode to the same bytes; only the canonical one was issued.
  if (received.toString('base64url') !== macText) return null;

  const expected = macFor(session, purpose, body);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const envelope = z.object({ exp: z.number().int() }).passthrough().safeParse(json);
  if (!envelope.success) return null;
  const { exp, ...rest } = envelope.data;
  if (exp * 1000 < now) return null;

  const parsed = schema.strict().safeParse(rest);
  return parsed.success ? parsed.data : null;
}
