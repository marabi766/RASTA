import { readSession } from '@/server/current-session';
import type { AccountTags } from '@/lib/unresolved-tenancy';
import { submissionBinding } from '@/server/submission';

import { AccountBoundary } from './AccountBoundary';

/**
 * Hands the browser the one-way tags of whose page this is — the person, and
 * the old-format tags their entries may carry (`submissionBinding`) — and
 * nothing else of the session. No session, a session `readSession()` refuses
 * (its organization cannot be told), or one the tags cannot be computed for, is
 * a page with no owner: nothing is removed, nothing restored.
 */
export async function AccountGuard() {
  let account: AccountTags | null = null;
  try {
    const session = await readSession();
    const binding = session ? submissionBinding(session) : null;
    account = binding ? { person: binding.person, legacy: binding.legacy } : null;
  } catch {
    account = null;
  }
  return <AccountBoundary account={account} />;
}
