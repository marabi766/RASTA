import { redirect } from 'next/navigation';

import { readSession, readStoredSessionForLogout } from '@/server/current-session';

import { RecoveryScreen } from './RecoveryScreen';

/**
 * The `/account/recovery` route: the way out for a signed-in person whose
 * session the portal refuses for tenant data (PR 405 review 2, F3).
 *
 * It reads the stored session only for what a logout needs — its CSRF token —
 * through the same reader `/auth/logout` uses (`readStoredSessionForLogout`),
 * and reads nothing else: no gateway call, no organization, no roles. A session
 * the portal can use goes home instead; no session goes to sign in.
 */
export const dynamic = 'force-dynamic';

export default async function RecoveryPage() {
  if (await readSession()) redirect('/');
  const stored = await readStoredSessionForLogout();
  if (!stored) redirect('/login');
  return <RecoveryScreen csrfToken={stored.csrfToken} />;
}
