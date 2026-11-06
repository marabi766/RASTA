import { Logger } from '@nestjs/common';
import { createActivities } from './activities';
import { releasesUnconfirmedTotal } from '../observability/metrics';
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
