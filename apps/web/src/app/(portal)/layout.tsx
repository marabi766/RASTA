import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { SessionProvider } from '@/lib/auth/session';

/**
 * Everything a signed-in person sees.
 *
 * Deliberately a route group rather than the root layout: `/auth/silent-renew`
 * must render without a session provider, because it *is* the silent renew and
 * starting another one inside it would nest iframes indefinitely.
 */
export default function PortalLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <SessionProvider>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
