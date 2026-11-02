import { Alert, Button, ButtonLink, PageHeader } from '@/ui';

/**
 * What a person sees when they are signed in with a session pinned to **no**
 * organization and asked for a page that reads or writes a tenant's data
 * (`server/tenant-gate.ts`, task 118). Nothing of any tenant is drawn or
 * sent: such a session sends no `X-Organization-Id`, and the platform would
 * otherwise answer for whichever organization the account is active in.
 *
 * The person's own pages still work, so the ways on are home and a sign-out —
 * a new sign-in pins the organization the account is active in then.
 */

export const NO_ORGANIZATION_TITLE = 'هیچ سازمانی برای این ورود انتخاب نشده است';

export const NO_ORGANIZATION_TEXT =
  'این صفحه داده‌های یک سازمان را نشان می‌دهد یا تغییر می‌دهد، اما این ورود برای هیچ سازمانی نیست؛ برای همین چیزی خوانده یا فرستاده نشد. اگر عضو سازمانی هستید، از حساب خارج شوید و دوباره وارد شوید تا آن سازمان برای این ورود انتخاب شود.';

export const NO_ORGANIZATION_HOME = 'بازگشت به خانه';

export const NO_ORGANIZATION_LOGOUT = 'خروج از حساب';

export function NoOrganizationScreen({ csrfToken }: { readonly csrfToken: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <PageHeader title={NO_ORGANIZATION_TITLE} />
      <Alert tone="warning">{NO_ORGANIZATION_TEXT}</Alert>
      <ButtonLink href="/" tone="secondary" className="py-3 text-base">
        {NO_ORGANIZATION_HOME}
      </ButtonLink>
      <form method="post" action="/auth/logout">
        <input type="hidden" name="csrf" value={csrfToken} />
        <Button type="submit" className="w-full py-3 text-base">
          {NO_ORGANIZATION_LOGOUT}
        </Button>
      </form>
    </main>
  );
}
