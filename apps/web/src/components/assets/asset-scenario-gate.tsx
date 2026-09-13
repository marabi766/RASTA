'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { useSession } from '@/lib/auth/session';
import { isFixtureMode } from '@/lib/demo/mode';

/**
 * Fetches the scenario engine's chunk only when a fixture-mode session
 * renders the canonical asset's dossier.
 *
 * Same shape as `components/demo/scenario-status-gate.tsx`: `next/dynamic`
 * compiles `asset-scenario-panel.tsx` into its own chunk in every build — a
 * bundler cannot prove a branch it never evaluates will never render — but
 * `isFixtureMode` below means a live session never requests it.
 */
const AssetScenarioPanel = dynamic(() => import('./asset-scenario-panel'), { ssr: false });

export function AssetScenarioGate({ assetId }: { assetId: string }): ReactNode {
  const { dataMode } = useSession();
  if (!isFixtureMode(dataMode)) return null;
  return <AssetScenarioPanel assetId={assetId} />;
}
