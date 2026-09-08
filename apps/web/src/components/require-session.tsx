'use client';

import type { ReactNode } from 'react';
import { useSession } from '@/lib/auth/session';
import { Button, Card, ErrorState, LoadingState } from './ui/primitives';

/**
 * The gate in front of every screen that reads tenant data.
 *
 * **This is user experience, not authorization.** docs/16 § 16.11 states the
 * rule directly: hiding a control in the browser is not a security control, and
 * the server decides independently every time. What this component prevents is
 * a signed-out user watching a page render skeletons and then fail with a 401
 * they cannot act on.
 *
 * `requireOrganization` covers the second half of the same problem. Most reads
 * are tenant-scoped, and a request with no `X-Organization-Id` from a user who
 * belongs to three organizations is ambiguous — the gateway resolves it to the
 * token's active organization or refuses. Asking first is clearer than letting
 * the platform guess.
 */
export function RequireSession({
  children,
  requireOrganization = false,
}: {
  children: ReactNode;
  requireOrganization?: boolean;
}): ReactNode {
  const { status, organizationId, claims, configurationIssues, signIn } = useSession();

  if (status === 'loading') {
    return <LoadingState rows={3} label="در حال بررسی نشست کاربر" />;
  }

  if (status === 'unavailable') {
    return (
      <ErrorState
        title="پیکربندی رابط کاربری کامل نیست"
        message={
          'این نسخه بدون آدرس درگاه API و مشخصات Keycloak نمی‌تواند کار کند. ' +
          `موارد ناقص: ${configurationIssues.join('، ')}`
        }
      />
    );
  }

  if (status === 'anonymous') {
    return (
      <Card>
        <h2 className="text-lg font-bold text-[var(--tx)]">برای ادامه وارد شوید</h2>
        <p className="mt-2 text-sm text-[var(--tx2)]">
          ورود از راه Keycloak و با جریان استاندارد Authorization Code + PKCE انجام می‌شود. رمز عبور
          شما هرگز وارد این برنامه نمی‌شود.
        </p>
        <div className="mt-4">
          <Button
            onClick={() => {
              void signIn();
            }}
          >
            ورود با حساب سازمانی
          </Button>
        </div>
      </Card>
    );
  }

  if (requireOrganization && !organizationId) {
    const count = claims?.organizationIds.length ?? 0;

    return (
      <Card className="border-[var(--warn)]">
        <h2 className="text-lg font-bold text-[var(--warn-tx)]">سازمان فعال را انتخاب کنید</h2>
        <p className="mt-2 text-sm text-[var(--tx2)]">
          {count === 0
            ? 'توکن شما هیچ عضویت سازمانی اعلام نکرده است. تا زمانی که عضویت در سرویس هویت ثبت نشود، دادهٔ سازمانی قابل خواندن نیست.'
            : 'این نما به سازمان محدود است. از نوار بالا سازمان فعال را انتخاب کنید تا درخواست‌ها با همان سازمان ارسال شوند.'}
        </p>
      </Card>
    );
  }

  return <>{children}</>;
}
