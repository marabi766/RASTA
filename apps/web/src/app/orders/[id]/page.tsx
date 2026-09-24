import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, PageHeader, Sidebar, TopBar } from '@/ui';
import { isOrderCommand } from '@/lib/order-fields';
import { currentSession } from '@/server/current-session';
import { fetchOrder } from '@/server/orders';
import { newSubmissionId } from '@/server/submission';
import { PORTAL_NAV } from '@/app/nav';

import { OrderDetailScreen } from './OrderDetailScreen';

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

  const result = await fetchOrder(session, id);

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
          mintSubmissionId={newSubmissionId}
          done={done}
        />
      </div>
    </AppShell>
  );
}
