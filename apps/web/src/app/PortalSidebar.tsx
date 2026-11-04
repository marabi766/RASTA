import { Sidebar } from '@/ui';
import { portalNavForSession } from '@/server/portal-nav';
import type { WebSession } from '@/server/session';

import { PageThemeOwner } from './PageThemeOwner';

/**
 * The portal sidebar, with the navigation this person may be offered.
 *
 * A server component: the session stays on the server and only the rendered
 * links reach the page. The links are drawn from the access token's own roles
 * (`portalNavForSession`), so no page has to read `/v1/users/me` for them.
 *
 * It also carries the page's theme owner (`PageThemeOwner`): every shell page
 * draws this, and it is rendered by the page's own request, which the root
 * layout is not.
 */
export function PortalSidebar({
  session,
  currentHref,
}: {
  session: WebSession;
  currentHref: string;
}) {
  return (
    <>
      <PageThemeOwner subject={session.subject} />
      <Sidebar items={portalNavForSession(session)} currentHref={currentHref} />
    </>
  );
}
