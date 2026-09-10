import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { TourProvider } from '@/components/demo/tour-provider';
import { SessionProvider } from '@/lib/auth/session';

/**
 * Everything a signed-in person sees.
 *
 * Deliberately a route group rather than the root layout: `/auth/silent-renew`
 * must render without a session provider, because it *is* the silent renew and
 * starting another one inside it would nest iframes indefinitely.
 *
 * `TourProvider` sits here rather than on the presentation page for the same
 * kind of reason. The tour navigates — every step is a real route change into a
 * real screen — so state owned by any one page would be destroyed by the act of
 * advancing. This layout survives navigation between portal routes, which is
 * what makes "next" work at all.
 *
 * It is inside `SessionProvider` because it reads the data mode from it: a stop
 * deep-links into the presentation dataset when that dataset is loaded, and
 * lands on the list screen when it is not.
 */
export default function PortalLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <SessionProvider>
      <TourProvider>
        <AppShell>{children}</AppShell>
      </TourProvider>
    </SessionProvider>
  );
}
