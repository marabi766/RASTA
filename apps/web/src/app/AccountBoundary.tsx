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
  markReturnsOpen,
  purgeAllUnresolvedReturns,
  purgeForeignUnresolvedReturns,
} from '@/lib/unresolved-return';
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
import type { AccountTags } from '@/lib/unresolved-tenancy';

/**
 * The browser's side of an account boundary: what an unresolved order,
 * dispute command, statement command, return command or contract command left
 * in `sessionStorage` (`lib/unresolved-order.ts`, `lib/unresolved-dispute.ts`,
 * `lib/unresolved-statement.ts`, `lib/unresolved-return.ts`,
 * `lib/unresolved-contract-command.ts`) must not outlive. All follow the same
 * rules; a statement, return or contract command is reduced to a marker at
 * logout like a dispute command (a draft, a request, an amendment or a
 * milestone repeated under a fresh key is a second one). A bid command's
 * record (`lib/unresolved-bid.ts`), and a tender owner's command's
 * (`lib/unresolved-tender-command.ts`), are markers from the start — they never
 * hold what was sent — so a logout only stops them being written again.
 *
 * - **Logout.** Any form posting to `/auth/logout` — every portal page has its
 *   own, and so has the recovery page — reduces every remembered order before
 *   the navigation leaves, to a marker with nothing in it but the time. A
 *   capture listener on the document, so no page has to remember to wire it. A
 *   remembered dispute command is reduced too, to a marker with no text, no
 *   login tag and no stamp that still says its outcome is unknown: a dispute
 *   command repeated under a fresh key can act on a newer dispute, so the same
 *   person signing in again must not be offered a fresh form over it (PR 319
 *   review 2, finding 1).
 * - **A page for another person.** A page drawn for a person reduces the
 *   entries of anyone else on its first load to content-free markers, so a tab
 *   handed from one person to the next never shows the first one's offer,
 *   quantity or tracking code, even when the first one never pressed "log out"
 *   (a session that expired, a closed laptop). The same person after a re-login
 *   keeps theirs.
 * - **Nothing is removed outright** (PR 405 review 2, F1). What a logout or
 *   another person's page reduces, and every record that cannot be attributed
 *   to the page's person — one from an organization their token no longer
 *   lists, one that does not read — stays, and holds every fresh submission of
 *   its kind on this device until the person acknowledges the duplicate risk
 *   (`lib/unresolved-tenancy.ts`, `app/UnresolvedQuarantine.tsx`).
 * - **Another organization is not another person.** Entries are kept per
 *   person and organization (`lib/unresolved-tenancy.ts`): after a switch from
 *   A to B nothing of A's is removed here, and none of it is shown or resolved
 *   on B's pages — each store reads only the page's own organization — so back
 *   on A every unresolved request of A's is still there to reconcile (task 100).
 *
 * - **Nothing is written after a logout starts.** The purge also sets an in-memory
 *   flag that `saveUnresolvedOrder` honours, so the answer to a send still in
 *   flight cannot store the order again. The sign-in page does not reduce on
 *   load instead: that would also take the order of a person whose session
 *   merely expired and who may still be in doubt (view-only after the re-login).
 *
 * `account` is the person's one-way tags `submissionBinding` computes — null on
 * a page with no login (the sign-in page, a session `readSession()` refuses),
 * where nothing is removed: the person signing back in may be the one whose
 * order is still in doubt.
 */
export function AccountBoundary({ account }: { readonly account: AccountTags | null }) {
  // Primitive dependencies: a new array of the same tags is not a new person.
  const person = account?.person ?? null;
  const legacy = account?.legacy.join(' ') ?? '';
  useEffect(() => {
    if (person === null) return;
    const tags: AccountTags = { person, legacy: legacy === '' ? [] : legacy.split(' ') };
    markAccountOpen();
    markDisputesOpen();
    markReturnsOpen();
    markStatementsOpen();
    markContractCommandsOpen();
    markBidsOpen();
    markOwnerCommandsOpen();
    purgeForeignUnresolvedOrders(tags);
    purgeForeignUnresolvedDisputes(tags);
    purgeForeignUnresolvedReturns(tags);
    purgeForeignUnresolvedStatements(tags);
    purgeForeignUnresolvedContractCommands(tags);
    purgeForeignUnresolvedBids(tags);
    purgeForeignUnresolvedOwnerCommands(tags);
  }, [person, legacy]);

  useEffect(() => {
    const onSubmit = (event: Event) => {
      const form = event.target;
      if (form instanceof HTMLFormElement && isLogout(form)) {
        purgeAllUnresolvedOrders();
        purgeAllUnresolvedDisputes();
        purgeAllUnresolvedReturns();
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
