import { Vazirmatn } from 'next/font/google';

/**
 * The interface typeface.
 *
 * docs/16 § 16.3 asks for Vazirmatn loaded locally, with no external CDN.
 * `next/font` satisfies that: it fetches the font files once at **build** time
 * and emits them as assets of this application, so a browser never talks to
 * `fonts.gstatic.com`. There is no third-party request at runtime, nothing for
 * a CSP to allow, and nothing for a font host to observe about our users.
 *
 * The cost is honest and worth stating: the build needs network access. If the
 * font cannot be fetched, `next build` fails loudly rather than shipping a
 * document that silently falls back. The alternative — committing the `.woff2`
 * from the upstream release — is more reproducible still, and is the move to
 * make the day someone reviews and approves a binary into this repository.
 *
 * `variable` exposes the family as `--font-vazirmatn`, which `globals.css`
 * reads as the first entry of `--font-sans`. Components never name a font.
 *
 * Note what is *not* used: upstream also publishes a "Farsi-Digits" cut that
 * renders Latin digits as Persian ones. That would rewrite the digits of a
 * tracking code, a national ID or an API identifier along with everything
 * else. Persian digits are produced in `src/lib/format`, where the code can
 * tell a quantity from an identifier.
 */
export const vazirmatn = Vazirmatn({
  // Arabic carries the Persian script; Latin is needed for the identifiers,
  // codes and units that appear inside Persian text.
  subsets: ['arabic', 'latin'],
  // Text stays readable in the fallback face while the font loads, instead of
  // leaving the page blank. On the weak connections docs/16 § 16.2 expects,
  // that is the difference between a usable screen and an empty one.
  display: 'swap',
  variable: '--font-vazirmatn',
  fallback: ['Segoe UI', 'Tahoma', 'Noto Sans Arabic', 'sans-serif'],
});
