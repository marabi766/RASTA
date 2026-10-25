import { redirect } from 'next/navigation';

import { AppShell, Button, PageHeader, TopBar } from '@/ui';
import { isSettlementView } from '@/lib/settlement-fields';
import { currentSession } from '@/server/current-session';
import { fetchSettlements, type SettlementListQuery } from '@/server/settlements';
import { PortalSidebar } from '@/app/PortalSidebar';

import { SettlementsScreen } from './SettlementsScreen';
import { actingOrganizationLabel, actingScope } from '@/server/session-organization';
import { pageContext, pageParams } from '@/server/page-context';

/**
 * The `/settlements` route — تسویه‌ها (docs/16 § ۱۶٫۶), read-only.
 *
 * **No role check here**, like every portal route: economic-service decides
 * who may read settlements, and a refusal is rendered as an outcome. The
 * navigation entry is gated by role for convenience only (`portal-nav.ts`).
 */
export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default async function SettlementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/settlements');

  const params = await pageParams(session, searchParams);
  const view = one(params.view);
  const query: SettlementListQuery = {
    view: isSettlementView(view) ? view : 'PAID',
    cursor: one(params.cursor),
  };

  const result = await fetchSettlements(session, query);

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
      <PageHeader
        title="تسویه‌ها"
        description="تسویه‌هایی که این سازمان پرداخت کرده یا دریافت کرده است؛ فقط خواندنی."
      />
      <div className="mt-4">
        <SettlementsScreen result={result} query={{ ...query, context: pageContext(session) }} />
      </div>
    </AppShell>
  );
}
