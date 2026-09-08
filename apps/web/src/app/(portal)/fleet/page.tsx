import type { ReactNode } from 'react';
import { RequireSession } from '@/components/require-session';
import { FleetView } from '@/components/fleet/fleet-view';

/** LIVE — `GET /v1/fleet/availability`, `/utilization`, `/v1/drivers`, `/v1/assignments`, `/v1/usage-records`. */
export default function Page(): ReactNode {
  return (
    <RequireSession requireOrganization>
      <FleetView />
    </RequireSession>
  );
}
