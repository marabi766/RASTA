import type { ReactNode } from 'react';
import { RequireSession } from '@/components/require-session';
import { UsersView } from '@/components/identity/users-view';

/** LIVE — `GET /v1/users`. Route roles are ORGANIZATION_ADMIN and UNION_ADMIN. */
export default function Page(): ReactNode {
  return (
    <RequireSession requireOrganization>
      <UsersView />
    </RequireSession>
  );
}
