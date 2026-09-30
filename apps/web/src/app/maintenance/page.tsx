import { redirect } from 'next/navigation';
import { AppShell, Button, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchMaintenanceRequests, type MaintenanceRequestListQuery } from '@/server/maintenance';
import { canReportMaintenance } from '@/server/maintenance-commands';
import { fetchCurrentUser } from '@/server/identity';
import { newSubmissionId } from '@/server/submission';
import { PORTAL_NAV } from '@/app/nav';
import { MaintenanceScreen } from './MaintenanceScreen';
import { ReportRequestForm } from './ReportRequestForm';

/**
 * The `/maintenance` route (docs/16 § 16.6).
 *
 * Reads the session, narrows the query string to the filters the service
 * accepts, fetches on the server through the gateway, and hands the result to
 * a component that does no I/O — the same shape as `/assets` (PR #67).
 */
export const dynamic = 'force-dynamic';

/** One value, or nothing. A repeated parameter is a caller error, not a list. */
function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default async function MaintenancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/maintenance');

  const params = await searchParams;
  const query: MaintenanceRequestListQuery = {
    status: one(params.status),
    type: one(params.type),
    severity: one(params.severity),
    cursor: one(params.cursor),
  };

  const [result, currentUser] = await Promise.all([
    fetchMaintenanceRequests(session, query),
    fetchCurrentUser(session),
  ]);

  // A Route Guard as UX, not as security (`docs/16 § ۱۶٫۱۱`): a failed identity
  // read shows no form rather than one that might not work, and
  // maintenance-service decides again on every submit.
  const canReport =
    currentUser.kind === 'USER' && canReportMaintenance(currentUser.user.effectiveRoles);

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
      sidebar={<Sidebar items={PORTAL_NAV} currentHref="/maintenance" />}
    >
      <MaintenanceScreen
        result={result}
        query={query}
        reportForm={
          canReport ? (
            <ReportRequestForm
              csrfToken={session.csrfToken}
              submissionId={newSubmissionId()}
              initialAssetId={one(params.assetId)}
            />
          ) : undefined
        }
      />
    </AppShell>
  );
}
