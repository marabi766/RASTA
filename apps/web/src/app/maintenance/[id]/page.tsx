import { redirect } from 'next/navigation';
import { AppShell, Button, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchMaintenanceRequest } from '@/server/maintenance';
import { PORTAL_NAV } from '@/app/nav';
import { RequestDetailScreen } from './RequestDetailScreen';

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
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/maintenance/${id}`)}`);

  const result = await fetchMaintenanceRequest(session, id);

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
      <RequestDetailScreen result={result} requestId={id} />
    </AppShell>
  );
}
