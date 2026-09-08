import type { ReactNode } from 'react';
import { OrganizationsView } from '@/components/organizations/organizations-view';
import { RequireSession } from '@/components/require-session';

/** LIVE — `GET /v1/organizations` through the API Gateway. */
export default function OrganizationsPage(): ReactNode {
  return (
    <RequireSession>
      <OrganizationsView />
    </RequireSession>
  );
}
