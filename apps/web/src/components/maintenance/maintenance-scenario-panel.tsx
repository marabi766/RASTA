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
 * Step 2: approve the estimate on the canonical maintenance request.
 *
 * `onApplied` is the screen's own `resource.reload` — calling it after a
 * successful dispatch re-runs `fetchMaintenanceRequest` through the same
 * `FixtureGatewayClient` path every other read uses, so the approval section
 * above this panel updates from the real read-model projection rather than
 * from a component-local patch.
 */
function MaintenanceScenarioPanelInner({ onApplied }: { onApplied?: () => void }): ReactNode {
  const { snapshot, dispatch } = useScenario();
  const done = snapshot.maintenance.status === 'ESTIMATE_APPROVED';
  const locked = snapshot.maintenance.status === 'NONE';

  const appliedRef = useRef(onApplied);
  appliedRef.current = onApplied;

  return (
    <Card className="mb-8 border-[var(--warn)]">
      <p className="text-xs font-bold text-[var(--warn-tx)]">{SCENARIO_ACTION_DISCLOSURE}</p>
      <p className="mt-2 text-sm text-[var(--tx2)]">
        برآورد هزینهٔ این درخواست را برای ادامهٔ داستان تعاملی تأیید کنید.
      </p>

      <div className="mt-3">
        <ScenarioActionButton
          label="تأیید برآورد هزینه"
          doneLabel="برآورد هزینه تأیید شد"
          done={done}
          lockedReason={locked ? 'ابتدا باید درخواست تعمیر از صفحهٔ دارایی ثبت شود.' : null}
          onActivate={() => {
            const result = dispatch({
              type: 'MAINTENANCE_ESTIMATE_APPROVED',
              maintenanceRequestId: FIXTURE_ENTRY_POINTS.maintenanceRequestId,
              estimateAmountMinor: SCENARIO_AMOUNTS.estimateMinor,
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
          href={`/marketplace/${FIXTURE_ENTRY_POINTS.productId}`}
          className="mt-3 inline-flex min-h-[var(--tap)] items-center text-sm font-bold text-[var(--pri-tx)] hover:underline"
        >
          گام بعدی: انتخاب پیشنهاد تأمین‌کننده ←
        </Link>
      ) : null}
    </Card>
  );
}

export default function MaintenanceScenarioPanel({
  requestId,
  onApplied,
}: {
  requestId: string;
  onApplied?: () => void;
}): ReactNode {
  if (requestId !== FIXTURE_ENTRY_POINTS.maintenanceRequestId) return null;

  return (
    <ScenarioProvider>
      <MaintenanceScenarioPanelInner onApplied={onApplied} />
    </ScenarioProvider>
  );
}
