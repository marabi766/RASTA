/** The context tag a screen spec hands its screen (`server/page-context.ts` mints the real one). */
export const TEST_CONTEXT = 'test-context-tag';

/**
 * A page's query as a URL the portal drew for `session` carries it: with the
 * tag of the organization it acts for (`server/page-context.ts`). Without it,
 * the page reads none of the query. With no session there is nothing to bind.
 */
export function boundQuery(
  session: unknown,
  params: Record<string, string | string[] | undefined> = {},
): Record<string, string | string[] | undefined> {
  // Required lazily: the server module reads its configuration when called.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { CONTEXT_PARAM } = require('@/lib/page-context') as typeof import('@/lib/page-context');
  const { pageContext } =
    require('@/server/page-context') as typeof import('@/server/page-context');
  /* eslint-enable @typescript-eslint/no-require-imports */
  // No session: nothing to bind to (the page sends the person to sign in first).
  if (session === null || session === undefined) return params;
  return {
    ...params,
    [CONTEXT_PARAM]: pageContext(session as import('@/server/session').WebSession),
  };
}
