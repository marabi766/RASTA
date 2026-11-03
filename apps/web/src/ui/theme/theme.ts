/**
 * The theme preference: what it may be, and how it is stored.
 *
 * Owner decision 2026-10-24: the portal is **light by default** for everyone,
 * whatever the device asks for, and a person can switch to dark. The choice is
 * remembered on the device, per person.
 *
 * The preference is a cookie the SERVER reads, so the root layout renders
 * `<html data-theme="light|dark">` into the HTML itself: correct before first
 * paint, no inline script to nonce, and it works with scripts blocked. This
 * file is the part of that which has no server and no DOM in it, so the server
 * (which reads) and the switch (which writes) share one definition.
 *
 * The cookie holds the word `light` or `dark` and nothing else. Anything else
 * that arrives under its name is somebody else's text and reads as `light`.
 */

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** What everyone gets until they choose: light, regardless of the device. */
export const DEFAULT_THEME: Theme = 'light';

/**
 * The device-level cookie: written by the switch where nobody is signed in
 * (the login page). A signed-in page never reads it — see `server/theme.ts`.
 */
export const DEVICE_THEME_COOKIE = 'rasta_theme';

/** A year. A preference, not a credential: it is allowed to outlive a session. */
export const THEME_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Strictly `light` or `dark`; any other value, type or absence is `light`. */
export function parseTheme(raw: unknown): Theme {
  return raw === 'dark' ? 'dark' : DEFAULT_THEME;
}

/**
 * The theme to draw, given the one cookie this reader is allowed to look at.
 *
 * The caller names the cookie (`rasta_theme` for a visitor, the person's own
 * for a signed-in page) and this reads that name and no other, so another
 * person's cookie on the same device can never decide this person's page.
 */
export function resolveTheme(
  cookieName: string,
  read: (name: string) => string | undefined,
): Theme {
  return parseTheme(read(cookieName));
}

/**
 * The `document.cookie` assignment for a choice.
 *
 * `SameSite=Lax` and `Path=/`; `Secure` where the deployment terminates TLS
 * (the server says so — a `Secure` cookie on plain HTTP would simply be
 * dropped and the choice would not stick). Not `HttpOnly`: the switch writes
 * it from the page so that choosing needs no reload.
 */
export function themeCookie(name: string, theme: Theme, secure: boolean): string {
  return (
    `${name}=${parseTheme(theme)}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax` +
    (secure ? '; Secure' : '')
  );
}

/** The cookie names the theme may ever use: the device one, or one per person. */
export const THEME_COOKIE_NAME = /^rasta_theme(?:_[0-9a-f]{24})?$/;
