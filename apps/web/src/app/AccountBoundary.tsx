'use client';

import { useEffect } from 'react';

import {
  markAccountOpen,
  purgeAllUnresolvedOrders,
  purgeForeignUnresolvedOrders,
} from '@/lib/unresolved-order';
import {
  markDisputesOpen,
  purgeAllUnresolvedDisputes,
  purgeForeignUnresolvedDisputes,
} from '@/lib/unresolved-dispute';
import {
  markContractCommandsOpen,
  purgeAllUnresolvedContractCommands,
  purgeForeignUnresolvedContractCommands,
} from '@/lib/unresolved-contract-command';
import {
  markStatementsOpen,
  purgeAllUnresolvedStatements,
  purgeForeignUnresolvedStatements,
} from '@/lib/unresolved-statement';
import {
  markBidsOpen,
  purgeAllUnresolvedBids,
  purgeForeignUnresolvedBids,
} from '@/lib/unresolved-bid';
import {
  markOwnerCommandsOpen,
  purgeAllUnresolvedOwnerCommands,
  purgeForeignUnresolvedOwnerCommands,
} from '@/lib/unresolved-tender-command';

/**
 * The browser's side of an account boundary: what an unresolved order,
 * dispute command, statement command or contract command left in
 * `sessionStorage` (`lib/unresolved-order.ts`, `lib/unresolved-dispute.ts`,
 * `lib/unresolved-statement.ts`, `lib/unresolved-contract-command.ts`) must
 * not outlive. All follow the same rules; a statement or contract command is
 * reduced to a marker at logout like a dispute command (a draft, an amendment
 * or a milestone repeated under a fresh key is a second one). A bid command's
 * record (`lib/unresolved-bid.ts`), and a tender owner's command's
 * (`lib/unresolved-tender-command.ts`), are markers from the start — they never
 * hold what was sent — so a logout only stops them being written again.
 *
 * - **Logout.** Any form posting to `/auth/logout` — every portal page has its
 *   own — empties every remembered order before the navigation leaves. A capture
 *   listener on the document, so no page has to remember to wire it. A
 *   remembered dispute command is reduced instead, to a marker with no text,
 *   no login tag and no stamp that still says its outcome is unknown: a dispute
 *   command repeated under a fresh key can act on a newer dispute, so the same
 *   person signing in again must not be offered a fresh form over it (PR 319
 *   review 2, finding 1). The next point removes it for anyone else.
 * - **A page for another person.** A page drawn for `owner` removes the entries
 *   of anyone else (and any it cannot read) on its first load, so a tab handed
 *   from one person to the next never shows the first one's offer, quantity or
 *   tracking code, even when the first one never pressed "log out" (a session
 *   that expired, a closed laptop). The same person after a re-login keeps theirs.
 *
 * - **Nothing is written after a logout starts.** The purge also sets an in-memory
 *   flag that `saveUnresolvedOrder` honours, so the answer to a send still in
 *   flight cannot store the order again. The sign-in page does not purge on load
 *   instead: that would also drop the order of a person whose session merely
 *   expired and who may still be in doubt (view-only after the re-login).
 *
 * `owner` is the one-way tag `submissionBinding` computes — null on a page with
 * no login (the sign-in page), where nothing is removed: the person signing back
 * in may be the one whose order is still in doubt.
 */
export function AccountBoundary({ owner }: { readonly owner: string | null }) {
  useEffect(() => {
    if (owner === null) return;
    markAccountOpen();
    markDisputesOpen();
    markStatementsOpen();
    markContractCommandsOpen();
    markBidsOpen();
    markOwnerCommandsOpen();
    purgeForeignUnresolvedOrders(owner);
    purgeForeignUnresolvedDisputes(owner);
    purgeForeignUnresolvedStatements(owner);
    purgeForeignUnresolvedContractCommands(owner);
    purgeForeignUnresolvedBids(owner);
    purgeForeignUnresolvedOwnerCommands(owner);
  }, [owner]);

  useEffect(() => {
    const onSubmit = (event: Event) => {
      const form = event.target;
      if (form instanceof HTMLFormElement && isLogout(form)) {
        purgeAllUnresolvedOrders();
        purgeAllUnresolvedDisputes();
        purgeAllUnresolvedStatements();
        purgeAllUnresolvedContractCommands();
        purgeAllUnresolvedBids();
        purgeAllUnresolvedOwnerCommands();
      }
    };
    document.addEventListener('submit', onSubmit, true);
    return () => document.removeEventListener('submit', onSubmit, true);
  }, []);

  return null;
}

function isLogout(form: HTMLFormElement): boolean {
  try {
    return new URL(form.action, window.location.href).pathname === '/auth/logout';
  } catch {
    return false;
  }
}
