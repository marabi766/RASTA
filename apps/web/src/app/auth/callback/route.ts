import { NextResponse } from 'next/server';
import { webServerEnv } from '@/server/env';
import { LOGIN_ATTEMPT_COOKIE, openLoginAttempt, safeReturnTo } from '@/server/login-attempt';
import { endpointsFor, exchangeCode, OidcError, verifyIdToken } from '@/server/oidc';
import { SESSION_COOKIE, newCsrfToken, sealSession, sessionCookieOptions } from '@/server/session';

/**
 * Finishes a login (ADR-059 § 1).
 *
 * Four checks stand between an incoming callback and a session, and each one
 * exists because of a specific attack:
 *
 *   1. **There is an attempt cookie.** Without it there is no verifier, so a
 *      code cannot be exchanged at all — that is the whole of PKCE.
 *   2. **`state` matches the cookie.** A callback carrying somebody else's
 *      code is a login-CSRF: the victim ends up signed in as the attacker,
 *      and then acts inside the attacker's tenant.
 *   3. **The id token verifies** against the realm's keys, for this client.
 *   4. **`nonce` matches.** A token that verifies but answers a different
 *      login attempt is a replay.
 *
 * A failure of any of them ends the same way: the attempt cookie is cleared
 * and the browser goes back to `/login` with a reason. Nothing is logged that
 * could carry a code or a token.
 */
export const dynamic = 'force-dynamic';

function refuse(origin: string, reason: string): NextResponse {
  const back = NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(reason)}`);
  back.cookies.delete(LOGIN_ATTEMPT_COOKIE);
  return back;
}

export async function GET(request: Request): Promise<NextResponse> {
  const env = webServerEnv();
  const url = new URL(request.url);
  const origin = env.WEB_PUBLIC_ORIGIN;

  // Keycloak reports its own refusals here — a cancelled login, a disabled
  // account. The code is a bounded value from the provider; the description is
  // free text and is deliberately not carried into the page.
  const providerError = url.searchParams.get('error');
  if (providerError) return refuse(origin, 'provider_refused');

  const sealed = request.headers
    .get('cookie')
    ?.split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${LOGIN_ATTEMPT_COOKIE}=`))
    ?.slice(LOGIN_ATTEMPT_COOKIE.length + 1);
  if (!sealed) return refuse(origin, 'no_attempt');

  const attempt = openLoginAttempt(decodeURIComponent(sealed), env.WEB_SESSION_SECRET);
  if (!attempt) return refuse(origin, 'no_attempt');

  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !code || state !== attempt.state) return refuse(origin, 'state_mismatch');

  const endpoints = endpointsFor(env.OIDC_ISSUER_URL);
  try {
    const tokens = await exchangeCode({
      endpoints,
      clientId: env.OIDC_CLIENT_ID,
      redirectUri: `${origin}/auth/callback`,
      code,
      verifier: attempt.verifier,
    });

    const identity = await verifyIdToken(tokens.id_token, {
      issuer: env.OIDC_ISSUER_URL,
      clientId: env.OIDC_CLIENT_ID,
      jwksUri: endpoints.jwks,
      nonce: attempt.nonce,
    });

    const response = NextResponse.redirect(`${origin}${safeReturnTo(attempt.returnTo)}`);
    response.cookies.set(
      SESSION_COOKIE,
      sealSession(
        {
          subject: identity.subject,
          username: identity.username,
          organizationId: identity.organizationId,
          accessToken: tokens.access_token,
          // From the server clock and the provider's own lifetime, never from
          // anything the browser could influence.
          accessTokenExpiresAt: Math.floor(Date.now() / 1000) + tokens.expires_in,
          refreshToken: tokens.refresh_token,
          csrfToken: newCsrfToken(),
        },
        env.WEB_SESSION_SECRET,
      ),
      sessionCookieOptions({
        secure: env.WEB_COOKIE_SECURE,
        maxAgeSeconds: env.WEB_SESSION_MAX_AGE_SECONDS,
      }),
    );
    // The attempt is spent. Leaving it would let the same code be presented
    // twice, and the provider is not the only party that should refuse that.
    response.cookies.delete(LOGIN_ATTEMPT_COOKIE);
    return response;
  } catch (error) {
    return refuse(origin, error instanceof OidcError ? error.reason.toLowerCase() : 'login_failed');
  }
}
