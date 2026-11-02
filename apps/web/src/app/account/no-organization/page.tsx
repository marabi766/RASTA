import { redirect } from 'next/navigation';

import { currentSession } from '@/server/current-session';
import { actingOrganizationId } from '@/server/session-organization';

import { NoOrganizationScreen } from './NoOrganizationScreen';

/**
 * The `/account/no-organization` route: where `tenant-gate.ts` sends a page
 * request of a session that acts for no organization (task 118). It makes no
 * gateway call. A session that does act for one has no business here and goes
 * home; no usable session goes to sign in.
 */
export const dynamic = 'force-dynamic';

export default async function NoOrganizationPage() {
  const session = await currentSession();
  if (!session) redirect('/login');
  if (actingOrganizationId(session) !== null) redirect('/');
  return <NoOrganizationScreen csrfToken={session.csrfToken} />;
}
