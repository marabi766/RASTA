import { CONTEXT_PARAM } from '@/lib/page-context';
import { RELEASE_QUERY } from '@/lib/release-messages';
import { handOver, pageContext, type PageParams } from '@/server/page-context';
import { readReleaseFeedback, type ReleaseSubject } from '@/server/release-feedback';
import type { ReleaseFeedbackKey } from '@/lib/release-messages';
import type { WebSession } from '@/server/session';

/**
 * The params a page would get for a query that carries `token` as its `release`, made the way a page
 * gets them (`pageParams`), so `readReleaseFeedback` sees what it sees in production.
 */
export function releaseQuery(session: WebSession, token: unknown): PageParams {
  const query: Record<string, string> = { [CONTEXT_PARAM]: pageContext(session) };
  if (typeof token === 'string') query[RELEASE_QUERY] = token;
  return handOver(session, query);
}

/** `readReleaseFeedback` for a query that carries `token`. */
export function feedbackFor(
  session: WebSession,
  subject: ReleaseSubject,
  token: unknown,
  idle: boolean,
): ReleaseFeedbackKey | undefined {
  return readReleaseFeedback(session, subject, releaseQuery(session, token), idle);
}
