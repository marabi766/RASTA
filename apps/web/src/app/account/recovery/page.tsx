import { redirect } from 'next/navigation';

import { readSession, readStoredSessionForLogout } from '@/server/current-session';
import { organizationLost } from '@/server/session-organization';

import { RecoveryScreen } from './RecoveryScreen';

/**
 * The `/account/recovery` route: the way out for a signed-in person whose
 * session the portal refuses for tenant data (PR 405 review 2, F3).
 *
 * It reads the stored session only for what a logout needs — its CSRF token —
 * through the same reader `/auth/logout` uses (`readStoredSessionForLogout`),
 * and whether its organization was taken away after it signed in
 * (`organizationLost`, task 118) — to say so; nothing else: no gateway call,
 * no organization drawn, no roles. A session
 * the portal can use goes home instead; no session goes to sign in.
 */
export const dynamic = 'force-dynamic';

export default async function RecoveryPage() {
  if (await readSession()) redirect('/');
  const stored = await readStoredSessionForLogout();
  if (!stored) redirect('/login');
  // Which way it cannot act is told from the session's own pin and token —
  // whether to say "your organization changed", nothing more is drawn of it.
  return (
    <RecoveryScreen csrfToken={stored.csrfToken} organizationLost={organizationLost(stored)} />
  );
}
