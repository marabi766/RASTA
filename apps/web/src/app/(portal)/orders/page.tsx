import type { ReactNode } from 'react';
import { RequireSession } from '@/components/require-session';
import { OrdersView } from '@/components/orders/orders-view';

/** LIVE — `GET /v1/orders` through the API Gateway. */
export default function Page(): ReactNode {
  return (
    <RequireSession requireOrganization>
      <OrdersView />
    </RequireSession>
  );
}
