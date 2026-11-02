import { cookies } from 'next/headers';

import { DEFAULT_THEME, DEVICE_THEME_COOKIE, resolveTheme, type Theme } from '@/ui';

import { readStoredSessionForLogout } from './current-session';
import { webServerEnv } from './env';
import { userThemeCookieName } from './theme-cookie';

/**
 * Whose theme this page wears, and where that choice lives (owner decision
 * 2026-10-24: light for everyone, a switch, remembered per person on the
 * device).
 *
 * ## One cookie per person
 *
 * A signed-in page reads `rasta_theme_<tag>`, where the tag is an HMAC of the
 * person's id under the server's session secret, cut to 96 bits. It is
 * **opaque**: the raw id never appears in a cookie name, nothing from the
 * session token goes into it, and without the secret nobody can compute
 * another person's name or check a guess against a cookie jar. Two people on
 * one device therefore each have a cookie only their own page looks at; a third
 * cookie, `rasta_theme`, belongs to the signed-out page.
 *
 * - A signed-in page does **not** fall back to the device cookie: that is
 *   whatever the last visitor to the login page chose, and not this person's.
 *   No cookie of their own means light.
 * - Logging out keeps every cookie; signing in as someone else shows that
 *   person's own choice. Switching organization changes nothing, because the
 *   tag is made from the person only.
 *
 * Anything unreadable — no session, a secret that cannot be loaded, a value
 * that is not exactly `light` or `dark` — is light.
 */

export { userThemeCookieName };

export interface ThemePreference {
  readonly theme: Theme;
  /** The cookie the switch on this page writes. */
  readonly cookieName: string;
  /** Whether that cookie carries `Secure` (the deployment terminates TLS). */
  readonly secure: boolean;
}

/**
 * Whether the theme cookie is `Secure`. The same flag the session cookie and
 * HSTS follow (`middleware.ts`), read the same way: a `Secure` cookie on a
 * plain-HTTP deployment would never be stored. Not the parsed environment, so
 * a signed-out request still never depends on it.
 */
function themeCookieSecure(): boolean {
  return process.env.WEB_COOKIE_SECURE !== 'false';
}

/** The theme of the request being rendered, and the cookie that holds it. */
export async function readThemePreference(): Promise<ThemePreference> {
  const secure = themeCookieSecure();
  try {
    const session = await readStoredSessionForLogout();
    const cookieName = session
      ? userThemeCookieName(session.subject, webServerEnv().WEB_SESSION_SECRET)
      : DEVICE_THEME_COOKIE;
    const jar = await cookies();
    return {
      theme: resolveTheme(cookieName, (name) => jar.get(name)?.value),
      cookieName,
      secure,
    };
  } catch {
    // Fail to the default, and to the signed-out cookie: a switch that cannot
    // tell whose page this is must not write under anybody's name.
    return { theme: DEFAULT_THEME, cookieName: DEVICE_THEME_COOKIE, secure };
  }
}
