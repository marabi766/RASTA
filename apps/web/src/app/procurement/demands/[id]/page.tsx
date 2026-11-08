import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { DEMAND_NOTICES } from '@/lib/demand-commands';
import { FLASH_PARAM } from '@/lib/form-fields';
import { withContext } from '@/lib/page-context';
import { currentSession } from '@/server/current-session';
import { fetchDemand, fetchDemandAggregation } from '@/server/demands';
import { readFlash } from '@/server/flash';
import { pageContext, pageParams } from '@/server/page-context';
import { actingOrganizationLabel, actingScope } from '@/server/session-organization';
import { PortalSidebar } from '@/app/PortalSidebar';

import { DemandDetailScreen } from './DemandDetailScreen';

/**
 * The `/procurement/demands/[id]` route — one demand and the window it joined.
 *
 * **No role check on the read**: procurement-service decides, and another
 * organization's demand is `404`, rendered as absent (`server/demands.ts`
 * refuses to render one even if it were answered).
 */
export const dynamic = 'force-dynamic';

export default async function DemandPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const session = await currentSession();
  if (!session) {
    redirect(`/login?returnTo=${encodeURIComponent(`/procurement/demands/${id}`)}`);
  }
  const query = await pageParams(session, searchParams);

  const result = await fetchDemand(session, id);
  const aggregation =
    result.kind === 'OK' ? await fetchDemandAggregation(session, result.data) : null;
  const flash = query[FLASH_PARAM];

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
      sidebar={<PortalSidebar session={session} currentHref="/procurement/demands" />}
    >
      <PageHeader
        title="نیاز تدارکات"
        description="وضعیت نیاز و پنجره تجمیعی که به آن پیوسته است."
      />
      <div className="mt-2">
        <ButtonLink href={withContext(pageContext(session), '/procurement/demands')} tone="quiet">
          بازگشت به فهرست نیازها
        </ButtonLink>
      </div>
      <div className="mt-4">
        <DemandDetailScreen
          result={result}
          aggregation={aggregation}
          notice={readFlash(
            session,
            typeof flash === 'string' ? flash : undefined,
            id,
            DEMAND_NOTICES,
          )}
        />
      </div>
    </AppShell>
  );
}
