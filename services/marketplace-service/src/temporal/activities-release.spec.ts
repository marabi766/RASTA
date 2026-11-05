import { Logger } from '@nestjs/common';
import { createActivities } from './activities';
import { economicCallsUnconfirmedTotal, releasesUnconfirmedTotal } from '../observability/metrics';
import { ActivityFailure } from '@temporalio/client';
import { RastaError } from '@rasta/nest-common';
import { outcomeUnknown } from './workflows';
import type { EconomicClient } from '../economic/economic.client';
import type { OrderService } from '../order/order.service';

/** The report of an unconfirmed release (FU-080): what the alert and the operator read. */
it('counts each round from a series that starts at zero, and logs the order', async () => {
  const count = async (): Promise<number | undefined> =>
    (await releasesUnconfirmedTotal.get()).values[0]?.value;
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  try {
    expect(await count()).toBeUndefined();
    const activities = createActivities({
      orders: {} as OrderService,
      economic: {} as EconomicClient,
    });
    // `increase()` cannot see the first increment of a series that was not there.
    expect(await count()).toBe(0);

    await activities.noteReleaseUnconfirmed('ORD_NOTE', 4, 'UPSTREAM_UNAVAILABLE: down');

    expect(await count()).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain('ORD_NOTE');
    expect(error.mock.calls[0]?.[0]).toContain('round 4');
    expect(error.mock.calls[0]?.[0]).toContain('UPSTREAM_UNAVAILABLE: down');
  } finally {
    error.mockRestore();
  }
});

it('reports another economic call by operation, from a series at zero (FU-103)', async () => {
  const count = async (): Promise<number | undefined> =>
    (await economicCallsUnconfirmedTotal.get()).values.find(
      (value) => value.labels.operation === 'authoriseSettlement',
    )?.value;
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  try {
    const activities = createActivities({
      orders: {} as OrderService,
      economic: {} as EconomicClient,
    });
    expect(await count()).toBe(0);

    await activities.noteEconomicCallUnconfirmed('ORD', 'authoriseSettlement', 2, 'CONFLICT: busy');

    expect(await count()).toBe(1);
    expect(error.mock.calls[0]?.[0]).toContain('authoriseSettlement call of order ORD');
    expect(error.mock.calls[0]?.[0]).toContain('CONFLICT: busy');
  } finally {
    error.mockRestore();
  }
});

it.each([
  ['an outage', RastaError.upstreamUnavailable('economic-service'), true],
  ['a request in flight', new RastaError('CONFLICT', 'busy'), true],
  ['a business refusal', RastaError.businessRule('no', {}), false],
])('%s is classified as the activity really fails it (FU-103)', async (_name, error, unknown) => {
  const order = {
    id: 'ORD',
    buyerOrganizationId: 'ORG',
    correlationId: 'COR',
    receiptConfirmed: true,
  };
  const activities = createActivities({
    orders: {
      describe: async () => order,
      onceForSaga: (_order: unknown, _step: unknown, _activity: unknown, call: () => unknown) =>
        call(),
    } as unknown as OrderService,
    economic: {
      authoriseSettlement: async () => {
        throw error;
      },
    } as unknown as EconomicClient,
    currentStep: () => ({ key: 'K', scheduledAt: new Date(0) }),
  });
  const cause = await activities.authoriseSettlement('ORD', 'TXN').catch((e: Error) => e);
  const failed = new ActivityFailure(
    'x',
    'authorise',
    '1',
    'TIMEOUT' as never,
    'w',
    cause as Error,
  );
  expect(outcomeUnknown(failed)).toBe(unknown);
});
