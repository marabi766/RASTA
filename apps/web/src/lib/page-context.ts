/**
 * What binds a portal URL's query to the organization it was drawn for (PR 405
 * review 2, F2) — the half a component in the browser can use. The server half,
 * which mints the tag and checks it before a page reads anything, is
 * `server/page-context.ts`.
 *
 * A cursor, a filter, a chosen warehouse or asset, a tab, a confirmation: each
 * is state of one organization's page. A URL drawn while the person acted for
 * A, reloaded after their session moved to B — a refresh, the back button, a
 * bookmark — must not filter B's list with A's cursor or show A's banner. So
 * every URL the portal draws with a query carries `ctx`, a short keyed tag of
 * the organization it was drawn for, and a page whose `ctx` is missing or names
 * another organization reads **none** of its query: it draws its default view.
 */

/** The query parameter that carries the tag. */
export const CONTEXT_PARAM = 'ctx';

/**
 * `path` with `params` — empty and undefined ones left out — and, when any is
 * left, the page's context tag. A bare path needs none: it is the default view.
 */
export function contextHref(
  context: string,
  path: string,
  params: Readonly<Record<string, string | null | undefined>> = {},
): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (name !== CONTEXT_PARAM && value !== undefined && value !== null && value !== '') {
      query.set(name, value);
    }
  }
  if (query.size === 0) return path;
  query.set(CONTEXT_PARAM, context);
  const [base, hash] = path.split('#', 2);
  return `${base}?${query.toString()}${hash === undefined ? '' : `#${hash}`}`;
}

/**
 * `href` — a portal path, perhaps with a query — bound to the page's context:
 * the tag is added when there is a query, replacing any it carried.
 */
export function withContext(context: string, href: string): string {
  const hashAt = href.indexOf('#');
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  const rest = hashAt === -1 ? href : href.slice(0, hashAt);
  const queryAt = rest.indexOf('?');
  if (queryAt === -1) return href;
  const query = new URLSearchParams(rest.slice(queryAt + 1));
  query.delete(CONTEXT_PARAM);
  if (query.size === 0) return `${rest.slice(0, queryAt)}${hash}`;
  query.set(CONTEXT_PARAM, context);
  return `${rest.slice(0, queryAt)}?${query.toString()}${hash}`;
}

/** A screen's query as its page hands it over: with the tag its URLs carry. */
export type InContext<Q> = Q & { readonly context: string };
