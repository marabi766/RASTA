'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Card, ErrorState, LoadingState } from '@/components/ui/primitives';
import { readPublicEnv } from '@/lib/env';
import { getUserManager } from '@/lib/auth/user-manager';

/**
 * The OIDC redirect target.
 *
 * `signinCallback` is what completes Authorization Code + PKCE: it exchanges
 * the code for tokens using the verifier `oidc-client-ts` stored before the
 * redirect, and it refuses the exchange if the `state` does not match — which
 * is the CSRF protection for the flow, not an optional extra.
 *
 * Nothing is logged and nothing from the query string is rendered. A failed
 * callback carries `error_description` from the identity provider, and echoing
 * an attacker-controlled string onto the page is how a login screen becomes an
 * injection surface. The user gets a fixed Persian message and a way back.
 */
export default function AuthCallbackPage(): ReactNode {
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const manager = await getUserManager(readPublicEnv());
        const user = await manager.signinCallback(window.location.href);
        if (cancelled) return;

        // The code and state are still in the address bar at this point.
        // `replace` keeps a one-time authorization code out of the history
        // stack and out of any later `Referer`.
        const state = user?.state as { returnTo?: string } | undefined;
        router.replace(safeReturnTo(state?.returnTo));
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (failed) {
    return (
      <ErrorState
        title="ورود کامل نشد"
        message="پاسخ بازگشتی از سامانهٔ هویت پذیرفته نشد. لطفاً دوباره از ابتدا وارد شوید."
      />
    );
  }

  return (
    <Card>
      <h1 className="text-lg font-bold text-[var(--tx)]">در حال تکمیل ورود…</h1>
      <div className="mt-4">
        <LoadingState rows={1} label="در حال تبادل کد مجوز با سامانهٔ هویت" />
      </div>
    </Card>
  );
}

/**
 * Only a same-origin path is honoured.
 *
 * `returnTo` round-trips through the identity provider as opaque state. A value
 * of `https://elsewhere.example` would turn a successful login into an open
 * redirect, so anything that is not a single-slash relative path is discarded
 * in favour of the dashboard.
 */
function safeReturnTo(candidate: string | undefined): string {
  if (!candidate) return '/';
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/';
  return candidate;
}
