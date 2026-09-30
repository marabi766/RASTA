import { redirect } from 'next/navigation';
import { AppShell, Button, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchAssets, type AssetListQuery } from '@/server/assets';
import { canManageAssets } from '@/server/asset-commands';
import { fetchCurrentUser } from '@/server/identity';
import { newSubmissionId } from '@/server/submission';
import { PORTAL_NAV } from '@/app/nav';
import { ASSET_STATUSES, ASSET_TYPES, oneOf } from '@/lib/asset-fields';
import { AssetsScreen } from './AssetsScreen';
import { RegisterAssetForm } from './RegisterAssetForm';

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
  // `status` and `type` are strict enums on asset-service's side: a value
  // outside them (a stale bookmark, a hand-edited URL) is dropped here rather
  // than sent, where it would turn the whole list into an error page.
  const query: AssetListQuery = {
    status: oneOf(ASSET_STATUSES, one(params.status)),
    type: oneOf(ASSET_TYPES, one(params.type)),
    q: one(params.q),
    cursor: one(params.cursor),
  };

  const [result, currentUser] = await Promise.all([
    fetchAssets(session, query),
    fetchCurrentUser(session),
  ]);

  // A Route Guard as UX, not as security (`docs/16 § ۱۶٫۱۱`): a failed identity
  // read shows no form rather than one that might not work, and asset-service
  // decides again on every submit.
  const manage = currentUser.kind === 'USER' && canManageAssets(currentUser.user.effectiveRoles);

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
      <AssetsScreen
        result={result}
        query={query}
        registerForm={
          manage ? (
            <RegisterAssetForm csrfToken={session.csrfToken} submissionId={newSubmissionId()} />
          ) : undefined
        }
      />
    </AppShell>
  );
}
