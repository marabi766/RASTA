'use client';

import { useRef, type ReactNode } from 'react';
import { ScenarioProvider, useScenario } from '@/lib/demo/scenario';
import { REJECTION_MESSAGES } from '@/components/demo/scenario-copy';
import {
  ScenarioActionButton,
  SCENARIO_ACTION_DISCLOSURE,
} from '@/components/demo/scenario-action-button';
import { Card } from '../ui/primitives';

/**
 * Step 8: append a manual note to the scenario's own activity log, live, in
 * front of the audience.
 *
 * Every other scenario command already appends one activity-log entry on
 * its own success (`reducer.ts`'s `reduceScenario`); this is the one command
 * a presenter can fire directly and repeatedly — `AUDIT_RECORD_APPENDED`
 * carries no status check in the reducer, so doing it twice is not a
 * duplicate in any sense the engine tracks, only a second honest log line.
 * `onApplied` is the audit screen's own list reload, so the new row appears
 * through the real `searchAuditEvents` → read-model path rather than a
 * component-local insert.
 *
 * The referenced resource is always `snapshot.maintenance.id` — one of the
 * fixed ids the scenario initializes with (`initial-state.ts`), so this
 * control never needs to be locked: every stage of the story already owns
 * that id.
 */
function AuditScenarioPanelInner({ onApplied }: { onApplied?: () => void }): ReactNode {
  const { snapshot, dispatch } = useScenario();

  const appliedRef = useRef(onApplied);
  appliedRef.current = onApplied;

  return (
    <Card className="mb-6 border-[var(--warn)]">
      <p className="text-xs font-bold text-[var(--warn-tx)]">{SCENARIO_ACTION_DISCLOSURE}</p>
      <p className="mt-2 text-sm text-[var(--tx2)]">
        یک یادداشت بازرسی نمونه روی همین درخواست تعمیر ثبت کنید و ردیف تازه را در فهرست زیر ببینید.
        این رویداد فقط درون سناریوی نمایشی این تب می‌ماند؛ در پایگاه‌داده واقعی حسابرسی نوشته
        نمی‌شود و زنجیرهٔ Hash واقعی را تغییر نمی‌دهد.
      </p>

      <div className="mt-3">
        <ScenarioActionButton
          label="افزودن یادداشت بازرسی به خط زمانی"
          doneLabel="یادداشت ثبت شد"
          // Repeatable by design — never marked permanently "done".
          done={false}
          lockedReason={null}
          onActivate={() => {
            const result = dispatch({
              type: 'AUDIT_RECORD_APPENDED',
              action: 'scenario.manual_note_appended',
              resourceType: 'MaintenanceRequest',
              resourceId: snapshot.maintenance.id,
              summary: 'یادداشت تکمیلی نمایش‌دهنده روی این درخواست تعمیر ثبت شد.',
            });
            if (result.outcome === 'APPLIED') appliedRef.current?.();
            return {
              outcome: result.outcome,
              message: result.reason ? REJECTION_MESSAGES[result.reason] : undefined,
            };
          }}
        />
      </div>
    </Card>
  );
}

export default function AuditScenarioPanel({ onApplied }: { onApplied?: () => void }): ReactNode {
  return (
    <ScenarioProvider>
      <AuditScenarioPanelInner onApplied={onApplied} />
    </ScenarioProvider>
  );
}
