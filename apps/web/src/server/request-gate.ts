import { openSession, sessionSecondsLeft } from './session';

/**
 * What the portal refuses **before** a request's body is read (ADR-069 § الف).
 *
 * Next parses a Server Action's multipart body — all of it, up to
 * `serverActions.bodySizeLimit` (26 MiB by default, Q-98) — before the action
 * body, and so before the action's own session check, runs. Middleware runs
 * earlier than that, which is the only place a refusal costs nothing. Two
 * refusals live here, both decided from the headers alone:
 *
 *   1. an action POST (`Next-Action`) without a session this server can open
 *      is refused 401;
 *   2. a declared `Content-Length` above `WEB_REQUEST_MAX_BYTES` (1 MiB by
 *      default) is refused 413 for every path **except** the asset page, the
 *      one page whose action takes a document. A `POST`/`PUT`/`PATCH` with no
 *      declared length — chunked, or (HTTP/2) neither header at all — on any
 *      other path is refused 411: otherwise the ceiling would be a header an
 *      attacker leaves out.
 *
 * Not a defence against an authenticated person sending a large body to the
 * asset page, nor a rate limit — both stay open and ADR-069 says so.
 */

const MIB = 1024 * 1024;

export const DEFAULT_REQUEST_MAX_BYTES = 1 * MIB;
const MIN_REQUEST_MAX_BYTES = 64 * 1024;
const MAX_REQUEST_MAX_BYTES = 25 * MIB;

/**
 * `WEB_REQUEST_MAX_BYTES`: whole bytes, read at runtime. A value outside
 * 64 KiB – 25 MiB is a typo, and a typo here must not silently open or close
 * every form, so it falls back to the default rather than guessing.
 */
export function requestMaxBytes(raw: string | undefined): number {
  const text = raw?.trim();
  if (!text || !/^\d+$/.test(text)) return DEFAULT_REQUEST_MAX_BYTES;
  const bytes = Number(text);
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < MIN_REQUEST_MAX_BYTES ||
    bytes > MAX_REQUEST_MAX_BYTES
  ) {
    return DEFAULT_REQUEST_MAX_BYTES;
  }
  return bytes;
}

/**
 * The one path allowed a large body: `/assets/<id>`, whose action attaches a
 * document. Exact, so `/assets/<id>/anything` and `/assets` are held to the
 * ceiling like everything else.
 */
export function takesDocuments(pathname: string): boolean {
  return /^\/assets\/[^/]+\/?$/.test(pathname);
}

export interface GateInput {
  method: string;
  pathname: string;
  headers: Pick<Headers, 'get'>;
  /** The sealed session cookie as sent, if any. */
  sessionCookie: string | undefined;
  /** `WEB_REQUEST_MAX_BYTES`. */
  maxBytesRaw: string | undefined;
  /** Asked for only when an action carries a cookie, so no other request depends on the environment. */
  sessionConfig: () => { secret: string; maxAgeSeconds: number };
  now?: number;
}

export type GateRefusal = { status: 401 | 411 | 413; code: string };

const BODYLESS = new Set(['GET', 'HEAD', 'OPTIONS']);
/**
 * Methods whose body is read, and so whose length must be declared. Over
 * HTTP/2 a body is a run of DATA frames and `Content-Length` is optional, so a
 * client can send a large one with neither `Content-Length` nor
 * `Transfer-Encoding` — a request the 413 and the chunked 411 below never see.
 */
const LENGTH_REQUIRED = new Set(['POST', 'PUT', 'PATCH']);

export function refuseBeforeBody(input: GateInput): GateRefusal | null {
  const method = input.method.toUpperCase();

  if (!BODYLESS.has(method) && !takesDocuments(input.pathname)) {
    const declared = input.headers.get('content-length');
    if (declared !== null) {
      const length = /^\d+$/.test(declared.trim()) ? Number(declared.trim()) : Number.NaN;
      if (!Number.isFinite(length) || length > requestMaxBytes(input.maxBytesRaw)) {
        return { status: 413, code: 'BODY_TOO_LARGE' };
      }
    } else if (LENGTH_REQUIRED.has(method) || input.headers.get('transfer-encoding') !== null) {
      return { status: 411, code: 'LENGTH_REQUIRED' };
    }
  }

  if (method === 'POST' && input.headers.get('next-action') !== null) {
    if (!input.sessionCookie) return { status: 401, code: 'NO_SESSION' };
    const { secret, maxAgeSeconds } = input.sessionConfig();
    const session = openSession(input.sessionCookie, secret);
    if (!session || sessionSecondsLeft(session, maxAgeSeconds, input.now) <= 0) {
      return { status: 401, code: 'NO_SESSION' };
    }
  }

  return null;
}
