import { timingSafeEqual } from 'node:crypto';

import { CONTEXT_PARAM, contextHref } from '@/lib/page-context';

import { contextTagFor } from './context-tag';
import { webServerEnv } from './env';
import type { WebSession } from './session';
import { actingOrganizationId } from './session-organization';

/**
 * The one boundary between a page and its URL's query (PR 405 review 2, F2).
 *
 * Every page reads its query through `pageParams` — a guard spec fails on any
 * page that reads `searchParams` itself (`page-context.spec.ts`). It hands the
 * query over only when its `ctx` is the tag of the organization this session
 * acts for; otherwise it hands over nothing, **before** any read: no cursor,
 * no filter, no chosen record, no tab, no confirmation — the page draws its
 * default view, as if the bare path had been asked for.
 *
 * Every URL the portal draws with a query carries the tag (`pageHref`, or
 * `contextHref` with the `context` a page hands its screen), so navigation
 * within one organization works as before and nothing drawn for another does.
 * Confirmations are signed with the organization too (`signed-payload.ts`), so
 * one cannot be carried across even with a tag that matches.
 *
 * The tag is a keyed digest of the organization alone: it reveals nothing,
 * cannot be made without the server's secret, and is the same for every
 * person of that organization — a link shared within it keeps its filters.
 */

type Params = Record<string, string | string[] | undefined>;

/** The tag of the organization this session acts for. Throws for one that cannot be told. */
export function pageContext(session: WebSession): string {
  return contextTagFor(webServerEnv().WEB_SESSION_SECRET, actingOrganizationId(session));
}

function sameTag(received: unknown, expected: string): boolean {
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

/**
 * The page's query, when it was drawn for the organization this session acts
 * for — without the tag itself; nothing at all otherwise.
 */
export async function pageParams(
  session: WebSession,
  searchParams: Promise<Params> | Params,
): Promise<Params> {
  const query = await searchParams;
  if (!sameTag(query[CONTEXT_PARAM], pageContext(session))) return {};
  return Object.fromEntries(Object.entries(query).filter(([name]) => name !== CONTEXT_PARAM));
}

/** `path` with `params`, bound to the organization this session acts for. */
export function pageHref(
  session: WebSession,
  path: string,
  params: Readonly<Record<string, string | null | undefined>> = {},
): string {
  return contextHref(pageContext(session), path, params);
}
