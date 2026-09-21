import { redirect } from 'next/navigation';
import { AppShell, Button, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchAssets, type AssetListQuery } from '@/server/assets';
import { PORTAL_NAV } from '@/app/nav';
import { AssetsScreen } from './AssetsScreen';

/**
 * The `/assets` route.
 *
 * Reads the session, narrows the query string to the filters the service
 * accepts, fetches on the server through the gateway, and hands the result to
 * a component that does no I/O.
 */
export const dynamic = 'force-dynamic';

/** One value, or nothing. A repeated parameter is a caller error, not a list. */
function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/assets');

  const params = await searchParams;
  const query: AssetListQuery = {
    status: one(params.status),
    type: one(params.type),
    q: one(params.q),
    cursor: one(params.cursor),
  };

  const result = await fetchAssets(session, query);

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
      <AssetsScreen result={result} query={query} />
    </AppShell>
  );
}
