import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { isOrderCommand } from '@/lib/order-fields';
import { currentSession } from '@/server/current-session';
import { fetchDemoMode } from '@/server/demo-mode';
import { webServerEnv } from '@/server/env';
import { fetchOrder } from '@/server/orders';
import { mintReturnSubmission } from '@/server/return-replay';
import {
  RETURNABLE_ORDER_STATUS,
  canRequestReturn,
  fetchReturnsOfOrder,
  returnCallerOf,
  returnableLines,
  sideOf,
} from '@/server/returns';
import { mintSubmissionId, submissionBinding } from '@/server/submission';
import { PortalSidebar } from '@/app/PortalSidebar';

import { OrderDetailScreen, type OrderDetailScreenProps } from './OrderDetailScreen';

/**
 * The `/orders/[id]` route — جزئیات سفارش + Stepper (docs/16 § ۱۶٫۶).
 *
 * **No role check here.** Whether this caller may see the order, and which
 * commands they may issue on it, are both marketplace-service's answers,
 * against the record: a non-party gets `404` (rendered as absent), and the
 * commands arrive as `availableActions`, computed for this caller.
 */
export const dynamic = 'force-dynamic';

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/orders/${id}`)}`);

  const query = await searchParams;
  const done =
    typeof query.done === 'string' && isOrderCommand(query.done) ? query.done : undefined;

  const placed = query.placed === '1';

  const result = await fetchOrder(session, id);

  // Returns (EXP-003): this order's requests on the viewer's side, and the
  // request form where `canRequestReturn` — a copy of marketplace-service's
  // checks, from the token's roles — says the service would take one.
  let returns: OrderDetailScreenProps['returns'] = null;
  if (result.kind === 'OK') {
    const order = result.data;
    const caller = returnCallerOf(session.accessToken);
    const side = sideOf(caller, order);
    if (side !== null) {
      const requests = await fetchReturnsOfOrder(session, order.id, side);
      const mayRequest = side === 'BUYER' && canRequestReturn(caller, order);
      const available = returnableLines(order, requests.kind === 'OK' ? requests.data : null);
      // What each line allows must be known — every request of the order read —
      // before the form is offered (PR 336 review 1, finding 3).
      const remainingKnown = available.every((line) => line.available !== null);
      const offerable = mayRequest && remainingKnown;
      returns = {
        requests,
        remainingUnknown: mayRequest && !remainingKnown,
        offered: offerable
          ? [
              {
                command: 'REQUEST',
                submission: mintReturnSubmission(session, {
                  command: 'REQUEST',
                  orderId: order.id,
                }),
              },
            ]
          : [],
        lines: order.lines.flatMap((line) => {
          const known = available.find((entry) => entry.orderLineId === line.id);
          return known
            ? [
                {
                  orderLineId: known.orderLineId,
                  productName: line.productName,
                  sold: line.quantity,
                  available: known.available,
                },
              ]
            : [];
        }),
        notCompleted: side === 'BUYER' && order.status !== RETURNABLE_ORDER_STATUS,
        binding: submissionBinding(session),
        sessionMaxAgeSeconds: webServerEnv().WEB_SESSION_MAX_AGE_SECONDS,
        pageHref: `/orders/${encodeURIComponent(order.id)}`,
      };
    }
  }

  const demoMode = await fetchDemoMode(session);

  return (
    <AppShell
      topBar={
        <TopBar organizationName={session.organizationId ?? 'بدون سازمان فعال'}>
          <form method="post" action="/auth/logout">
            <input type="hidden" name="csrf" value={session.csrfToken} />
            <Button type="submit" tone="secondary">
              خروج
            </Button>
          </form>
        </TopBar>
      }
      sidebar={<PortalSidebar session={session} currentHref="/orders" />}
    >
      <PageHeader
        title="جزئیات سفارش"
        description="این سفارش کجاست، و در این مرحله چه اقدامی از سوی شما لازم است."
      />
      <div className="mt-2">
        <ButtonLink href="/orders" tone="quiet">
          بازگشت به فهرست سفارش‌ها
        </ButtonLink>
      </div>
      <div className="mt-4">
        <OrderDetailScreen
          result={result}
          csrfToken={session.csrfToken}
          mintSubmissionId={() => mintSubmissionId(session)}
          done={done}
          placed={placed}
          returns={returns}
          demoMode={demoMode}
        />
      </div>
    </AppShell>
  );
}
