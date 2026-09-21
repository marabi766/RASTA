import { NextResponse } from 'next/server';
import { webServerEnv } from '@/server/env';
import { readSession } from '@/server/current-session';
import { endpointsFor } from '@/server/oidc';
import { SESSION_COOKIE, csrfMatches } from '@/server/session';

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
  const session = await readSession();

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
  return response;
}
