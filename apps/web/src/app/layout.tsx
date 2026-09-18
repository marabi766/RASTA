import type { Metadata } from 'next';
import type { ReactNode } from 'react';

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
 * There is deliberately no `data-theme` attribute here. Its absence means
 * "follow the operating system", which `globals.css` implements in CSS alone —
 * no inline script, no flash of the wrong theme on first paint, and nothing
 * for a content security policy to have to permit.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl" className={vazirmatn.variable}>
      <body>{children}</body>
    </html>
  );
}
