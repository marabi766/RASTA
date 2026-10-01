import { redirect } from 'next/navigation';
import { AppShell, Button, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchDossier, type AssetSummary } from '@/server/assets';
import type { UpdateAssetFormValues } from '@/lib/asset-form-fields';
import { canManageAssets, sealAssetBaseline } from '@/server/asset-commands';
import { fetchCurrentUser } from '@/server/identity';
import { FLASH_PARAM } from '@/lib/form-fields';
import { readFlash } from '@/server/flash';
import { mintSubmissionId } from '@/server/submission';
import { PORTAL_NAV } from '@/app/nav';
import { DossierScreen } from './DossierScreen';
import { UpdateAssetForm } from './UpdateAssetForm';

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

/** The machine's current record as the edit form's text — the one source for what it shows and what it signs. */
function editValuesOf(asset: AssetSummary): UpdateAssetFormValues {
  return {
    name: asset.name,
    assetTag: asset.assetTag ?? '',
    manufacturer: asset.manufacturer ?? '',
    model: asset.model ?? '',
    manufactureYear: asset.manufactureYear === null ? '' : String(asset.manufactureYear),
  };
}

export default async function AssetDossierPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/assets/${id}`)}`);

  const [result, currentUser] = await Promise.all([
    fetchDossier(session, id),
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
      <DossierScreen
        result={result}
        assetId={id}
        notice={readFlash(
          session,
          typeof query[FLASH_PARAM] === 'string' ? query[FLASH_PARAM] : undefined,
          id,
          ['created', 'updated', 'conflict'],
        )}
        editForm={
          manage && result.kind === 'OK' && result.data.asset.version !== undefined ? (
            <UpdateAssetForm
              assetId={id}
              csrfToken={session.csrfToken}
              submissionId={mintSubmissionId(session)}
              baseline={sealAssetBaseline(
                session,
                id,
                result.data.asset.version,
                editValuesOf(result.data.asset),
              )}
              initialValues={editValuesOf(result.data.asset)}
            />
          ) : undefined
        }
      />
    </AppShell>
  );
}
