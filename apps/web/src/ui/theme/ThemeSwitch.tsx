'use client';

import { useLayoutEffect, useSyncExternalStore } from 'react';

import { Button } from '../action/Button';
import { THEME_COOKIE_NAME, parseTheme, resolveTheme, themeCookie, type Theme } from './theme';

/**
 * Whose preference this page's switch keeps: which cookie, and whether it is
 * `Secure`. Every page publishes its own through `ThemeOwner`, rendered by the
 * same server render as the rest of that page — never by the root layout. Next
 * keeps the root layout across a soft navigation, so a name handed down once
 * from there outlives the account it was computed for (PR 595 review, F1); a
 * name that arrives with the page cannot be older than the page.
 */
interface Owner {
  readonly cookieName: string;
  readonly secure: boolean;
}

let owner: Owner | null = null;
/** The cookie whose theme the document last took on: `null` before any page has. */
let applied: string | null = null;
const ownerWatchers = new Set<() => void>();

function setOwner(next: Owner | null) {
  owner = next;
  ownerWatchers.forEach((notify) => notify());
}

function watchOwner(onChange: () => void): () => void {
  ownerWatchers.add(onChange);
  return () => {
    ownerWatchers.delete(onChange);
  };
}

/** The value of one cookie in this document's jar (`document.cookie`), or undefined. */
function readCookie(name: string): string | undefined {
  try {
    for (const pair of document.cookie.split('; ')) {
      const at = pair.indexOf('=');
      if (at > 0 && pair.slice(0, at) === name) return pair.slice(at + 1);
    }
  } catch {
    // Cookies are refused: there is nothing stored to read.
  }
  return undefined;
}

/**
 * Declares, for the page that renders it, whose theme preference its switch
 * keeps, and makes the document wear that person's theme.
 *
 * - **Delivery.** It is part of the page, so a soft navigation to another
 *   person's page replaces it; an unmount (to a page that does not render one)
 *   takes the owner away, and a switch with no owner is not drawn — it never
 *   writes under a name it was not given for this page.
 * - **Synchronisation.** When the owner is not the one the document last took
 *   its theme from — the first page, or another account's — the attribute is
 *   set from that cookie before paint. The attribute is imperative (the
 *   switch writes it), so React re-rendering the root with an equal
 *   `data-theme` prop would not correct it. The same owner on the next page
 *   leaves the attribute as it is: with cookies blocked it is the only
 *   memory the choice has.
 */
export function ThemeOwner({ cookieName, secure }: { cookieName: string; secure: boolean }) {
  // Only a name the theme may ever use: anything else is no owner (fail closed).
  const valid = THEME_COOKIE_NAME.test(cookieName);
  useLayoutEffect(() => {
    if (!valid) return undefined;
    if (applied !== cookieName) {
      document.documentElement.setAttribute('data-theme', resolveTheme(cookieName, readCookie));
      applied = cookieName;
      watchers.forEach((notify) => notify());
    }
    setOwner({ cookieName, secure });
    return () => setOwner(null);
  }, [cookieName, secure, valid]);
  return null;
}

/** The theme the document is wearing right now — the attribute is the truth. */
function documentTheme(): Theme {
  return parseTheme(document.documentElement.getAttribute('data-theme'));
}

/** Every mounted switch: told at once when one of them changes the attribute. */
const watchers = new Set<() => void>();

function watchDocumentTheme(onChange: () => void): () => void {
  watchers.add(onChange);
  // Also anything else that moves the attribute, a tick later.
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    watchers.delete(onChange);
    observer.disconnect();
  };
}

const never = () => () => undefined;

/**
 * The light / dark switch.
 *
 * A toggle button: `aria-pressed` is "dark is on", and the label does not
 * change with it (a label that flips *and* a pressed state would be announced
 * twice). `type="button"` so it can never submit a form around it, and it is
 * activated by Enter and Space like any button.
 *
 * Choosing sets the attribute on `<html>` and writes the cookie — in place. No
 * navigation, no refresh, nothing remounts, so a half-filled transaction form,
 * its submission key and any stored unresolved order are exactly as they were,
 * and no other storage is touched. The attribute changes first: if the cookie
 * cannot be written (cookies blocked) the current page still follows the
 * choice, and only the memory of it is lost.
 *
 * The state is read from the attribute, not kept here: every page mounts its
 * own switch, and the document is the one place all of them agree. The cookie
 * it writes is the one its own page's `ThemeOwner` named.
 *
 * It is drawn after hydration only. Before that it would be a button that does
 * nothing, on exactly the connections where scripts fail; the server HTML
 * already carries the theme, so nothing is lost by its absence.
 */
export function ThemeSwitch() {
  const ready = useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
  const theme = useSyncExternalStore(watchDocumentTheme, documentTheme, () => 'light' as Theme);
  const keeping = useSyncExternalStore(
    watchOwner,
    () => owner,
    () => null,
  );
  // No owner declared by this page: nothing to keep a choice under, so no switch.
  if (!ready || !keeping) return null;
  const { cookieName, secure } = keeping;

  const choose = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    watchers.forEach((notify) => notify());
    try {
      document.cookie = themeCookie(cookieName, next, secure);
    } catch {
      // Cookies are refused: the page has changed, the memory of it has not.
    }
  };

  return (
    <Button
      type="button"
      tone="secondary"
      aria-pressed={theme === 'dark'}
      onClick={choose}
      className="shrink-0 whitespace-nowrap aria-pressed:bg-surface-sunken"
    >
      حالت تیره
    </Button>
  );
}
