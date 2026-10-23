import { redirect } from 'next/navigation';

import { AppShell, Button, PageHeader, TopBar } from '@/ui';
import { FLASH_PARAM } from '@/lib/form-fields';
import { INVENTORY_COMMANDS, type InventoryScope } from '@/lib/inventory-commands';
import { isWarehouseId } from '@/lib/inventory-fields';
import { currentSession } from '@/server/current-session';
import { webServerEnv } from '@/server/env';
import { readFlash } from '@/server/flash';
import { mintInventorySubmission } from '@/server/inventory-replay';
import { inventoryCallerOf, mayOperateInventory } from '@/server/inventory-commands';
import type { WebSession } from '@/server/session';
import {
  fetchMovements,
  fetchShipments,
  fetchStock,
  fetchWarehouse,
  fetchWarehouses,
} from '@/server/inventory';
import { submissionBinding } from '@/server/submission';
import { PortalSidebar } from '@/app/PortalSidebar';

import type { OfferedInventoryCommand } from './InventoryCommands';
import {
  InventoryScreen,
  type InventoryQuery,
  type InventorySelection,
  type InventoryWriteView,
} from './InventoryScreen';

/**
 * The `/inventory` route — انبار (docs/16 § ۱۶٫۶): warehouses, stock, the
 * ledger and the shipments, with the operator commands of inventory-service
 * (a warehouse, a receipt, an adjustment, a new shipment) for a viewer whose
 * token roles the service would accept (`mayOperateInventory`, a copy of its
 * check — UX only; the service decides again on every request).
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

  const params = await searchParams;
  const chosen = one(params.warehouse);
  // A warehouse id the service could not have issued is dropped, not forwarded
  // to earn a refusal the person cannot act on.
  const query: InventoryQuery = {
    warehouse: isWarehouseId(chosen) ? chosen : undefined,
    warehouseCursor: one(params.wcursor),
    cursor: one(params.cursor),
    movementCursor: one(params.mcursor),
    shipmentCursor: one(params.scursor),
  };

  const [warehouses, selection, shipments] = await Promise.all([
    fetchWarehouses(session, query.warehouseCursor),
    readSelection(session, query),
    fetchShipments(session, { cursor: query.shipmentCursor }),
  ]);

  const flash = params[FLASH_PARAM];
  const notice = readFlash(
    session,
    typeof flash === 'string' ? flash : undefined,
    // Every confirmation lands on the warehouse it touched or on the list: a created
    // warehouse is addressed by its own id, a receipt or adjustment by the chosen one.
    query.warehouse ?? '',
    INVENTORY_COMMANDS,
  );
  const write = writeView(session, query, selection, notice);

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
          query={query}
          shipments={shipments}
          write={write}
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
  const [warehouse, stock, movements] = await Promise.all([
    fetchWarehouse(session, query.warehouse),
    fetchStock(session, query.warehouse, query.cursor),
    fetchMovements(session, query.warehouse, query.movementCursor),
  ]);
  // The warehouse is the gate: another organization's is 404 there, and its
  // stock and ledger answers are not shown whatever they were.
  const open = warehouse.kind === 'OK';
  return { warehouse, stock: open ? stock : null, movements: open ? movements : null };
}

/**
 * What the forms need. A viewer the service would refuse (`mayOperateInventory`)
 * is drawn none and is told so in fixed words; everyone else gets a fresh
 * submission and stamp per form. The shipment form is bound to the chosen
 * warehouse.
 */
function writeView(
  session: WebSession,
  query: InventoryQuery,
  selection: InventorySelection | null,
  notice: InventoryWriteView['notice'],
): InventoryWriteView {
  const canOperate = mayOperateInventory(inventoryCallerOf(session.accessToken));
  const chosen = selection?.warehouse.kind === 'OK' ? selection.warehouse.data.id : null;
  const hasStock = selection?.stock?.kind === 'OK' && selection.stock.data.items.length > 0;
  const offer = (
    command: OfferedInventoryCommand['command'],
    scope: InventoryScope,
  ): OfferedInventoryCommand => ({
    command,
    submission: mintInventorySubmission(session, { command, scope, expectedVersion: null }),
  });
  const warehouseForms: OfferedInventoryCommand[] = canOperate
    ? [offer('CREATE_WAREHOUSE', { kind: 'WAREHOUSES' })]
    : [];
  const selectionForms: OfferedInventoryCommand[] =
    canOperate && chosen
      ? [
          offer('RECEIVE_STOCK', { kind: 'WAREHOUSE', warehouseId: chosen }),
          ...(hasStock ? [offer('ADJUST_STOCK', { kind: 'WAREHOUSE', warehouseId: chosen })] : []),
          offer('CREATE_SHIPMENT', { kind: 'WAREHOUSE', warehouseId: chosen }),
        ]
      : [];
  return {
    canOperate,
    csrfToken: session.csrfToken,
    binding: submissionBinding(session),
    sessionMaxAgeSeconds: webServerEnv().WEB_SESSION_MAX_AGE_SECONDS,
    warehouseForms,
    selectionForms,
    notice,
    pageHref: query.warehouse
      ? `/inventory?warehouse=${encodeURIComponent(query.warehouse)}`
      : '/inventory',
  };
}
