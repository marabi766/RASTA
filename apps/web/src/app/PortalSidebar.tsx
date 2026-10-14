import { Sidebar } from '@/ui';
import { loadPortalNav } from '@/server/portal-nav';
import type { CurrentUserResult } from '@/server/identity';
import type { WebSession } from '@/server/session';

/**
 * The portal sidebar, with the navigation this person may be offered.
 *
 * A server component: the session stays on the server and only the rendered
 * links reach the page. Pass `current` when the page has already read
 * `/v1/users/me`, so it is not asked for twice.
 */
export async function PortalSidebar({
  session,
  currentHref,
  current,
}: {
  session: WebSession;
  currentHref: string;
  current?: CurrentUserResult;
}) {
  const items = await loadPortalNav(session, current);
  return <Sidebar items={items} currentHref={currentHref} />;
}
