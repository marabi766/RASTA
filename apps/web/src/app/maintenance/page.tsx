import { redirect } from 'next/navigation';
import { AppShell, Button, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchMaintenanceRequests, type MaintenanceRequestListQuery } from '@/server/maintenance';
import { canReportMaintenance } from '@/server/maintenance-commands';
import { tokenWriteRoles } from '@/server/realm-roles';
import { mintSubmissionId } from '@/server/submission';
import { PortalSidebar } from '@/app/PortalSidebar';
import { MaintenanceScreen } from './MaintenanceScreen';
import { ReportRequestForm } from './ReportRequestForm';
import { actingOrganizationLabel, actingScope } from '@/server/session-organization';
import { pageContext, pageParams } from '@/server/page-context';

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
  // What the forms are offered on: the access token's own roles (`tokenWriteRoles`),
  // the set the service decides on — not `/v1/users/me`, which runs ahead of the
  // token until it is refreshed.
  const roles = tokenWriteRoles(session.accessToken);

  const params = await pageParams(session, searchParams);
  const query: MaintenanceRequestListQuery = {
    status: one(params.status),
    type: one(params.type),
    severity: one(params.severity),
    cursor: one(params.cursor),
  };

  const result = await fetchMaintenanceRequests(session, query);

  // A Route Guard as UX, not as security (`docs/16 § ۱۶٫۱۱`): a token whose roles
  // cannot be read shows no form rather than one that might not work, and
  // maintenance-service decides again on every submit.
  const canReport = roles !== null && canReportMaintenance(roles);

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
      sidebar={<PortalSidebar session={session} currentHref="/maintenance" />}
    >
      <MaintenanceScreen
        result={result}
        query={{ ...query, context: pageContext(session) }}
        reportForm={
          canReport ? (
            <ReportRequestForm
              csrfToken={session.csrfToken}
              submissionId={mintSubmissionId(session)}
              initialAssetId={one(params.assetId)}
            />
          ) : undefined
        }
      />
    </AppShell>
  );
}
