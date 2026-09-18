import type { Metadata } from 'next';
import type { ReactNode } from 'react';

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
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
