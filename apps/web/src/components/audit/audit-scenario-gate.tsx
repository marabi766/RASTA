'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { useSession } from '@/lib/auth/session';
import { isFixtureMode } from '@/lib/demo/mode';

const AuditScenarioPanel = dynamic(() => import('./audit-scenario-panel'), { ssr: false });

export function AuditScenarioGate({ onApplied }: { onApplied?: () => void }): ReactNode {
  const { dataMode } = useSession();
  if (!isFixtureMode(dataMode)) return null;
  return <AuditScenarioPanel onApplied={onApplied} />;
}
