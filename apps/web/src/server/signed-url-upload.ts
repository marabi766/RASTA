/**
 * The bytes of an upload, from this server to object storage, over the signed
 * URL document-service issued (ADR-014). The URL is the capability: a redirect
 * would carry the signed request and the file to a host nobody chose, so it is
 * a network error here, never followed — and the caller cannot change that
 * (Q-155). One of the audited transports of `internal/raw-http`.
 */
export function putToSignedUrl(
  url: string,
  init: Omit<RequestInit, 'method' | 'redirect'>,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  // Set after init so even an untyped caller cannot override either.
  return fetchImpl(url, { ...init, method: 'PUT', redirect: 'error' });
}
