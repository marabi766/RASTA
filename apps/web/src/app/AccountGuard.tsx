import { readSession } from '@/server/current-session';
import { submissionBinding } from '@/server/submission';

import { AccountBoundary } from './AccountBoundary';

/**
 * Hands the browser the one-way tag of whose page this is (`submissionBinding`),
 * and nothing else of the session. No session, or a session the tag cannot be
 * computed for, is a page with no owner.
 */
export async function AccountGuard() {
  let owner: string | null = null;
  try {
    const session = await readSession();
    owner = session ? submissionBinding(session).owner : null;
  } catch {
    owner = null;
  }
  return <AccountBoundary owner={owner} />;
}
