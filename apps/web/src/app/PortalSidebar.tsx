import { Sidebar } from '@/ui';
import { portalNavForSession } from '@/server/portal-nav';
import type { WebSession } from '@/server/session';

/**
 * The portal sidebar, with the navigation this person may be offered.
 *
 * A server component: the session stays on the server and only the rendered
 * links reach the page. The links are drawn from the access token's own roles
 * (`portalNavForSession`), so no page has to read `/v1/users/me` for them.
 */
export function PortalSidebar({
  session,
  currentHref,
}: {
  session: WebSession;
  currentHref: string;
}) {
  return <Sidebar items={portalNavForSession(session)} currentHref={currentHref} />;
}
