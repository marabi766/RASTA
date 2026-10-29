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
  StatusBadge,
  TopBar,
} from '@/ui';
import { currentSession } from '@/server/current-session';
import { roleLabel, userStatusLabel } from '@/lib/organization-fields';
import { displayName, fetchCurrentUser, membershipIn } from '@/server/identity';
import { PortalSidebar } from '@/app/PortalSidebar';
import {
  actingOrganizationId,
  actingOrganizationLabel,
  actingScope,
} from '@/server/session-organization';

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

export default async function HomePage() {
  const session = await currentSession();
  // Not a guard in the security sense — the gateway and every service decide
  // that independently. This is so a signed-out person sees a way in instead
  // of an error (docs/16 § 16.11).
  if (!session) redirect('/login');

  const result = await fetchCurrentUser(session);

  // The organisation's name when the page already has it (the membership the
  // user is acting under); the code stays as secondary text, and is all the
  // header has before — or without — that read. Acting under: the access
  // token's organization, the one every request acts for — not identity's
  // `activeOrganizationId`, which a switch moves before the token follows.
  const actingOrganization = actingOrganizationId(session);
  const membership =
    result.kind === 'USER' ? membershipIn(result.user, actingOrganization) : undefined;
  const organizationName = membership?.organizationName ?? null;

  return (
    <AppShell
      key={actingScope(session)}
      topBar={
        <TopBar organizationName={organizationName ?? actingOrganizationLabel(session)}>
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
      sidebar={<PortalSidebar session={session} currentHref="/" />}
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
                    <StatusBadge
                      status={result.user.status}
                      label={userStatusLabel(result.user.status)}
                    />
                  </dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-sm text-content-subtle">سازمان فعال</dt>
                  <dd className="text-content">
                    {actingOrganization ? (
                      organizationName ? (
                        <>
                          <span className="text-xl">{organizationName}</span>
                          <span className="ms-2 text-sm text-content-muted">
                            کد <Identifier>{actingOrganization}</Identifier>
                          </span>
                        </>
                      ) : (
                        <Identifier>{actingOrganization}</Identifier>
                      )
                    ) : (
                      'انتخاب نشده'
                    )}
                  </dd>
                </div>
              </dl>
            </Grid>
          </Section>

          <Section headingId="roles" title="دسترسی شما در این سازمان">
            {/* The acting membership's roles: identity's `effectiveRoles` are
                its active organization's, which may not be this one yet. */}
            {(membership?.roles ?? []).length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {(membership?.roles ?? []).map((role) => (
                  <li key={role}>
                    {/* The Persian name; the code (a closed Latin vocabulary) is
                        what the service authorises on and is not for the reader.
                        A role this portal has no name for yet shows as sent. */}
                    <span className="inline-block rounded-md bg-muted-surface px-2 py-1 text-sm text-content">
                      {roleLabel(role)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Alert tone="info" title="نقشی در این سازمان ثبت نشده">
                تا وقتی مدیر سازمان نقشی به شما ندهد، صفحه‌های عملیاتی چیزی نشان نمی‌دهند.
              </Alert>
            )}
            <p className="mt-4 text-sm text-content-muted">
              {membership
                ? 'این فهرست از سرویس هویت می‌آید و مرجع مجوزدهی نیست؛ هر درخواست جداگانه در سرور بررسی می‌شود.'
                : 'عضویتی برای سازمان فعال یافت نشد.'}
            </p>
          </Section>
        </>
      ) : null}
    </AppShell>
  );
}
