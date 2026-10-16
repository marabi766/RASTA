'use client';

import { useEffect } from 'react';

import { FLASH_PARAM } from '@/lib/form-fields';

/**
 * Removes the confirmation token from the address once its banner has been
 * drawn, so a reload, a bookmark or a copied link does not show it again: the
 * banner belongs to the moment the person's own request was answered, not to
 * the page (PR 319 review 1, finding 3). The page is not re-rendered — only the
 * address changes.
 */
export function ConsumedFlash() {
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has(FLASH_PARAM)) return;
      url.searchParams.delete(FLASH_PARAM);
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    } catch {
      // An address that cannot be rewritten keeps the token; it expires on its own.
    }
  }, []);
  return null;
}
