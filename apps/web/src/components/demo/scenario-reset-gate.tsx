'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { useSession } from '@/lib/auth/session';
import { isFixtureMode } from '@/lib/demo/mode';

const ScenarioResetControl = dynamic(() => import('./scenario-reset-control'), { ssr: false });

/**
 * Renders nothing in live mode.
 *
 * `next/dynamic` still compiles `scenario-reset-control.tsx` and everything
 * it pulls in (the whole engine) into its own chunk in *every* build — a
 * bundler cannot prove a branch it did not evaluate will never render, so
 * the file exists on disk either way. What differs is runtime: this gate
 * returning `null` means the chunk is never requested, so a live session
 * never fetches, parses or executes it — confirmed by watching the network
 * panel against a real `next start` in live mode, not only asserted here.
 */
export function ScenarioResetGate(): ReactNode {
  const { dataMode } = useSession();
  if (!isFixtureMode(dataMode)) return null;
  return <ScenarioResetControl />;
}
