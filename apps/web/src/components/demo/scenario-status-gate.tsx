'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { useSession } from '@/lib/auth/session';
import { isFixtureMode } from '@/lib/demo/mode';

/**
 * Fetches the scenario engine's chunk only when a fixture-mode page renders
 * this component.
 *
 * `next/dynamic` compiles `scenario-status-card.tsx` and everything it pulls
 * in into its own chunk regardless of mode — a bundler cannot prove a branch
 * it never evaluates will never render, so the file exists on disk in a live
 * build too. What the `isFixtureMode` check below controls is the request:
 * returning `null` means the chunk is never fetched, parsed or executed in a
 * live session (confirmed against a real `next start` in live mode, not only
 * asserted here) — and `bundle-budget.mjs`'s "Initial JS per route" is a
 * request-based measurement too, so it never counts a chunk nothing asked
 * for.
 *
 * This gate and `scenario-reset-gate.tsx` exist separately, each wrapping
 * its own `<ScenarioProvider>`, so the status card and the reset control are
 * two independent chunks rather than two consumers of one shared subtree —
 * neither ever disappears while the other is loading.
 */
const ScenarioStatusCard = dynamic(() => import('./scenario-status-card'), { ssr: false });

export function ScenarioStatusGate(): ReactNode {
  const { dataMode } = useSession();
  if (!isFixtureMode(dataMode)) return null;
  return <ScenarioStatusCard />;
}
