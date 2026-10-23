import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { FLASH_PARAM } from '@/lib/form-fields';
import { INVENTORY_COMMANDS } from '@/lib/inventory-commands';
import { currentSession } from '@/server/current-session';
import { webServerEnv } from '@/server/env';
import { readFlash } from '@/server/flash';
import { fetchShipment, fetchShipmentTracking } from '@/server/inventory';
import {
  inventoryCallerOf,
  isConsigneeOnly,
  mayOperateInventory,
  shipmentMovesFor,
} from '@/server/inventory-commands';
import { mintInventorySubmission } from '@/server/inventory-replay';
import { submissionBinding } from '@/server/submission';
import { PortalSidebar } from '@/app/PortalSidebar';

import type { OfferedInventoryCommand } from '../../InventoryCommands';
import { ShipmentScreen } from './ShipmentScreen';

/**
 * The `/inventory/shipments/[id]` route — one shipment and its tracking
 * (ADR-056 § 2, § 5), with the dispatch and the delivery.
 *
 * **No role check on the read.** inventory-service lets the owner of the origin
 * warehouse and the shipment's consignee read it, each through its own roles,
 * and answers `404` to everyone else, exactly as for an id that does not exist;
 * the screen says the same for both.
 *
 * Which moves are drawn is `shipmentMovesFor`: a copy of the service's own
 * checks — an operator of the origin warehouse's owner, from the status the
 * move needs — from the roles **the access token** carries. The consignee is
 * told, in fixed words, that it only reads (Q-114). Each form's stamp binds the
 * shipment, the command and the `version` this page showed
 * (`server/inventory-replay.ts`). UX only; the service decides again.
 */
export const dynamic = 'force-dynamic';

export default async function ShipmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const href = `/inventory/shipments/${encodeURIComponent(id)}`;
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(href)}`);

  const flash = (await searchParams)[FLASH_PARAM];
  const notice = readFlash(
    session,
    typeof flash === 'string' ? flash : undefined,
    id,
    INVENTORY_COMMANDS,
  );

  const [shipment, tracking] = await Promise.all([
    fetchShipment(session, id),
    fetchShipmentTracking(session, id),
  ]);

  const caller = inventoryCallerOf(session.accessToken);
  const offered: OfferedInventoryCommand[] =
    shipment.kind === 'OK'
      ? shipmentMovesFor(caller, shipment.data).map((command) => ({
          command,
          submission: mintInventorySubmission(session, {
            command,
            scope: { kind: 'SHIPMENT', shipmentId: id },
            expectedVersion: shipment.data.version,
          }),
        }))
      : [];

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
        title="اطلاعات محموله"
        description="این محموله کجاست، چه مرحله‌هایی از حمل دارد و در این مرحله چه اقدامی از سوی شما ممکن است."
      />
      <div className="mt-2">
        <ButtonLink href="/inventory" tone="quiet">
          بازگشت به انبار
        </ButtonLink>
      </div>
      <div className="mt-4">
        <ShipmentScreen
          shipment={shipment}
          tracking={tracking}
          offered={offered}
          canOperate={mayOperateInventory(caller)}
          consigneeOnly={shipment.kind === 'OK' && isConsigneeOnly(caller, shipment.data)}
          csrfToken={session.csrfToken}
          binding={submissionBinding(session)}
          sessionMaxAgeSeconds={webServerEnv().WEB_SESSION_MAX_AGE_SECONDS}
          notice={notice}
          pageHref={href}
        />
      </div>
    </AppShell>
  );
}
