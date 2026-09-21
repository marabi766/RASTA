import { redirect } from 'next/navigation';
import { AppShell, Button, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchDossier } from '@/server/assets';
import { PORTAL_NAV } from '@/app/nav';
import { DossierScreen } from './DossierScreen';

/**
 * The `/assets/[id]` route.
 *
 * The id is whatever was in the URL and is treated as such: it is encoded into
 * the gateway path rather than interpolated, and it is never used for a
 * decision here. asset-service answers `404` for an id in another tenant,
 * which is the answer this screen renders — the portal does not need to know
 * the difference, and could not be trusted with it if it did.
 */
export const dynamic = 'force-dynamic';

export default async function AssetDossierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/assets/${id}`)}`);

  const result = await fetchDossier(session, id);

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
      <DossierScreen result={result} assetId={id} />
    </AppShell>
  );
}
