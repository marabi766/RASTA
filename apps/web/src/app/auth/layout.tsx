import type { ReactNode } from 'react';

/**
 * A bare frame for the two OIDC redirect targets.
 *
 * No navigation, no session provider, no organization switcher — these routes
 * exist for the length of a token exchange and one of them is never seen by a
 * human at all.
 */
export default function AuthLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <main id="main" className="mx-auto max-w-lg p-6">
      {children}
    </main>
  );
}
