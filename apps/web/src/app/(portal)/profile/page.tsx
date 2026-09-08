import type { ReactNode } from 'react';
import { RequireSession } from '@/components/require-session';
import { ProfileView } from '@/components/identity/profile-view';

/** LIVE — `GET /v1/users/me` through the API Gateway. */
export default function Page(): ReactNode {
  return (
    <RequireSession>
      <ProfileView />
    </RequireSession>
  );
}
