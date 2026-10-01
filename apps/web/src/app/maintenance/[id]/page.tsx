import { redirect } from 'next/navigation';
import { AppShell, Button, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchCurrentUser } from '@/server/identity';
import { fetchMaintenanceRequest } from '@/server/maintenance';
import { canManageMaintenance } from '@/server/maintenance-commands';
import { mintSubmissionId } from '@/server/submission';
import { FLASH_PARAM } from '@/lib/form-fields';
import { REQUEST_COMMAND_NOTICES } from '@/lib/maintenance-fields';
import { readFlash } from '@/server/flash';
import { PORTAL_NAV } from '@/app/nav';
import { RequestDetailScreen } from './RequestDetailScreen';
import { ApproveRequestForm, AssignWorkshopForm, CancelRequestForm } from './RequestCommandForms';

/**
 * The `/maintenance/[id]` route (docs/16 § 16.6).
 *
 * The id is whatever was in the URL and is treated as such: it is encoded
 * into the gateway path rather than interpolated, and it is never used for a
 * decision here. maintenance-service answers `404` for an id in another
 * tenant, which is the answer this screen renders — the portal does not need
 * to know the difference, and could not be trusted with it if it did
 * (`/assets/[id]`, PR #67, carries the same rule).
 */
export const dynamic = 'force-dynamic';

export default async function MaintenanceRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/maintenance/${id}`)}`);

  const [result, currentUser] = await Promise.all([
    fetchMaintenanceRequest(session, id),
    fetchCurrentUser(session),
  ]);

  // A Route Guard as UX, not as security (`docs/16 § ۱۶٫۱۱`): a failed identity
  // read shows no command rather than one that might not work, and
  // maintenance-service decides again on every submit.
  const canManage =
    currentUser.kind === 'USER' && canManageMaintenance(currentUser.user.effectiveRoles);

  const identity = () => ({
    csrfToken: session.csrfToken,
    // One reference per form, so two forms never share an id.
    submissionId: mintSubmissionId(session),
    requestId: id,
  });

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
      <RequestDetailScreen
        result={result}
        requestId={id}
        notice={readFlash(
          session,
          typeof query[FLASH_PARAM] === 'string' ? query[FLASH_PARAM] : undefined,
          id,
          ['created', ...REQUEST_COMMAND_NOTICES],
        )}
        commandForms={
          canManage && result.kind === 'OK'
            ? {
                assign: <AssignWorkshopForm {...identity()} />,
                approve: (
                  <ApproveRequestForm {...identity()} totalCostMinor={result.data.totalCostMinor} />
                ),
                cancel: <CancelRequestForm {...identity()} />,
              }
            : undefined
        }
      />
    </AppShell>
  );
}
