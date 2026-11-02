import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type { OrderActivities } from '../../src/temporal/activities';

/** Minimal terminal chain: real local effects, no economic-service call. */
export async function restartedSagaSteps(orderId: string, reorder: boolean): Promise<void> {
  const at = (n: number): OrderActivities =>
    proxyActivities<OrderActivities>({
      activityId: `saga-step-${n}`,
      startToCloseTimeout: '10 seconds',
      retry: { maximumAttempts: 1 },
    });
  if (reorder) {
    await at(1).recordReminder(orderId);
    await at(2).markSettling(orderId);
  } else {
    await at(1).markSettling(orderId);
    await at(2).recordReminder(orderId);
  }
  await at(3).markSettlementFailed(orderId);
  throw ApplicationFailure.nonRetryable('Test terminal stop with funds held', 'SAGA_INCONSISTENT');
}
