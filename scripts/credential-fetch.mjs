/**
 * The root scripts' transport for any request that carries a credential (Q-155):
 * `internalFetch`'s policy (`packages/nest-common/src/http/internal-fetch.ts`) as
 * plain JavaScript, because these scripts run unbuilt — the Grafana probe inside a
 * bare `node:22-alpine` container with only the repository mounted.
 *
 * A credential is never sent to a redirect target, including one on the same
 * origin: 301/302/303/307/308 is refused before the body is read, and the error
 * names no URL, Location, body or credential. Every other status (304 included)
 * is returned as is. `credential-fetch.test.mjs` proves it over real HTTP and
 * pins this copy's statuses, and the portal's, to the original.
 */
export class CredentialRedirectRefusedError extends Error {
  constructor() {
    super('Credential-bearing redirect refused');
    this.name = 'CredentialRedirectRefusedError';
  }
}

/**
 * @param {Parameters<typeof fetch>[0]} input
 * @param {Omit<RequestInit, 'redirect'>} [init]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Response>}
 */
export async function credentialFetch(input, init = {}, fetchImpl = fetch) {
  // Set after init so a caller cannot override this policy.
  const response = await fetchImpl(input, { ...init, redirect: 'manual' });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    // Cleanup must not delay the verdict past the caller's deadline.
    void response.body?.cancel().catch(() => undefined);
    throw new CredentialRedirectRefusedError();
  }
  return response;
}
