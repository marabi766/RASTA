import { Alert, Button, ButtonLink, PageHeader } from '@/ui';

/**
 * What a person sees when they are signed in but the portal can tell no
 * organization their access token acts for — most often a token with no role
 * in the organization it names (PR 405 review 2, F3). Tenant access stays
 * closed (`readSession()` refuses the session), and so this page shows nothing
 * of any tenant: no organization, no name, no menu, no token. It is a plain
 * function of the CSRF token its logout form needs.
 *
 * Signing in again would only bring the same identity back through the
 * provider's single sign-on, so the two ways out are a logout — which also
 * ends the provider's session (`/auth/logout`) — and a sign-in that asks for
 * credentials again, for another account (`prompt=login`).
 */

export const RECOVERY_TITLE = 'این ورود به هیچ سازمانی راه نمی‌دهد';

export const RECOVERY_TEXT =
  'با حسابی وارد شده‌اید که سامانه‌ی احراز هویت برای آن سازمانی با نقش معتبر نفرستاده است؛ برای همین هیچ داده‌ای از هیچ سازمانی نشان داده نمی‌شود. اگر باید به سازمانی دسترسی داشته باشید، از مدیر آن سازمان بخواهید نقش شما را بررسی کند. تا آن وقت می‌توانید از این حساب خارج شوید یا با حساب دیگری وارد شوید.';

export const RECOVERY_LOGOUT = 'خروج از این حساب';

export const RECOVERY_SWITCH = 'ورود با حساب دیگر';

/** The sign-in that asks for credentials again (`app/auth/login/route.ts`). */
export const SWITCH_ACCOUNT_HREF = '/auth/login?prompt=login';

export function RecoveryScreen({ csrfToken }: { readonly csrfToken: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <PageHeader title={RECOVERY_TITLE} />
      <Alert tone="warning">{RECOVERY_TEXT}</Alert>
      <form method="post" action="/auth/logout">
        <input type="hidden" name="csrf" value={csrfToken} />
        <Button type="submit" className="w-full py-3 text-base">
          {RECOVERY_LOGOUT}
        </Button>
      </form>
      <ButtonLink href={SWITCH_ACCOUNT_HREF} tone="secondary" className="py-3 text-base">
        {RECOVERY_SWITCH}
      </ButtonLink>
    </main>
  );
}
