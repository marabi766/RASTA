import type { ReactNode } from 'react';
import { OffersView } from '@/components/marketplace/offers-view';
import { RequireSession } from '@/components/require-session';

/** LIVE — `GET /v1/products/{id}/offers` through the API Gateway. */
export default async function ProductOffersPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}): Promise<ReactNode> {
  const { productId } = await params;

  return (
    <RequireSession requireOrganization>
      <OffersView productId={productId} />
    </RequireSession>
  );
}
