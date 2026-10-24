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
  if (response.status >= 300 && response.status < 400) {
    // Cleanup must not delay the unavailable verdict past the caller's deadline.
    void response.body?.cancel().catch(() => undefined);
    // No URL, Location, body, token or upstream message in the error.
    throw new Error('Internal service redirect refused');
  }
  return response;
}
