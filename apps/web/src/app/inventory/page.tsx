import { redirect } from 'next/navigation';

import { AppShell, Button, PageHeader, TopBar } from '@/ui';
import { isWarehouseId } from '@/lib/inventory-fields';
import { currentSession } from '@/server/current-session';
import type { WebSession } from '@/server/session';
import { fetchStock, fetchWarehouse, fetchWarehouses } from '@/server/inventory';
import { PortalSidebar } from '@/app/PortalSidebar';

import { InventoryScreen, type InventoryQuery, type InventorySelection } from './InventoryScreen';
import { actingOrganizationLabel, actingScope } from '@/server/session-organization';
import { pageContext, pageParams } from '@/server/page-context';

/**
 * The `/inventory` route — انبار (docs/16 § ۱۶٫۶). Read-only.
 *
 * **No role check here**, as on every portal route: inventory-service decides
 * who may read (configured roles; the oversight role and the platform
 * administrator are always refused) and a refusal is rendered as an outcome
 * (`docs/16` § ۱۶٫۱۱).
 */
export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/inventory');

  const params = await pageParams(session, searchParams);
  const chosen = one(params.warehouse);
  // A warehouse id the service could not have issued is dropped, not forwarded
  // to earn a refusal the person cannot act on.
  const query: InventoryQuery = {
    warehouse: isWarehouseId(chosen) ? chosen : undefined,
    warehouseCursor: one(params.wcursor),
    cursor: one(params.cursor),
  };

  const [warehouses, selection] = await Promise.all([
    fetchWarehouses(session, query.warehouseCursor),
    readSelection(session, query),
  ]);

  return (
    <AppShell
      key={actingScope(session)}
      topBar={
        <TopBar organizationName={actingOrganizationLabel(session)}>
          <form method="post" action="/auth/logout">
            <input type="hidden" name="csrf" value={session.csrfToken} />
            <Button type="submit" tone="secondary">
              خروج
            </Button>
          </form>
        </TopBar>
      }
      sidebar={<PortalSidebar session={session} currentHref="/inventory" />}
    >
      <PageHeader
        title="انبار"
        description="انبارهای این سازمان و موجودی هر کالا: موجود، رزروشده و قابل‌استفاده."
      />
      <div className="mt-4">
        <InventoryScreen
          warehouses={warehouses}
          selection={selection}
          query={{ ...query, context: pageContext(session) }}
        />
      </div>
    </AppShell>
  );
}

async function readSelection(
  session: WebSession,
  query: InventoryQuery,
): Promise<InventorySelection | null> {
  if (!query.warehouse) return null;
  const [warehouse, stock] = await Promise.all([
    fetchWarehouse(session, query.warehouse),
    fetchStock(session, query.warehouse, query.cursor),
  ]);
  // The warehouse is the gate: another organization's is 404 there, and its
  // stock answer is not shown whatever it was.
  return { warehouse, stock: warehouse.kind === 'OK' ? stock : null };
}
