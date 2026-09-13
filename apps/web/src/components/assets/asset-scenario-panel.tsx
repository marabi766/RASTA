'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { FIXTURE_ENTRY_POINTS } from '@/lib/demo/entry-points';
import { ScenarioProvider, useScenario } from '@/lib/demo/scenario';
import { REJECTION_MESSAGES, SCENARIO_MAINTENANCE_TITLE } from '@/components/demo/scenario-copy';
import {
  ScenarioActionButton,
  SCENARIO_ACTION_DISCLOSURE,
} from '@/components/demo/scenario-action-button';
import { Card } from '../ui/primitives';

/**
 * Step 1 of the interactive story on the canonical asset's dossier: create
 * the maintenance request that the rest of the scenario builds on.
 *
 * Renders nothing for any asset other than the scenario's own
 * (`FIXTURE_ENTRY_POINTS.assetId`) — the engine models exactly one fixed
 * story, never a free-form sandbox over every demo asset.
 */
function AssetScenarioPanelInner(): ReactNode {
  const { snapshot, dispatch } = useScenario();
  const done = snapshot.maintenance.status !== 'NONE';

  return (
    <Card className="mb-8 border-[var(--warn)]">
      <p className="text-xs font-bold text-[var(--warn-tx)]">{SCENARIO_ACTION_DISCLOSURE}</p>
      <p className="mt-2 text-sm text-[var(--tx2)]">
        برای شروع داستان تعاملی، یک درخواست تعمیر برای همین ماشین در سناریوی نمونه ثبت کنید.
      </p>

      <div className="mt-3">
        <ScenarioActionButton
          label="ثبت درخواست تعمیر"
          doneLabel="درخواست تعمیر ثبت شد"
          done={done}
          lockedReason={null}
          onActivate={() => {
            const result = dispatch({
              type: 'MAINTENANCE_REQUEST_CREATED',
              maintenanceRequestId: FIXTURE_ENTRY_POINTS.maintenanceRequestId,
              assetId: FIXTURE_ENTRY_POINTS.assetId,
              organizationId: FIXTURE_ENTRY_POINTS.organizationId,
              title: SCENARIO_MAINTENANCE_TITLE,
            });
            return {
              outcome: result.outcome,
              message: result.reason ? REJECTION_MESSAGES[result.reason] : undefined,
            };
          }}
        />
      </div>

      {done ? (
        <Link
          href={`/maintenance/${FIXTURE_ENTRY_POINTS.maintenanceRequestId}`}
          className="mt-3 inline-flex min-h-[var(--tap)] items-center text-sm font-bold text-[var(--pri-tx)] hover:underline"
        >
          گام بعدی: تأیید برآورد هزینه ←
        </Link>
      ) : null}
    </Card>
  );
}

export default function AssetScenarioPanel({ assetId }: { assetId: string }): ReactNode {
  if (assetId !== FIXTURE_ENTRY_POINTS.assetId) return null;

  return (
    <ScenarioProvider>
      <AssetScenarioPanelInner />
    </ScenarioProvider>
  );
}
