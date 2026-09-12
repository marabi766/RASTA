'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { useSession } from '@/lib/auth/session';
import { isFixtureMode } from '@/lib/demo/mode';

const ScenarioResetControl = dynamic(() => import('./scenario-reset-control'), { ssr: false });

/** Renders nothing in live mode — see `scenario-boundary.tsx` for why this is safe for the bundle. */
export function ScenarioResetGate(): ReactNode {
  const { dataMode } = useSession();
  if (!isFixtureMode(dataMode)) return null;
  return <ScenarioResetControl />;
}
