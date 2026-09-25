import { NextResponse, type NextRequest } from 'next/server';

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
export function middleware(request: NextRequest): NextResponse {
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

export const config = {
  matcher: [
    // Every route except Next's own fingerprinted static assets and the
    // favicon — files this portal ships itself, where a response header
    // changes nothing.
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
