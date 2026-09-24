import { redirect } from 'next/navigation';
import { AppShell, Button, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchAssetTimeline, type AssetTimelineQuery } from '@/server/assets';
import { PORTAL_NAV } from '@/app/nav';
import { TimelineScreen } from './TimelineScreen';

/**
 * The `/assets/[id]/timeline` route — تاریخچهٔ دارایی (docs/16 § ۱۶٫۶, role
 * `FLEET_MANAGER`).
 *
 * Reached only from `/assets/[id]`'s "recent activity" section, so it carries
 * no `nav.ts` entry — a sidebar link to a screen nobody navigates to directly
 * would be a route the document does not map (`nav.ts`'s own rule).
 *
 * **No role check here**, matching every other read screen in this portal:
 * hiding a control is not a security control (`docs/16 § ۱۶٫۱۱`).
 * asset-service decides who may read this asset's history; a refusal from it
 * is rendered as an outcome, not guarded against a second time here.
 */
export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default async function AssetTimelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;

  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/assets/${id}/timeline`)}`);

  const search = await searchParams;
  const query: AssetTimelineQuery = {
    category: one(search.category),
    cursor: one(search.cursor),
  };

  const result = await fetchAssetTimeline(session, id, query);

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
      sidebar={<Sidebar items={PORTAL_NAV} currentHref="/assets" />}
    >
      <TimelineScreen result={result} assetId={id} query={query} />
    </AppShell>
  );
}
