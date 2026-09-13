'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { FIXTURE_ENTRY_POINTS } from '@/lib/demo/entry-points';
import { ScenarioProvider, useScenario } from '@/lib/demo/scenario';
import { REJECTION_MESSAGES, SCENARIO_AMOUNTS } from '@/components/demo/scenario-copy';
import {
  ScenarioActionButton,
  SCENARIO_ACTION_DISCLOSURE,
} from '@/components/demo/scenario-action-button';
import { Card } from '../ui/primitives';

/**
 * Steps 3 and 4: select the prepared supplier offer, then place the order
 * for it — both on the one product page the scenario's offer belongs to.
 *
 * Two actions in one panel rather than two screens: the offers table above
 * has no per-row action column, and the two commands are adjacent in the
 * story (select, then order the same thing), so splitting them across pages
 * would send the presenter back and forth for no reason.
 */
function OfferScenarioPanelInner(): ReactNode {
  const { snapshot, dispatch } = useScenario();
  const offerSelected = snapshot.offerSelection !== null;
  const orderPlaced = snapshot.order.status !== 'NONE';

  return (
    <Card className="mb-6 border-[var(--warn)]">
      <p className="text-xs font-bold text-[var(--warn-tx)]">{SCENARIO_ACTION_DISCLOSURE}</p>
      <p className="mt-2 text-sm text-[var(--tx2)]">
        برای ادامهٔ داستان تعاملی، پیشنهاد تأمین‌کنندهٔ نمونه (
        <span dir="ltr" className="rasta-code">
          {FIXTURE_ENTRY_POINTS.offerId}
        </span>
        ) را انتخاب و سفارش آن را ثبت کنید.
      </p>

      <div className="mt-3 flex flex-wrap items-start gap-6">
        <ScenarioActionButton
          label="انتخاب این پیشنهاد"
          doneLabel="پیشنهاد انتخاب شد"
          done={offerSelected}
          lockedReason={
            snapshot.maintenance.status !== 'ESTIMATE_APPROVED'
              ? 'ابتدا برآورد هزینهٔ درخواست تعمیر باید تأیید شود.'
              : null
          }
          onActivate={() => {
            const result = dispatch({
              type: 'SUPPLIER_OFFER_SELECTED',
              maintenanceRequestId: FIXTURE_ENTRY_POINTS.maintenanceRequestId,
              supplierOrganizationId: FIXTURE_ENTRY_POINTS.supplierOrganizationId,
              offerId: FIXTURE_ENTRY_POINTS.offerId,
              unitPriceMinor: SCENARIO_AMOUNTS.unitPriceMinor,
            });
            return {
              outcome: result.outcome,
              message: result.reason ? REJECTION_MESSAGES[result.reason] : undefined,
            };
          }}
        />

        <ScenarioActionButton
          label="ثبت سفارش"
          doneLabel="سفارش ثبت شد"
          done={orderPlaced}
          lockedReason={!offerSelected ? 'ابتدا یک پیشنهاد تأمین‌کننده انتخاب کنید.' : null}
          onActivate={() => {
            const result = dispatch({
              type: 'ORDER_PLACED',
              orderId: FIXTURE_ENTRY_POINTS.orderId,
              offerId: FIXTURE_ENTRY_POINTS.offerId,
              totalAmountMinor: SCENARIO_AMOUNTS.orderTotalMinor,
            });
            return {
              outcome: result.outcome,
              message: result.reason ? REJECTION_MESSAGES[result.reason] : undefined,
            };
          }}
        />
      </div>

      {orderPlaced ? (
        <Link
          href={`/orders/${FIXTURE_ENTRY_POINTS.orderId}`}
          className="mt-3 inline-flex min-h-[var(--tap)] items-center text-sm font-bold text-[var(--pri-tx)] hover:underline"
        >
          گام بعدی: نهایی‌کردن پرداخت ←
        </Link>
      ) : null}
    </Card>
  );
}

export default function OfferScenarioPanel({ productId }: { productId: string }): ReactNode {
  if (productId !== FIXTURE_ENTRY_POINTS.productId) return null;

  return (
    <ScenarioProvider>
      <OfferScenarioPanelInner />
    </ScenarioProvider>
  );
}
