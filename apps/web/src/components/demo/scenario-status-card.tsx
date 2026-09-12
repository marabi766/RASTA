'use client';

import type { ReactNode } from 'react';
import { ScenarioProvider, useScenario, type ScenarioStage } from '@/lib/demo/scenario';
import { formatInteger } from '@/lib/format';
import { Badge, Card } from '../ui/primitives';
import { Code } from '../ui/data-view';

/**
 * The scenario's name, current stage and revision — nothing else.
 *
 * No raw state dump. The task this engine was built for is explicit that the
 * investor-facing UI must not expose the snapshot as JSON; a presenter gets
 * three facts, in Persian, and the engine's own correctness is what the test
 * suite vouches for.
 */
const STAGE_LABELS: Record<ScenarioStage, string> = {
  ORGANIZATION_SELECTED: 'سازمان انتخاب شد',
  MAINTENANCE_REQUESTED: 'درخواست تعمیر ثبت شد',
  ESTIMATE_APPROVED: 'برآورد هزینه تأیید شد',
  OFFER_SELECTED: 'پیشنهاد تأمین‌کننده انتخاب شد',
  ORDER_PLACED: 'سفارش ثبت شد',
  PAYMENT_CAPTURED: 'پرداخت نهایی شد',
  DOCUMENT_ATTACHED: 'سند پیوست شد',
  DOCUMENT_SCAN_COMPLETED: 'اسکن سند کامل شد',
};

function ScenarioStatusCardInner(): ReactNode {
  const { snapshot } = useScenario();

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-[var(--tx3)]">سناریوی نمایشی</p>
          <p className="mt-0.5 text-sm font-bold text-[var(--tx)]">
            {STAGE_LABELS[snapshot.stage]}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="info">
            <span>بازبینی</span>
            <span dir="ltr" className="rasta-code">
              {formatInteger(snapshot.revision)}
            </span>
          </Badge>
          <Code>{snapshot.scenarioId}</Code>
        </div>
      </div>
    </Card>
  );
}

export default function ScenarioStatusCard(): ReactNode {
  return (
    <ScenarioProvider>
      <ScenarioStatusCardInner />
    </ScenarioProvider>
  );
}
