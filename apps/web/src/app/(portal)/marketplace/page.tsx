import type { ReactNode } from 'react';
import { CatalogueView } from '@/components/marketplace/catalogue-view';
import { RequireSession } from '@/components/require-session';

/**
 * LIVE — `GET /v1/products` through the API Gateway.
 *
 * Tenant-scoped: the read is a marketplace-wide one, but every request still
 * carries the selected organization so the gateway resolves and validates the
 * tenant the caller is acting as (ADR-009).
 */
export default function MarketplacePage(): ReactNode {
  return (
    <RequireSession requireOrganization>
      <CatalogueView />
    </RequireSession>
  );
}
