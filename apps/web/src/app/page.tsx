import { redirect } from 'next/navigation';
import {
  Alert,
  AppShell,
  Button,
  ErrorState,
  Grid,
  Identifier,
  PageHeader,
  Section,
  Sidebar,
  StatusBadge,
  TopBar,
} from '@/ui';
import { currentSession } from '@/server/current-session';
import { activeMembership, displayName, fetchCurrentUser } from '@/server/identity';

/**
 * The dashboard (docs/16 § 16.6, `/`).
 *
 * The first screen in this portal that shows something real. It replaces the
 * placeholder EXP-001 left here, which said in its own comment that the domain
 * screens belonged to EXP-002 and that a page looking finished while nothing
 * behind it worked would be a claim this repository does not make.
 *
 * Everything on it is fetched on the server, through the gateway, with the
 * session's own token. No token and no fetch ever happens in the browser
 * (ADR-059).
 *
 * ## What it deliberately still does not do
 *
 * It does not summarise assets, work orders or notifications. Those screens
 * are the rest of `EXP-002` and the stories after it, and a dashboard tile
 * with a plausible number behind it would be exactly the claim the placeholder
 * refused to make. What it shows is what is true today: who you are, which
 * organization you are acting for, and what that organization has granted you.
 */
export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/', label: 'خانه' },
  { href: '/assets', label: 'ماشین‌آلات' },
  { href: '/maintenance', label: 'نگهداری' },
  { href: '/notifications', label: 'اعلان‌ها' },
];

export default async function HomePage() {
  const session = await currentSession();
  // Not a guard in the security sense — the gateway and every service decide
  // that independently. This is so a signed-out person sees a way in instead
  // of an error (docs/16 § 16.11).
  if (!session) redirect('/login');

  const result = await fetchCurrentUser(session);

  return (
    <AppShell
      topBar={
        <TopBar organizationName={session.organizationId ?? 'بدون سازمان فعال'}>
          <form method="post" action="/auth/logout">
            {/* ADR-059 § 5: SameSite=Strict plus a token, because "almost
                always" is not a guarantee for a state change. */}
            <input type="hidden" name="csrf" value={session.csrfToken} />
            <Button type="submit" tone="secondary">
              خروج
            </Button>
          </form>
        </TopBar>
      }
      sidebar={<Sidebar items={NAV} currentHref="/" />}
    >
      <PageHeader title="خانه" description="وضعیت حساب و سازمان فعال شما." />

      {result.kind === 'UNAVAILABLE' ? (
        <ErrorState correlationId={result.correlationId} code={`UPSTREAM_${result.status}`} />
      ) : null}

      {result.kind === 'MALFORMED' ? (
        <ErrorState correlationId={result.correlationId} code="CONTRACT_MISMATCH" />
      ) : null}

      {result.kind === 'USER' ? (
        <>
          <Section headingId="account" title="حساب شما">
            <Grid columns={2}>
              <dl className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <dt className="text-sm text-content-subtle">نام</dt>
                  <dd className="text-xl text-content">{displayName(result.user)}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-sm text-content-subtle">نام کاربری</dt>
                  <dd className="text-content">
                    <Identifier>{result.user.username}</Identifier>
                  </dd>
                </div>
              </dl>
              <dl className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <dt className="text-sm text-content-subtle">وضعیت حساب</dt>
                  <dd>
                    <StatusBadge status={result.user.status} />
                  </dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-sm text-content-subtle">سازمان فعال</dt>
                  <dd className="text-content">
                    {result.user.activeOrganizationId ? (
                      <Identifier>{result.user.activeOrganizationId}</Identifier>
                    ) : (
                      'انتخاب نشده'
                    )}
                  </dd>
                </div>
              </dl>
            </Grid>
          </Section>

          <Section headingId="roles" title="دسترسی شما در این سازمان">
            {result.user.effectiveRoles.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {result.user.effectiveRoles.map((role) => (
                  <li key={role}>
                    <Identifier>{role}</Identifier>
                  </li>
                ))}
              </ul>
            ) : (
              <Alert tone="info" title="نقشی در این سازمان ثبت نشده">
                تا وقتی مدیر سازمان نقشی به شما ندهد، صفحه‌های عملیاتی چیزی نشان نمی‌دهند.
              </Alert>
            )}
            <p className="mt-4 text-sm text-content-muted">
              {activeMembership(result.user)
                ? 'این فهرست از سرویس هویت می‌آید و مرجع مجوزدهی نیست؛ هر درخواست جداگانه در سرور بررسی می‌شود.'
                : 'عضویتی برای سازمان فعال یافت نشد.'}
            </p>
          </Section>
        </>
      ) : null}

      <Alert tone="info" title="صفحه‌های عملیاتی در راه‌اند">
        فهرست ماشین‌آلات، پروندهٔ دارایی و نگهداری در همین داستان و داستان‌های بعدی اضافه می‌شوند.
        این صفحه فقط چیزی را نشان می‌دهد که امروز واقعاً پشتش داده هست.
      </Alert>
    </AppShell>
  );
}
