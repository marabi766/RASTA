import { redirect } from 'next/navigation';

import {
  AppShell,
  Alert,
  Button,
  EmptyState,
  ErrorState,
  NoAccessState,
  PageHeader,
  Section,
  Sidebar,
  TopBar,
} from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchCurrentUser } from '@/server/identity';
import { fetchOrganization, type Organization, type ReadResult } from '@/server/organizations';
import { fetchMembers, type MemberListQuery } from '@/server/members';
import { newSubmissionId } from '@/server/submission';
import { PORTAL_NAV } from '@/app/nav';

import { MembersScreen } from './MembersScreen';
import { OrganizationProfileForm } from './OrganizationProfileForm';

/**
 * The `/organizations` route — سازمان و اعضا (docs/16 § ۱۶٫۶, role
 * `ORGANIZATION_ADMIN`).
 *
 * The organization this session is acting for, its profile, and its members.
 * **Not** the hierarchy: `docs/16` § ۱۶٫۶ gives that its own `/organizations`
 * in `apps/admin` for `UNION_ADMIN`, and organization-service agrees —
 * `:id/move`, `:id/status` and `:id/policies` all carry `@Roles('UNION_ADMIN')`.
 * `apps/admin` does not exist yet (ADR-058 § ۲), so those live nowhere, which
 * is better than living here under the wrong role.
 *
 * **No role check here**, for the reason `/usage` and `/drivers` have none:
 * hiding a control is not a security control (`docs/16` § ۱۶٫۱۱). Both
 * services decide, and a refusal from either is rendered as an outcome.
 *
 * Three reads, in parallel — none depends on another, and doing them in
 * sequence would make the page as slow as their sum.
 */
export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * What a successful write left behind.
 *
 * The action redirects and the form instance is gone, so the confirmation
 * lives in the query — which also means a person can link somebody to this
 * page without carrying a stale "saved" banner along, because they would have
 * to copy the flag deliberately.
 */
function Confirmation({ saved, revoked }: { saved?: string; revoked?: string }) {
  if (revoked) return <Alert tone="success">عضویت باطل شد.</Alert>;
  if (saved === 'roles') return <Alert tone="success">نقش‌های عضو ذخیره شد.</Alert>;
  if (saved === 'profile') return <Alert tone="success">مشخصات سازمان ذخیره شد.</Alert>;
  return null;
}

/**
 * The profile section's four outcomes, kept apart.
 *
 * A refusal and an outage are different things and read differently to the
 * person: one says the door is closed, the other says come back. Collapsing
 * them into one "could not load" — and inventing a correlation id for the
 * half that has none — would lose that.
 *
 * The members list below renders either way: an administrator who cannot see
 * the profile can still have work to do with the people.
 */
function OrganizationProfile({
  result,
  csrfToken,
  submissionId,
}: {
  result: ReadResult<Organization> | null;
  csrfToken: string;
  submissionId: string;
}) {
  if (result === null || result.kind === 'NOT_FOUND') {
    return <EmptyState title="سازمانی یافت نشد" description="این نشست سازمان فعالی ندارد." />;
  }

  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="مشخصات این سازمان در اختیار شما نیست." />;
  }

  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="مشخصات سازمان خوانده نشد. اعضا در ادامه همچنان نمایش داده می‌شوند."
        correlationId={result.correlationId}
      />
    );
  }

  return (
    <OrganizationProfileForm
      organizationId={result.data.id}
      csrfToken={csrfToken}
      submissionId={submissionId}
      initialValues={{
        name: result.data.name,
        shortName: result.data.shortName ?? '',
        externalCode: result.data.externalCode ?? '',
      }}
    />
  );
}

export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/organizations');

  const params = await searchParams;
  const query: MemberListQuery = {
    q: one(params.q),
    role: one(params.role),
    cursor: one(params.cursor),
  };

  const organizationId = session.organizationId;

  const [currentUser, organization, members] = await Promise.all([
    fetchCurrentUser(session),
    organizationId ? fetchOrganization(session, organizationId) : null,
    fetchMembers(session, query),
  ]);

  // The caller's own ladder, as identity-service computed it. Empty when the
  // read failed, which renders a picker that offers nothing rather than one
  // that guesses — the form says so in words.
  const grantableRoles = currentUser.kind === 'USER' ? currentUser.user.grantableRoles : [];
  const submissionId = newSubmissionId();

  return (
    <AppShell
      topBar={
        <TopBar organizationName={organizationId ?? 'بدون سازمان فعال'}>
          <form method="post" action="/auth/logout">
            <input type="hidden" name="csrf" value={session.csrfToken} />
            <Button type="submit" tone="secondary">
              خروج
            </Button>
          </form>
        </TopBar>
      }
      sidebar={<Sidebar items={PORTAL_NAV} currentHref="/organizations" />}
    >
      <PageHeader
        title="سازمان و اعضا"
        description="مشخصات این سازمان، اعضای آن، و نقشی که هر عضو در آن دارد."
      />

      <Confirmation saved={one(params.saved)} revoked={one(params.revoked)} />

      {organizationId === null ? (
        <Alert tone="warning">
          این نشست سازمان فعالی ندارد، پس چیزی برای مدیریت نیست. اگر عضو بیش از یک سازمانید، یکی را
          انتخاب کنید و بازگردید.
        </Alert>
      ) : (
        <Section headingId="organization-profile" title="مشخصات سازمان" className="mt-4">
          <OrganizationProfile
            result={organization}
            csrfToken={session.csrfToken}
            submissionId={submissionId}
          />
        </Section>
      )}

      <div className="mt-4">
        <MembersScreen
          result={members}
          query={query}
          grantableRoles={grantableRoles}
          csrfToken={session.csrfToken}
          submissionId={submissionId}
        />
      </div>
    </AppShell>
  );
}
