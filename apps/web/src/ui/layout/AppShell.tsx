import type { ReactNode } from 'react';

import { cn } from '../cn';

/**
 * The frame every screen sits inside: a top bar, a sidebar, and the page.
 *
 * The skip link is the first focusable element in the document. Without it,
 * reaching the page content by keyboard means tabbing through every navigation
 * item on every screen — which is the single most common accessibility failure
 * in an application with a persistent sidebar, and one WCAG 2.1 (2.4.1) names
 * directly.
 *
 * It is visually hidden until it is focused, so it costs nothing on screen and
 * appears the moment someone tabs into the page.
 *
 * `<main id="main">` is the target, and the only `<main>` in the document.
 */
export function AppShell({
  topBar,
  sidebar,
  children,
  className,
}: {
  topBar?: ReactNode;
  sidebar?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-screen flex-col bg-surface-base', className)}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-text"
      >
        پرش به محتوای اصلی
      </a>
      {topBar}
      <div className="flex flex-1 flex-col md:flex-row">
        {sidebar}
        <main id="main" className="flex flex-1 flex-col gap-6 p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
