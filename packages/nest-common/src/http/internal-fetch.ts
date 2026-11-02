/**
 * What {@link internalFetch} throws for a redirect: a transport failure, never
 * an answer. Typed, so a caller that must tell "refused" from "may have been
 * applied" can (identity's Keycloak client: a write redirected after it was
 * sent is of unknown outcome). Carries no URL, Location, body or token.
 */
export class RedirectRefusedError extends Error {
  constructor() {
    super('Internal service redirect refused');
    this.name = 'RedirectRefusedError';
  }
}

/**
 * Authenticated internal exchanges must never send credentials to a redirect
 * target, including one on the same origin. Token issuance, method, deadlines
 * and non-redirect status semantics remain the caller's responsibility.
 *
 * A redirect is a transport failure, never an authoritative answer. Reject it
 * before reading its body so each client uses its existing unavailable path.
 */
export async function internalFetch(
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
    // Cleanup must not delay the unavailable verdict past the caller's deadline.
    void response.body?.cancel().catch(() => undefined);
    // No URL, Location, body, token or upstream message in the error.
    throw new RedirectRefusedError();
  }
  return response;
}
