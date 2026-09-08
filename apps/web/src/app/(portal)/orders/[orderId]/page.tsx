import type { ReactNode } from 'react';
import { OrderDetailView } from '@/components/orders/order-detail-view';
import { RequireSession } from '@/components/require-session';

/** LIVE — `GET /v1/orders/{id}` through the API Gateway. */
export default async function Page({
  params,
}: {
  params: Promise<{ orderId: string }>;
}): Promise<ReactNode> {
  const { orderId } = await params;

  return (
    <RequireSession requireOrganization>
      <OrderDetailView orderId={orderId} />
    </RequireSession>
  );
}
