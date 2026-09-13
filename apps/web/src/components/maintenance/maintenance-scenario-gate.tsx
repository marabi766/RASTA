'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { useSession } from '@/lib/auth/session';
import { isFixtureMode } from '@/lib/demo/mode';

const MaintenanceScenarioPanel = dynamic(() => import('./maintenance-scenario-panel'), {
  ssr: false,
});

export function MaintenanceScenarioGate({
  requestId,
  onApplied,
}: {
  requestId: string;
  onApplied?: () => void;
}): ReactNode {
  const { dataMode } = useSession();
  if (!isFixtureMode(dataMode)) return null;
  return <MaintenanceScenarioPanel requestId={requestId} onApplied={onApplied} />;
}
