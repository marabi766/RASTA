import type { ReactNode } from 'react';
import { RequireSession } from '@/components/require-session';
import { ProviderDisclosureView } from '@/components/wallet/provider-disclosure-view';

/**
 * LIVE — `GET /v1/wallets/provider` through the API Gateway.
 *
 * A safe method, so the gateway's `Idempotency-Key` requirement on the
 * `wallets` prefix does not apply; it covers unsafe methods only. The route's
 * roles are `SYSTEM_ADMIN`, `UNION_ADMIN` and `ORGANIZATION_ADMIN`, so other
 * roles are refused — and refused is rendered as "no access", not as an error.
 */
export default function WalletDisclosurePage(): ReactNode {
  return (
    <RequireSession requireOrganization>
      <ProviderDisclosureView />
    </RequireSession>
  );
}
