'use client';

import Link from 'next/link';
import { useRef, type ReactNode } from 'react';
import { FIXTURE_ENTRY_POINTS } from '@/lib/demo/entry-points';
import { ScenarioProvider, useScenario } from '@/lib/demo/scenario';
import { REJECTION_MESSAGES, SCENARIO_AMOUNTS } from '@/components/demo/scenario-copy';
import {
  ScenarioActionButton,
  SCENARIO_ACTION_DISCLOSURE,
} from '@/components/demo/scenario-action-button';
import { Card } from '../ui/primitives';

/**
 * Step 5: capture the simulated payment for the canonical order.
 *
 * `onApplied` is the order detail screen's own `resource.reload` — calling
 * it re-runs `fetchOrder` so the stepper and status badge above this panel
 * move from the real read-model projection, and a fresh `fetchWallet` on the
 * wallet screen (a different mount, reading the same store) shows the
 * balance this capture actually moved.
 */
function PaymentScenarioPanelInner({ onApplied }: { onApplied?: () => void }): ReactNode {
  const { snapshot, dispatch } = useScenario();
  const done = snapshot.order.status === 'PAYMENT_CAPTURED';
  const locked = snapshot.order.status !== 'PLACED';

  const appliedRef = useRef(onApplied);
  appliedRef.current = onApplied;

  return (
    <Card className="mb-8 border-[var(--warn)]">
      <p className="text-xs font-bold text-[var(--warn-tx)]">{SCENARIO_ACTION_DISCLOSURE}</p>
      <p className="mt-2 text-sm text-[var(--tx2)]">
        پرداخت شبیه‌سازی‌شدهٔ این سفارش را نهایی کنید. هیچ اتصال بانکی وجود ندارد؛ فقط مانده‌های کیف
        پول همین سناریو تغییر می‌کند.
      </p>

      <div className="mt-3">
        <ScenarioActionButton
          label="ثبت پرداخت شبیه‌سازی‌شده"
          doneLabel="پرداخت نهایی شد"
          done={done}
          lockedReason={locked ? 'ابتدا باید سفارش از صفحهٔ کالا ثبت شود.' : null}
          onActivate={() => {
            const result = dispatch({
              type: 'PAYMENT_CAPTURED',
              orderId: FIXTURE_ENTRY_POINTS.orderId,
              amountMinor: SCENARIO_AMOUNTS.orderTotalMinor,
            });
            if (result.outcome === 'APPLIED') appliedRef.current?.();
            return {
              outcome: result.outcome,
              message: result.reason ? REJECTION_MESSAGES[result.reason] : undefined,
            };
          }}
        />
      </div>

      {done ? (
        <Link
          href="/documents"
          className="mt-3 inline-flex min-h-[var(--tap)] items-center text-sm font-bold text-[var(--pri-tx)] hover:underline"
        >
          گام بعدی: پیوست سند ←
        </Link>
      ) : null}
    </Card>
  );
}

export default function PaymentScenarioPanel({
  orderId,
  onApplied,
}: {
  orderId: string;
  onApplied?: () => void;
}): ReactNode {
  if (orderId !== FIXTURE_ENTRY_POINTS.orderId) return null;

  return (
    <ScenarioProvider>
      <PaymentScenarioPanelInner onApplied={onApplied} />
    </ScenarioProvider>
  );
}
