'use client';

import { useEffect } from 'react';

import {
  markAccountOpen,
  purgeAllUnresolvedOrders,
  purgeForeignUnresolvedOrders,
} from '@/lib/unresolved-order';

/**
 * The browser's side of an account boundary: what an unresolved order left in
 * `sessionStorage` (`lib/unresolved-order.ts`) must not outlive.
 *
 * - **Logout.** Any form posting to `/auth/logout` — every portal page has its
 *   own — empties every remembered order before the navigation leaves. A capture
 *   listener on the document, so no page has to remember to wire it.
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
    purgeForeignUnresolvedOrders(owner);
  }, [owner]);

  useEffect(() => {
    const onSubmit = (event: Event) => {
      const form = event.target;
      if (form instanceof HTMLFormElement && isLogout(form)) purgeAllUnresolvedOrders();
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
