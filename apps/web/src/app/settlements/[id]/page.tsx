import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchSettlement } from '@/server/settlements';
import { PortalSidebar } from '@/app/PortalSidebar';

import { SettlementDetailScreen } from '../SettlementDetailScreen';
import { actingOrganizationLabel, actingScope } from '@/server/session-organization';

/**
 * The `/settlements/[id]` route. No role check here: economic-service answers
 * 404 for a settlement the caller was not party to, exactly as for a missing
 * one, and the screen renders both the same way.
 */
export const dynamic = 'force-dynamic';

export default async function SettlementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/settlements/${id}`)}`);

  const result = await fetchSettlement(session, id);

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
      sidebar={<PortalSidebar session={session} currentHref="/settlements" />}
    >
      <PageHeader title="جزئیات تسویه" description="مبلغ‌ها و طرف‌های این تسویه؛ فقط خواندنی." />
      <div className="mt-2">
        <ButtonLink href="/settlements" tone="quiet">
          بازگشت به فهرست تسویه‌ها
        </ButtonLink>
      </div>
      <div className="mt-4">
        <SettlementDetailScreen result={result} />
      </div>
    </AppShell>
  );
}
