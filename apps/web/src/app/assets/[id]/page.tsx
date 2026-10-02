import { redirect } from 'next/navigation';
import { AppShell, Button, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchDossier, type AssetSummary } from '@/server/assets';
import type { UpdateAssetFormValues } from '@/lib/asset-form-fields';
import { canManageAssets, sealAssetBaseline } from '@/server/asset-commands';
import {
  canChangeAssetStatus,
  canDecommissionAsset,
  sealAssetLifecycleBaseline,
} from '@/server/asset-lifecycle-commands';
import {
  canActivateFrom,
  canDecommissionFrom,
  statusTargetsFrom,
  type AssetLifecycleCommand,
} from '@/lib/asset-lifecycle-fields';
import type { WebSession } from '@/server/session';
import { fetchCurrentUser } from '@/server/identity';
import { FLASH_PARAM } from '@/lib/form-fields';
import { readFlash } from '@/server/flash';
import { mintSubmissionId } from '@/server/submission';
import { PORTAL_NAV } from '@/app/nav';
import { DossierScreen } from './DossierScreen';
import { UpdateAssetForm } from './UpdateAssetForm';
import { LifecycleControls, type LifecycleToken } from './LifecycleControls';

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

/**
 * The lifecycle commands this person may use on this machine as it is now: a
 * role that admits the command **and** a status the transition table allows it
 * from, each with a baseline signed for it at the version and status shown.
 * Both checks are UX — asset-service decides again on every send.
 */
function lifecycleTokens(
  session: WebSession,
  roles: readonly string[],
  asset: AssetSummary & { version: number },
  assetId: string,
): Partial<Record<AssetLifecycleCommand, LifecycleToken>> {
  const offered: AssetLifecycleCommand[] = [];
  if (canChangeAssetStatus(roles)) {
    if (canActivateFrom(asset.status)) offered.push('activate');
    if (statusTargetsFrom(asset.status).length > 0) offered.push('status');
  }
  if (canDecommissionAsset(roles) && canDecommissionFrom(asset.status))
    offered.push('decommission');

  return Object.fromEntries(
    offered.map((command) => [
      command,
      {
        submissionId: mintSubmissionId(session),
        baseline: sealAssetLifecycleBaseline(session, {
          assetId,
          command,
          version: asset.version,
          status: asset.status,
          assetName: asset.name,
        }),
      },
    ]),
  );
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

  const lifecycleSource =
    currentUser.kind === 'USER' && result.kind === 'OK' && result.data.asset.version !== undefined
      ? {
          roles: currentUser.user.effectiveRoles,
          asset: { ...result.data.asset, version: result.data.asset.version },
        }
      : null;
  const tokens = lifecycleSource
    ? lifecycleTokens(session, lifecycleSource.roles, lifecycleSource.asset, id)
    : {};
  const lifecycle =
    lifecycleSource && Object.keys(tokens).length > 0 ? (
      <LifecycleControls
        assetName={lifecycleSource.asset.name}
        status={lifecycleSource.asset.status}
        csrfToken={session.csrfToken}
        tokens={tokens}
      />
    ) : undefined;

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
          [
            'created',
            'updated',
            'conflict',
            'activated',
            'statusChanged',
            'decommissioned',
            'lifecycleConflict',
          ],
        )}
        lifecycle={lifecycle}
        editForm={
          // A decommissioned machine is a historical record: asset-service
          // refuses to edit it, so the form is not drawn.
          manage &&
          result.kind === 'OK' &&
          result.data.asset.version !== undefined &&
          result.data.asset.status !== 'DECOMMISSIONED' ? (
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
