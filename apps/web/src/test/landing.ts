import { FLASH_PARAM } from '@/lib/form-fields';
import { CONTEXT_PARAM } from '@/lib/page-context';
import { readFlash } from '@/server/flash';
import { pageContext } from '@/server/page-context';
import type { WebSession } from '@/server/session';

/**
 * Where a write's redirect lands, read the way the page will read it
 * (`server/flash.ts`, `server/page-context.ts`): its path, its other query
 * values, whether its tag is this session's organization, and the
 * confirmation its flash carries for `subject` — or undefined.
 */
export function landing<A extends string>(
  url: string,
  session: WebSession,
  subject: string,
  actions: readonly A[],
): {
  readonly path: string;
  readonly query: Record<string, string>;
  readonly bound: boolean;
  readonly confirmed: A | undefined;
} {
  const parsed = new URL(url, 'http://portal.test');
  const query = Object.fromEntries(parsed.searchParams);
  const { [FLASH_PARAM]: flash, [CONTEXT_PARAM]: tag, ...rest } = query;
  return {
    path: parsed.pathname,
    query: rest,
    bound: tag === pageContext(session),
    confirmed: readFlash(session, flash, subject, actions),
  };
}
