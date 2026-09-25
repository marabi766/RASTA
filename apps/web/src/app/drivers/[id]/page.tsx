import { redirect } from 'next/navigation';
import { AppShell, Button, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { canManageDrivers, fetchDriver, fetchDriverAssignments } from '@/server/drivers';
import { fetchCurrentUser } from '@/server/identity';
import { newSubmissionId } from '@/server/submission';
import { PORTAL_NAV } from '@/app/nav';
import { DriverDetailScreen } from './DriverDetailScreen';

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

  const [result, assignments, currentUser] = await Promise.all([
    fetchDriver(session, id),
    fetchDriverAssignments(session, id),
    fetchCurrentUser(session),
  ]);

  // A failed identity read shows no write form rather than one that might
  // not work — the same fail-closed default `canManageDrivers` documents.
  const manage = currentUser.kind === 'USER' && canManageDrivers(currentUser.user.effectiveRoles);

  return (
    <AppShell
      topBar={
        <TopBar organizationName={session.organizationId ?? 'بدون سازمان فعال'}>
          <form method="post" action="/auth/logout">
            <input type="hidden" name="csrf" value={session.csrfToken} />
            <Button type="submit" tone="secondary">
              خروج
            </Button>
          </form>
        </TopBar>
      }
      sidebar={<Sidebar items={PORTAL_NAV} currentHref="/drivers" />}
    >
      <DriverDetailScreen
        result={result}
        assignments={assignments}
        driverId={id}
        csrfToken={session.csrfToken}
        canManageDrivers={manage}
        submissionIds={{
          update: newSubmissionId(),
          status: newSubmissionId(),
          assign: newSubmissionId(),
          end: newSubmissionId(),
        }}
      />
    </AppShell>
  );
}
