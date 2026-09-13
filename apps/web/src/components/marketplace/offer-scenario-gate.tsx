'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { useSession } from '@/lib/auth/session';
import { isFixtureMode } from '@/lib/demo/mode';

const OfferScenarioPanel = dynamic(() => import('./offer-scenario-panel'), { ssr: false });

export function OfferScenarioGate({ productId }: { productId: string }): ReactNode {
  const { dataMode } = useSession();
  if (!isFixtureMode(dataMode)) return null;
  return <OfferScenarioPanel productId={productId} />;
}
