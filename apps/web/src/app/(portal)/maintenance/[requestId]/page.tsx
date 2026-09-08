import type { ReactNode } from 'react';
import { MaintenanceRequestDetailView } from '@/components/maintenance/request-detail-view';
import { RequireSession } from '@/components/require-session';

/** LIVE — `GET /v1/maintenance-requests/{id}` through the API Gateway. */
export default async function Page({
  params,
}: {
  params: Promise<{ requestId: string }>;
}): Promise<ReactNode> {
  const { requestId } = await params;

  return (
    <RequireSession requireOrganization>
      <MaintenanceRequestDetailView requestId={requestId} />
    </RequireSession>
  );
}
