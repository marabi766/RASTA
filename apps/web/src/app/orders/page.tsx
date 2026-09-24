import { redirect } from 'next/navigation';

import { AppShell, Button, PageHeader, Sidebar, TopBar } from '@/ui';
import { ORDER_LIST_ROLES, type OrderListRole } from '@/lib/order-fields';
import { currentSession } from '@/server/current-session';
import { fetchOrders, type OrderListQuery } from '@/server/orders';
import { PORTAL_NAV } from '@/app/nav';

import { OrdersScreen } from './OrdersScreen';

/**
 * The `/orders` route — سفارش‌ها (docs/16 § ۱۶٫۶, `PROCUREMENT_USER`,
 * `SUPPLIER`).
 *
 * The order lifecycle only. Browsing a catalogue and placing an order —
 * `/marketplace` — is its own screen and not in this one, the way `/drivers`
 * did not also build `/assets`.
 *
 * **No role check here**, for the reason every portal route has none:
 * marketplace-service decides who may read which order, against the record
 * (`access.ts`), and a refusal is rendered as an outcome (`docs/16` § ۱۶٫۱۱).
 */
export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function side(value: string | undefined): OrderListRole {
  // Anything the service would not accept falls back to its own default,
  // rather than being forwarded to earn a 400 the person cannot act on.
  return (ORDER_LIST_ROLES as readonly string[]).includes(value ?? '')
    ? (value as OrderListRole)
    : 'BUYER';
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/orders');

  const params = await searchParams;
  const query: OrderListQuery = {
    role: side(one(params.role)),
    status: one(params.status),
    cursor: one(params.cursor),
  };

  const result = await fetchOrders(session, query);

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
      sidebar={<Sidebar items={PORTAL_NAV} currentHref="/orders" />}
    >
      <PageHeader
        title="سفارش‌ها"
        description="سفارش‌هایی که این سازمان ثبت کرده یا به آن داده شده، و مرحله‌ای که هر کدام در آن است."
      />
      <div className="mt-4">
        <OrdersScreen result={result} query={query} />
      </div>
    </AppShell>
  );
}
