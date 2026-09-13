'use client';

import Link from 'next/link';
import { useRef, type ReactNode } from 'react';
import { FIXTURE_ENTRY_POINTS } from '@/lib/demo/entry-points';
import { ScenarioProvider, useScenario } from '@/lib/demo/scenario';
import { REJECTION_MESSAGES, SCENARIO_DOCUMENT_ID } from '@/components/demo/scenario-copy';
import {
  ScenarioActionButton,
  SCENARIO_ACTION_DISCLOSURE,
} from '@/components/demo/scenario-action-button';
import { Card } from '../ui/primitives';

const DOCUMENT_FILENAME = 'گزارش-سرویس-سناریو.pdf';

/**
 * Steps 6 and 7: attach the prepared service-report document to the paid
 * order, then complete its simulated malware scan.
 *
 * The scan always resolves to `CLEAN` — deterministic, by design (see
 * `clock.ts`'s "never `Date.now()`" rule applied to outcomes too): a
 * presenter narrating a fixed story does not need a coin flip, and the
 * reducer's own invariants already prove the other scan states through the
 * Jest suite rather than through this UI.
 *
 * `onApplied` is the documents screen's own `resource.reload` — calling it
 * after each successful dispatch re-runs `listDocuments` so the table above
 * this panel shows the scenario-projected row through the real read-model
 * path, not a component-local insert.
 */
function DocumentScenarioPanelInner({ onApplied }: { onApplied?: () => void }): ReactNode {
  const { snapshot, dispatch } = useScenario();
  const document_ = snapshot.documents.find((entry) => entry.id === SCENARIO_DOCUMENT_ID) ?? null;
  const attached = document_ !== null;
  const scanned = document_ !== null && document_.scanState !== 'PENDING';

  const appliedRef = useRef(onApplied);
  appliedRef.current = onApplied;

  return (
    <Card className="mb-8 border-[var(--warn)]">
      <p className="text-xs font-bold text-[var(--warn-tx)]">{SCENARIO_ACTION_DISCLOSURE}</p>
      <p className="mt-2 text-sm text-[var(--tx2)]">
        سند نمونهٔ «{DOCUMENT_FILENAME}» را به سفارش پرداخت‌شدهٔ سناریو پیوست و اسکن بدافزار
        شبیه‌سازی‌شدهٔ آن را کامل کنید. این اسکن یک موتور واقعی اجرا نمی‌کند؛ نتیجهٔ «پاک» فقط پیامد
        شبیه‌سازی همین سناریوست.
      </p>

      <div className="mt-3 flex flex-wrap items-start gap-6">
        <ScenarioActionButton
          label="پیوست سند"
          doneLabel="سند پیوست شد"
          done={attached}
          lockedReason={
            snapshot.order.status !== 'PAYMENT_CAPTURED'
              ? 'ابتدا باید پرداخت سفارش نهایی شود.'
              : null
          }
          onActivate={() => {
            const result = dispatch({
              type: 'DOCUMENT_ATTACHED',
              documentId: SCENARIO_DOCUMENT_ID,
              ownerResourceType: 'Order',
              ownerResourceId: FIXTURE_ENTRY_POINTS.orderId,
              filename: DOCUMENT_FILENAME,
            });
            if (result.outcome === 'APPLIED') appliedRef.current?.();
            return {
              outcome: result.outcome,
              message: result.reason ? REJECTION_MESSAGES[result.reason] : undefined,
            };
          }}
        />

        <ScenarioActionButton
          label="تکمیل اسکن سند (نتیجه: پاک)"
          doneLabel="اسکن سند کامل شد — پاک"
          done={scanned}
          lockedReason={!attached ? 'ابتدا سند را پیوست کنید.' : null}
          onActivate={() => {
            const result = dispatch({
              type: 'DOCUMENT_SCAN_COMPLETED',
              documentId: SCENARIO_DOCUMENT_ID,
              scanState: 'CLEAN',
            });
            if (result.outcome === 'APPLIED') appliedRef.current?.();
            return {
              outcome: result.outcome,
              message: result.reason ? REJECTION_MESSAGES[result.reason] : undefined,
            };
          }}
        />
      </div>

      {scanned ? (
        <Link
          href="/audit"
          className="mt-3 inline-flex min-h-[var(--tap)] items-center text-sm font-bold text-[var(--pri-tx)] hover:underline"
        >
          گام بعدی: مشاهدهٔ خط زمانی حسابرسی ←
        </Link>
      ) : null}
    </Card>
  );
}

export default function DocumentScenarioPanel({
  onApplied,
}: {
  onApplied?: () => void;
}): ReactNode {
  return (
    <ScenarioProvider>
      <DocumentScenarioPanelInner onApplied={onApplied} />
    </ScenarioProvider>
  );
}
