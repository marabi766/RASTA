'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { useSession } from '@/lib/auth/session';
import { isFixtureMode } from '@/lib/demo/mode';

const DocumentScenarioPanel = dynamic(() => import('./document-scenario-panel'), { ssr: false });

export function DocumentScenarioGate({ onApplied }: { onApplied?: () => void }): ReactNode {
  const { dataMode } = useSession();
  if (!isFixtureMode(dataMode)) return null;
  return <DocumentScenarioPanel onApplied={onApplied} />;
}
