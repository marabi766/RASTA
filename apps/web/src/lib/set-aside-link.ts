import type { MouseEvent } from 'react';

/**
 * The handlers of a link that sets an unresolved request aside as the person
 * opens the page it names (the uncertainty view's «… را دیدم؛ این درخواست را
 * کنار بگذار», the order form's «شروع سفارش تازه»): one rule for every fenced
 * form, so none can drift.
 *
 * - **A primary click** — also with the modifier that opens it in another tab
 *   — sets it aside: the person is opening the page they were told to check.
 * - **A middle click** (`button` 1) opens it in another tab and sets it aside
 *   too. This document stays alive, and so may an earlier send of the same
 *   request; its late answer cannot touch a record made again under the same
 *   key afterwards — every record has its own send identity
 *   (`lib/unresolved-tenancy.ts`, PR 363 review 4).
 * - **Any other button sets nothing aside.** `auxclick` fires for every
 *   non-primary button — Chromium and Firefox fire it for the right button,
 *   after the context menu opens (checked in Playwright 1.62.1) — so a
 *   right-click to copy the link, or a back/forward button, used to remove the
 *   record of a request whose outcome is unknown.
 */
export function setAsideOnOpen(setAside: () => void) {
  return {
    onClick: () => setAside(),
    onAuxClick: (event: MouseEvent) => {
      if (event.button === 1) setAside();
    },
  };
}
