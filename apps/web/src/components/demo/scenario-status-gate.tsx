'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { useSession } from '@/lib/auth/session';
import { isFixtureMode } from '@/lib/demo/mode';

/**
 * Loads the scenario engine only when a fixture-mode page actually renders
 * this component. See `scenario-boundary.tsx` for the full reasoning — this
 * gate exists a second time here because the status card and the reset
 * control are two independent leaves (each wraps its own
 * `<ScenarioProvider>`), not two consumers of one shared subtree, so that
 * neither ever disappears while the other's chunk is loading.
 */
const ScenarioStatusCard = dynamic(() => import('./scenario-status-card'), { ssr: false });

export function ScenarioStatusGate(): ReactNode {
  const { dataMode } = useSession();
  if (!isFixtureMode(dataMode)) return null;
  return <ScenarioStatusCard />;
}
