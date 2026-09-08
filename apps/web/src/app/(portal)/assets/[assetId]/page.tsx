import type { ReactNode } from 'react';
import { DossierView } from '@/components/assets/dossier-view';
import { RequireSession } from '@/components/require-session';

/** LIVE — `GET /v1/assets/{id}/dossier` and `/timeline` through the API Gateway. */
export default async function Page({
  params,
}: {
  params: Promise<{ assetId: string }>;
}): Promise<ReactNode> {
  const { assetId } = await params;

  return (
    <RequireSession requireOrganization>
      <DossierView assetId={assetId} />
    </RequireSession>
  );
}
