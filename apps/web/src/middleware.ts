import { NextResponse, type NextRequest } from 'next/server';
import { webServerEnv } from '@/server/env';
import { renewSession, type SessionRenewal } from '@/server/session-refresh';
import { SESSION_COOKIE, sessionCookieOptions } from '@/server/session';

/**
 * Security headers on every response (docs/09 § 302-306, docs/16 § 356-368).
 *
 * A fresh nonce per request, carried two ways: on the response's own CSP
 * header, and on `x-nonce` so a page could read it via `headers()` if it ever
 * needs to hand an inline `<script>` explicit permission. Neither is needed
 * today — `layout.tsx` ships no inline script on purpose — but Next.js reads
 * the nonce straight off the response's own CSP header and stamps it onto
 * every script tag it injects for hydration and route chunks, so the
 * framework keeps working under `'strict-dynamic'` without this file naming a
 * single script by hash or host.
 *
 * `'unsafe-eval'` is allowed only in development, where Fast Refresh's
 * webpack runtime needs it; a production build never carries it.
 *
 * HSTS is gated on `WEB_COOKIE_SECURE` — the same flag the session cookie's
 * own `Secure` attribute already uses to mean "this deployment terminates
 * TLS in front of the portal" — rather than on `NODE_ENV`. A production build
 * running behind a proxy that has not been given a certificate yet would
 * otherwise send a header instructing every browser to refuse it plain HTTP
 * for the next two years.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const renewal = await renewSessionCookie(request);

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';
  const secureDeployment = process.env.WEB_COOKIE_SECURE !== 'false';

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    // Only where TLS is terminated in front of the portal, like HSTS below.
    // On a plain-HTTP deployment it rewrites the portal's own same-origin
    // fetches and redirects to https://, which nothing answers.
    ...(secureDeployment ? [`upgrade-insecure-requests`] : []),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applyRenewal(response, renewal);
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  if (secureDeployment) {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    );
  }

  return response;
}

/**
 * Refreshes the session's tokens before the route runs (`session-refresh.ts`
 * explains why here and nowhere else).
 *
 * The request's own cookie is rewritten too, not only the response's: the
 * render that follows reads the cookie *it* was sent, and must see the
 * rotated session in this same request rather than the spent one.
 *
 * A refused refresh (`REFUSED`) leaves the browser's cookie alone — another
 * replica may be sending back the rotated one right now — but a session whose
 * access token has already run out is hidden from *this* render, which then
 * treats the person as signed out. Hiding it matters beyond the page: `/login`
 * sends anybody with an openable session to `/`, and `/` sends an expired one
 * back to `/login`, so leaving it visible would loop.
 *
 * The environment is read only when there is a cookie to act on, so a
 * signed-out request — the login page itself — never depends on it.
 */
async function renewSessionCookie(request: NextRequest): Promise<SessionRenewal> {
  const sealed = request.cookies.get(SESSION_COOKIE)?.value;
  if (!sealed) return { kind: 'NONE' };

  const renewal = await renewSession(sealed, { env: webServerEnv() });
  if (renewal.kind === 'RENEWED') request.cookies.set(SESSION_COOKIE, renewal.sealed);
  if (renewal.kind === 'ENDED') request.cookies.delete(SESSION_COOKIE);
  if (renewal.kind === 'REFUSED' && !renewal.usable) request.cookies.delete(SESSION_COOKIE);
  return renewal;
}

function applyRenewal(response: NextResponse, renewal: SessionRenewal): void {
  if (renewal.kind === 'RENEWED') {
    const env = webServerEnv();
    response.cookies.set(
      SESSION_COOKIE,
      renewal.sealed,
      sessionCookieOptions({ secure: env.WEB_COOKIE_SECURE, maxAgeSeconds: renewal.maxAgeSeconds }),
    );
  }
  if (renewal.kind === 'ENDED') response.cookies.delete(SESSION_COOKIE);
  // `REFUSED` writes nothing, deliberately: see `renewSessionCookie`.
}

export const config = {
  // Node rather than the edge runtime: the session is sealed with
  // `node:crypto`'s AES-GCM (`session.ts`), and the refresh has to open it.
  runtime: 'nodejs',
  matcher: [
    // Every route except Next's own fingerprinted static assets and the
    // favicon — files this portal ships itself, where a response header
    // changes nothing.
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
