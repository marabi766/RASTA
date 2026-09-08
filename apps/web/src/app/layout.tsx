import type { Metadata, Viewport } from 'next';
import { Vazirmatn } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

/**
 * The document shell, and nothing else.
 *
 * The portal chrome and the session provider live in `(portal)/layout.tsx`
 * rather than here, and that separation is load-bearing: `/auth/silent-renew`
 * runs inside a hidden iframe, and a session provider mounted there would kick
 * off its own silent renew — an iframe inside an iframe, forever. Keeping the
 * root free of behaviour is what stops that.
 */

/**
 * Vazirmatn, self-hosted.
 *
 * `next/font` fetches the files at build time and serves them from this origin,
 * so there is no runtime request to a font CDN. docs/16 § 16.3 asks for exactly
 * that and gives the reason: CSP control and performance. `display: swap` keeps
 * first paint off the webfont's critical path, which is the weak-connection
 * field operator § 16.10 is written around.
 */
const vazirmatn = Vazirmatn({
  subsets: ['arabic'],
  display: 'swap',
  variable: '--font-vazirmatn',
});

export const metadata: Metadata = {
  title: 'رستا — پورتال کاربر',
  description:
    'پلتفرم چندمستأجری مدیریت ناوگان، زنجیره تأمین، خدمات و عملیات عمرانی — نسخهٔ پیش‌نمایش.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Never `maximumScale: 1`. Blocking zoom is a WCAG failure, and this is a
  // Persian interface where a reader may genuinely need to magnify text.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f8f7' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1211' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    // `lang` and `dir` are architecture, not styling (docs/16 § 16.3). Every
    // logical property in the stylesheet resolves against this `dir`.
    <html lang="fa" dir="rtl" className={vazirmatn.variable}>
      <body>{children}</body>
    </html>
  );
}
