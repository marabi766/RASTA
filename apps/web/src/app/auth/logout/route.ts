import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { webServerEnv } from '@/server/env';
import { readStoredSessionForLogout } from '@/server/current-session';
import { endpointsFor } from '@/server/oidc';
import { SESSION_COOKIE, csrfMatches } from '@/server/session';
import { LEGACY_UNRESOLVED_COOKIE_PREFIX, purgeUnresolved } from '@/server/unresolved-request';

/**
 * Ends the session (ADR-059 § 5).
 *
 * `POST` only, and with the CSRF token. Logging somebody out is a state
 * change, and a `GET` logout is the classic way a third-party page signs a
 * person out of an application by embedding an image — annoying here, and a
 * genuine denial of service on a screen somebody is working in.
 *
 * The cookie is cleared first and unconditionally, then the browser is sent to
 * the provider's end-session endpoint. The order matters: if Keycloak is
 * unreachable, the person is still logged out *here*, which is the part this
 * application is responsible for.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const env = webServerEnv();
  // Not `readSession()`: a session whose organization cannot be told must
  // still be able to sign out (`readStoredSessionForLogout`).
  const session = await readStoredSessionForLogout();

  if (!session) return NextResponse.redirect(`${env.WEB_PUBLIC_ORIGIN}/login`);

  const form = await request.formData().catch(() => null);
  if (!form || !csrfMatches(session.csrfToken, form.get('csrf'))) {
    // Not a redirect: a refused CSRF check is a refusal, and answering it with
    // a redirect would make it look like the action happened.
    return NextResponse.json({ error: 'CSRF_TOKEN_MISMATCH' }, { status: 403 });
  }

  const endSession = new URL(endpointsFor(env.OIDC_ISSUER_URL).endSession);
  endSession.searchParams.set('client_id', env.OIDC_CLIENT_ID);
  endSession.searchParams.set('post_logout_redirect_uri', `${env.WEB_PUBLIC_ORIGIN}/login`);

  const response = NextResponse.redirect(endSession.toString());
  response.cookies.delete(SESSION_COOKIE);
  // What this login held on the server (`server/unresolved-request.ts`) goes with
  // it — deleted, not merely unreachable. A store that cannot be reached does not
  // stop the logout; the records are bound to this login and expire on their own.
  await purgeUnresolved(session);
  // Cookies an earlier version kept the same state in.
  for (const { name } of (await cookies()).getAll()) {
    if (name.startsWith(LEGACY_UNRESOLVED_COOKIE_PREFIX)) response.cookies.delete(name);
  }
  return response;
}
