import { NextResponse } from 'next/server';
import { webServerEnv } from '@/server/env';
import {
  LOGIN_ATTEMPT_COOKIE,
  loginAttemptCookieOptions,
  safeReturnTo,
  sealLoginAttempt,
} from '@/server/login-attempt';
import { authorizationUrl, endpointsFor, newOpaqueValue, newPkcePair } from '@/server/oidc';

/**
 * Starts a login (ADR-059 § 1).
 *
 * Everything secret about the attempt — the PKCE verifier above all — is
 * sealed into a cookie this server can open and nobody else can. What travels
 * in the URL is the challenge, which is a hash, and a `state` that is only
 * meaningful when paired with that cookie.
 *
 * `dynamic` is forced because this route reads and writes cookies and must
 * never be prerendered into a static response: a cached login URL would hand
 * every visitor the same `state` and the same challenge.
 */
export const dynamic = 'force-dynamic';

export function GET(request: Request): NextResponse {
  const env = webServerEnv();
  const attempt = {
    state: newOpaqueValue(),
    nonce: newOpaqueValue(),
    ...newPkcePair(),
    returnTo: safeReturnTo(new URL(request.url).searchParams.get('returnTo')),
  };

  const redirect = NextResponse.redirect(
    authorizationUrl({
      endpoints: endpointsFor(env.OIDC_ISSUER_URL),
      clientId: env.OIDC_CLIENT_ID,
      redirectUri: `${env.WEB_PUBLIC_ORIGIN}/auth/callback`,
      state: attempt.state,
      nonce: attempt.nonce,
      challenge: attempt.challenge,
    }),
  );

  redirect.cookies.set(
    LOGIN_ATTEMPT_COOKIE,
    sealLoginAttempt(
      {
        state: attempt.state,
        nonce: attempt.nonce,
        verifier: attempt.verifier,
        returnTo: attempt.returnTo,
      },
      env.WEB_SESSION_SECRET,
    ),
    loginAttemptCookieOptions(env.WEB_COOKIE_SECURE),
  );

  return redirect;
}
