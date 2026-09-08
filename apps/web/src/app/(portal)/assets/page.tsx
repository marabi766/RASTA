import type { ReactNode } from 'react';
import { RequireSession } from '@/components/require-session';
import { AssetsView } from '@/components/assets/assets-view';

/** LIVE — `GET /v1/assets` through the API Gateway. */
export default function Page(): ReactNode {
  return (
    <RequireSession requireOrganization>
      <AssetsView />
    </RequireSession>
  );
}
