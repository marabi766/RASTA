'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { useSession } from '@/lib/auth/session';
import { isFixtureMode } from '@/lib/demo/mode';

const PaymentScenarioPanel = dynamic(() => import('./payment-scenario-panel'), { ssr: false });

export function PaymentScenarioGate({
  orderId,
  onApplied,
}: {
  orderId: string;
  onApplied?: () => void;
}): ReactNode {
  const { dataMode } = useSession();
  if (!isFixtureMode(dataMode)) return null;
  return <PaymentScenarioPanel orderId={orderId} onApplied={onApplied} />;
}
