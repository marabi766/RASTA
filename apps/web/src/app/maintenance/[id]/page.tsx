import { redirect } from 'next/navigation';
import { AppShell, Button, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchCurrentUser } from '@/server/identity';
import { fetchMaintenanceRequest, fetchRepairOrder } from '@/server/maintenance';
import { canManageMaintenance, sealApprovalBaseline } from '@/server/maintenance-commands';
import { isRepairOrderId, sealRepairOrderBaseline } from '@/server/repair-order-commands';
import { mintSubmissionId } from '@/server/submission';
import { FLASH_PARAM } from '@/lib/form-fields';
import { REQUEST_COMMAND_NOTICES } from '@/lib/maintenance-fields';
import {
  REPAIR_COMMAND_NOTICES,
  repairCommandsFor,
  type RepairCommandName,
} from '@/lib/repair-order-fields';
import { readFlash } from '@/server/flash';
import { PORTAL_NAV } from '@/app/nav';
import { RequestDetailScreen, type OrderForms } from './RequestDetailScreen';
import { ApproveRequestForm, AssignWorkshopForm, CancelRequestForm } from './RequestCommandForms';
import {
  CancelRepairForm,
  CompleteRepairForm,
  RecordCostForm,
  RecordLabourForm,
  RecordPartForm,
  StartRepairForm,
} from './RepairOrderForms';

/**
 * The `/maintenance/[id]` route (docs/16 § 16.6).
 *
 * The id is whatever was in the URL and is treated as such: it is encoded
 * into the gateway path rather than interpolated, and it is never used for a
 * decision here. maintenance-service answers `404` for an id in another
 * tenant, which is the answer this screen renders — the portal does not need
 * to know the difference, and could not be trusted with it if it did
 * (`/assets/[id]`, PR #67, carries the same rule).
 */
export const dynamic = 'force-dynamic';

export default async function MaintenanceRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(`/maintenance/${id}`)}`);

  const [result, currentUser] = await Promise.all([
    fetchMaintenanceRequest(session, id),
    fetchCurrentUser(session),
  ]);

  // A Route Guard as UX, not as security (`docs/16 § ۱۶٫۱۱`): a failed identity
  // read shows no command rather than one that might not work, and
  // maintenance-service decides again on every submit.
  const canManage =
    currentUser.kind === 'USER' && canManageMaintenance(currentUser.user.effectiveRoles);

  // What each repair order has recorded under it. A line that cannot be read
  // costs that card its list, not the page: the commands never depend on it.
  const orders = result.kind === 'OK' ? result.data.repairOrders : [];
  const details = await Promise.all(orders.map((order) => fetchRepairOrder(session, order.id)));
  const orderDetails = Object.fromEntries(
    orders.map((order, index) => {
      const detail = details[index];
      return [order.id, detail?.kind === 'OK' ? detail.data : null] as const;
    }),
  );

  const identity = () => ({
    csrfToken: session.csrfToken,
    // One reference per form, so two forms never share an id.
    submissionId: mintSubmissionId(session),
    requestId: id,
  });

  // The commands on each order the status still leaves open, each with a
  // baseline signed for that command under this request. The order's total is
  // the one the page just read: the completion sends it back to the service.
  const orderForms: Record<string, OrderForms> = {};
  if (
    canManage &&
    result.kind === 'OK' &&
    (result.data.status === 'OPEN' || result.data.status === 'IN_PROGRESS')
  ) {
    for (const order of result.data.repairOrders) {
      if (!isRepairOrderId(order.id)) continue;
      const forms: OrderForms = {};
      const repair = (command: RepairCommandName) => ({
        ...identity(),
        baseline: sealRepairOrderBaseline(session, {
          requestId: id,
          repairOrderId: order.id,
          command,
          totalCostMinor: order.totalCostMinor,
        }),
      });
      for (const command of repairCommandsFor(order.status)) {
        switch (command) {
          case 'start':
            forms.start = <StartRepairForm {...repair('start')} />;
            break;
          case 'complete':
            forms.complete = (
              <CompleteRepairForm {...repair('complete')} totalCostMinor={order.totalCostMinor} />
            );
            break;
          case 'cancel':
            forms.cancel = <CancelRepairForm {...repair('cancel')} />;
            break;
          case 'part':
            forms.part = <RecordPartForm {...repair('part')} />;
            break;
          case 'labour':
            forms.labour = <RecordLabourForm {...repair('labour')} />;
            break;
          case 'cost':
            forms.cost = <RecordCostForm {...repair('cost')} />;
            break;
        }
      }
      orderForms[order.id] = forms;
    }
  }

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
      sidebar={<Sidebar items={PORTAL_NAV} currentHref="/maintenance" />}
    >
      <RequestDetailScreen
        result={result}
        requestId={id}
        notice={readFlash(
          session,
          typeof query[FLASH_PARAM] === 'string' ? query[FLASH_PARAM] : undefined,
          id,
          ['created', ...REQUEST_COMMAND_NOTICES, ...REPAIR_COMMAND_NOTICES],
        )}
        orderDetails={orderDetails}
        orderForms={orderForms}
        commandForms={
          canManage && result.kind === 'OK'
            ? {
                assign: <AssignWorkshopForm {...identity()} />,
                approve: (
                  <ApproveRequestForm
                    {...identity()}
                    totalCostMinor={result.data.totalCostMinor}
                    baseline={sealApprovalBaseline(session, id, result.data.totalCostMinor)}
                  />
                ),
                cancel: <CancelRequestForm {...identity()} />,
              }
            : undefined
        }
      />
    </AppShell>
  );
}
