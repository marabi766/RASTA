import { performance } from 'node:perf_hooks';
import type { TransferClearance, WorkOwner } from '../src/asset/transfer-clearance';

/**
 * fleet-service and maintenance-service answering "nothing is open" (ADR-062),
 * for the integration specs that are about what a transfer moves, not about
 * whether it may happen. The question itself is covered by
 * `transfer-clearance.int-spec.ts` here and by the owners' own specs.
 */
export function clearingOwners(): TransferClearance & {
  asked: WorkOwner[];
  released: WorkOwner[];
} {
  const asked: WorkOwner[] = [];
  const released: WorkOwner[] = [];
  return {
    fenceTtlSeconds: 600,
    asked,
    released,
    now: () => performance.now(),
    ask: async (owner) => {
      asked.push(owner);
      return { clear: true };
    },
    release: async (owner) => {
      released.push(owner);
    },
  };
}
