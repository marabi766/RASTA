import type { ReactNode } from 'react';
import { RequireSession } from '@/components/require-session';
import { MaintenanceView } from '@/components/maintenance/maintenance-view';

/** LIVE — `GET /v1/maintenance-schedules/due`, `/v1/maintenance-requests`, `/v1/repair-orders`. */
export default function Page(): ReactNode {
  return (
    <RequireSession requireOrganization>
      <MaintenanceView />
    </RequireSession>
  );
}
