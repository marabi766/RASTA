import type { ReactNode } from 'react';
import { RequireSession } from '@/components/require-session';
import { SuppliersView } from '@/components/suppliers/suppliers-view';

/** LIVE — BETA — `GET /v1/suppliers`. Phase 1 only; performance scoring does not exist. */
export default function Page(): ReactNode {
  return (
    <RequireSession requireOrganization>
      <SuppliersView />
    </RequireSession>
  );
}
