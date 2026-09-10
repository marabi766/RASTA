import type { ReactNode } from 'react';
import { DemoHome } from '@/components/demo/demo-home';

/**
 * The investor presentation entry point.
 *
 * No session guard, deliberately. The first thing a presenter does is open this
 * page; signing in is step two of the tour it starts. Every screen it links to
 * enforces its own access, and in presentation mode there is no sign-in at all.
 */
export default function DemoPage(): ReactNode {
  return <DemoHome />;
}
