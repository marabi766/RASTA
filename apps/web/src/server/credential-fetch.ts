/**
 * What {@link credentialFetch} throws for a redirect: a transport failure,
 * never an answer. Carries no URL, Location, body or credential, so a caller
 * may log it or show its message without disclosing either end (Q-155).
 */
export class CredentialRedirectRefusedError extends Error {
  constructor() {
    super('Credential-bearing redirect refused');
    this.name = 'CredentialRedirectRefusedError';
  }
}

/**
 * The portal's server-side transport for every request that carries a
 * credential: the user's bearer token to the gateway, an authorization code or
 * refresh token to the token endpoint (Q-155).
 *
 * The same policy as `internalFetch` in `@rasta/nest-common`, which the portal
 * cannot import (it carries Nest; A-02 keeps services' code out of this app):
 * a credential is never sent to a redirect target, including one on the same
 * origin, and a redirect is never an answer. `scripts/credential-fetch.test.mjs`
 * pins this copy's statuses to the original. Method, headers, body, `cache`,
 * the deadline signal and every non-redirect status (304 included) stay the
 * caller's: the request is sent exactly as given, once.
 */
export async function credentialFetch(
  input: Parameters<typeof fetch>[0],
  init: Omit<RequestInit, 'redirect'>,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  // Set after init so even untyped callers cannot override this policy.
  const response = await fetchImpl(input, { ...init, redirect: 'manual' });
  // Fetch redirects only these five statuses. 300 offers choices and 305 is
  // deprecated; neither navigates with manual fetch. Preserve their existing
  // caller-defined semantics, like 304 (cache revalidation) and unknown 3xx.
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    // Cleanup must not delay the verdict past the caller's deadline.
    void response.body?.cancel().catch(() => undefined);
    // No URL, Location, body, token or upstream message in the error.
    throw new CredentialRedirectRefusedError();
  }
  return response;
}
