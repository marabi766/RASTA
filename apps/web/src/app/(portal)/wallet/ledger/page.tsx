import type { ReactNode } from 'react';
import { RequireSession } from '@/components/require-session';
import { LedgerView } from '@/components/wallet/ledger-view';

/** LIVE — `GET /v1/ledger/accounts` and `/v1/ledger/trial-balance`. */
export default function Page(): ReactNode {
  return (
    <RequireSession requireOrganization>
      <LedgerView />
    </RequireSession>
  );
}
