/**
 * Keeps a session that acts for no organization away from every tenant-bound
 * route, before the route runs (task 118, audit F2 addendum B).
 *
 * A session pinned to no organization (`session-organization.ts`) sends no
 * `X-Organization-Id`, and the guard answers a request without one for the
 * token's **active** organization — whichever one the account was switched to
 * elsewhere. So such a session must not reach anything that reads or writes a
 * tenant's data: its pages are not drawn and its actions are not run. Only the
 * person's own routes stay open (`TENANTLESS`).
 *
 * The list is of what is **open**, so a route added later is tenant-bound until
 * somebody decides otherwise — the fail-closed default. `tenantCredential` is
 * the second wall: a tenant call for such a session throws before it is sent.
 */

/** Where a page request of such a session is sent instead: a page that says why. */
export const NO_ORGANIZATION_PATH = '/account/no-organization';

/**
 * The person's own routes: home (their profile), sign-in and sign-out, the
 * session probe and the account pages. Exact paths, or a prefix followed by `/`.
 */
const TENANTLESS_EXACT: ReadonlySet<string> = new Set(['/', '/login']);
const TENANTLESS_PREFIXES: readonly string[] = ['/auth/', '/account/'];

export function isTenantBoundPath(pathname: string): boolean {
  if (TENANTLESS_EXACT.has(pathname)) return false;
  return !TENANTLESS_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * What middleware does with a request:
 *
 * - `PASS` — anything but a session acting for no organization on a
 *   tenant-bound route (a session that cannot act at all is `readSession()`'s
 *   to refuse, and recovered);
 * - `REDIRECT` — a page request (GET or HEAD) of such a session: sent to
 *   {@link NO_ORGANIZATION_PATH};
 * - `HIDE` — anything else of such a session (a server action's POST): the
 *   route runs without the session, so it sends nothing and answers that no
 *   organization is selected (`missingSessionReason` → `NO_ORGANIZATION`).
 */
export type TenantGate = 'PASS' | 'REDIRECT' | 'HIDE';

export function tenantGate(request: {
  readonly pathname: string;
  readonly method: string;
  /** `sessionOrganization` of the session the route would see; `undefined` for none. */
  readonly organization: string | null | undefined;
}): TenantGate {
  if (request.organization !== null) return 'PASS';
  if (!isTenantBoundPath(request.pathname)) return 'PASS';
  return request.method === 'GET' || request.method === 'HEAD' ? 'REDIRECT' : 'HIDE';
}
