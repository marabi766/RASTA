import { redirect } from 'next/navigation';
import { AppShell, Button, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { canManageDrivers, fetchDriver, fetchDriverAssignments } from '@/server/drivers';
import { tokenWriteRoles } from '@/server/realm-roles';
import { mintSubmissionId } from '@/server/submission';
import { PortalSidebar } from '@/app/PortalSidebar';
import { DriverDetailScreen } from './DriverDetailScreen';
import { actingOrganizationLabel, actingScope } from '@/server/session-organization';

/**
 * The `/drivers/[id]` route (docs/16 § ۱۶٫۶).
 *
 * The id is whatever was in the URL and is treated as such: it is encoded
 * into the gateway path rather than interpolated, and it is never used for a
 * decision here — fleet-service answers `404` for an id in another tenant,
 * which is the answer this screen renders (`/assets/[id]`, PR #67, and
 * `/maintenance/[id]`, PR #73, carry the same rule).
 *
 * Four submission ids are minted here, one per form on the page, because a
 * retry of one form must not be mistaken for a retry of another — each
 * mints and reuses its own (`UpdateDriverForm`, `ChangeStatusForm`,
 * `AssignDriverForm`, `EndAssignmentForm`).
 */
export const dynamic = 'force-dynamic';

export default async function DriverDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/drivers/${id}`)}`);
  // What the forms are offered on: the access token's own roles (`tokenWriteRoles`),
  // the set the service decides on — not `/v1/users/me`, which runs ahead of the
  // token until it is refreshed.
  const roles = tokenWriteRoles(session.accessToken);

  const [result, assignments] = await Promise.all([
    fetchDriver(session, id),
    fetchDriverAssignments(session, id),
  ]);

  // A token whose roles cannot be read shows no write form rather than one that might
  // not work — the same fail-closed default `canManageDrivers` documents.
  const manage = roles !== null && canManageDrivers(roles);

  return (
    <AppShell
      key={actingScope(session)}
      topBar={
        <TopBar organizationName={actingOrganizationLabel(session)}>
          <form method="post" action="/auth/logout">
            <input type="hidden" name="csrf" value={session.csrfToken} />
            <Button type="submit" tone="secondary">
              خروج
            </Button>
          </form>
        </TopBar>
      }
      sidebar={<PortalSidebar session={session} currentHref="/drivers" />}
    >
      <DriverDetailScreen
        result={result}
        assignments={assignments}
        driverId={id}
        csrfToken={session.csrfToken}
        canManageDrivers={manage}
        submissionIds={{
          update: mintSubmissionId(session),
          status: mintSubmissionId(session),
          assign: mintSubmissionId(session),
          end: mintSubmissionId(session),
        }}
      />
    </AppShell>
  );
}
