import type { ReactNode } from 'react';
import { RequireSession } from '@/components/require-session';
import { WalletView } from '@/components/wallet/wallet-view';

/** LIVE — `GET /v1/wallets/me`, `/v1/wallets/provider`, `/v1/transactions`. */
export default function Page(): ReactNode {
  return (
    <RequireSession requireOrganization>
      <WalletView />
    </RequireSession>
  );
}
