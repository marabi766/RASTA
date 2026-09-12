import type { ReactNode } from 'react';
import { RequireSession } from '@/components/require-session';
import { AuditView } from '@/components/audit/audit-view';

/** BETA — `GET /v1/audit-events` and `GET /v1/audit-events/verify` (AUD-001–003). */
export default function Page(): ReactNode {
  return (
    <RequireSession>
      <AuditView />
    </RequireSession>
  );
}
