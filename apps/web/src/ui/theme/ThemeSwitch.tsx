'use client';

import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';

import { Button } from '../action/Button';
import { DEVICE_THEME_COOKIE, parseTheme, themeCookie, type Theme } from './theme';

/**
 * Where this page keeps the choice: which cookie, and whether it is `Secure`.
 * The root layout knows both (the name is the person's own, an opaque
 * derivation only the server can compute) and hands them down once.
 */
const ThemeStorage = createContext<{ cookieName: string; secure: boolean }>({
  cookieName: DEVICE_THEME_COOKIE,
  secure: false,
});

export function ThemeProvider({
  cookieName,
  secure,
  children,
}: {
  cookieName: string;
  secure: boolean;
  children: ReactNode;
}) {
  return <ThemeStorage value={{ cookieName, secure }}>{children}</ThemeStorage>;
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
 * own switch, and the document is the one place all of them agree.
 *
 * It is drawn after hydration only. Before that it would be a button that does
 * nothing, on exactly the connections where scripts fail; the server HTML
 * already carries the theme, so nothing is lost by its absence.
 */
export function ThemeSwitch() {
  const { cookieName, secure } = useContext(ThemeStorage);
  const ready = useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
  const theme = useSyncExternalStore(watchDocumentTheme, documentTheme, () => 'light' as Theme);
  if (!ready) return null;

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
