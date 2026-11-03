import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';

import { readThemePreference } from '@/server/theme';

import { AccountGuard } from './AccountGuard';
import { vazirmatn } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'رستا',
  description: 'سامانهٔ مدیریت ناوگان، زنجیرهٔ تأمین، خدمات و عملیات عمرانی',
};

/**
 * The document shell.
 *
 * `lang="fa"` and `dir="rtl"` are set here and nowhere else. docs/16 § 16.3
 * calls this an architectural requirement rather than a preference: the
 * direction is a property of the document, so every layout rule beneath it can
 * be written with logical properties and stay correct without branching.
 *
 * A component that reads correctly only in left-to-right is broken in this
 * project, and `layout.spec.tsx` asserts the two attributes so a later edit
 * cannot quietly drop them.
 *
 * The font class publishes `--font-vazirmatn` on the document, which
 * `globals.css` reads as the head of `--font-sans`. No component names a font,
 * for the same reason no component names a colour.
 *
 * `data-theme` is rendered here, from the preference cookie the server reads
 * (`server/theme.ts`): `light` unless this person — or, on the login page,
 * this device — has chosen `dark`, whatever the operating system prefers (owner
 * decision 2026-10-24). It is in the HTML itself, so the first paint is already
 * the right one, nothing needs an inline script (and so nothing for the content
 * security policy to permit), and it holds with scripts blocked.
 *
 * Only the first paint is decided here. This layout is kept across a soft
 * navigation, so whose preference a page's switch keeps, and the theme after
 * an account change in the same document, are declared by each page
 * (`PageThemeOwner`), not by anything above it (PR 595 review, F1).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const { theme } = await readThemePreference();
  return (
    <html lang="fa" dir="rtl" data-theme={theme} className={vazirmatn.variable}>
      <body>
        {children}
        <Suspense fallback={null}>
          <AccountGuard />
        </Suspense>
      </body>
    </html>
  );
}
