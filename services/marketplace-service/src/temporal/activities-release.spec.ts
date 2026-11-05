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

/**
 * The durable record (FU-104): on before the call, off only once it is confirmed.
 * The order of the calls is the point, so one log records them all.
 */
describe('resolveObligationDispute on record', () => {
  function build(options: { resolveDispute: () => Promise<unknown>; recorded?: boolean }) {
    const log: string[] = [];
    const orders = {
      describe: async () => ({
        id: 'ORD_R',
        buyerOrganizationId: 'ORG_B',
        correlationId: 'COR',
      }),
      onceForSaga: async (_o: unknown, _s: unknown, _a: unknown, call: () => Promise<unknown>) =>
        options.recorded ? (log.push('answered from the record'), undefined) : call(),
      openSagaCall: async (...args: unknown[]) => {
        log.push(`open ${JSON.stringify(args)}`);
        return 7;
      },
      confirmSagaCall: async (...args: unknown[]) =>
        void log.push(`confirm ${JSON.stringify(args)}`),
    };
    const economic = {
      resolveDispute: async () => {
        log.push('call');
        return options.resolveDispute();
      },
      readObligation: async () => null,
      dispute: async () => {
        log.push('tell');
        return { disputeId: 'ECO' };
      },
    };
    const activities = createActivities({
      orders: orders as unknown as OrderService,
      economic: economic as unknown as EconomicClient,
      currentStep: () => ({ key: 'k', scheduledAt: new Date() }),
    });
    const release = () => activities.resolveObligationDispute('ORD_R', 'TX', 'DSP', 'SETTLE');
    return { log, release, activities };
  }
  const args = JSON.stringify([
    { id: 'ORD_R', organizationId: 'ORG_B' },
    'resolveObligationDispute',
    'DSP',
  ]);
  // With the generation this attempt's own opening was given.
  const confirmArgs = `${args.slice(0, -1)},7]`;

  it('opens before the call and confirms after it, under the buying tenant', async () => {
    const { log, release } = build({ resolveDispute: async () => ({}) });

    await release();

    expect(log).toEqual([`open ${args}`, 'call', `confirm ${confirmArgs}`]);
  });

  it('confirms a retry answered from the step record', async () => {
    const { log, release } = build({ resolveDispute: async () => ({}), recorded: true });

    await release();

    expect(log).toEqual([`open ${args}`, 'answered from the record', `confirm ${confirmArgs}`]);
  });

  it('opens when economic-service is told of the dispute, before the telling', async () => {
    const { log, activities } = build({ resolveDispute: async () => ({}) });

    await activities.disputeObligation('ORD_R', 'TX', 'DSP', 'it does not fit');

    expect(log).toEqual([`open ${args}`, 'tell']);
  });

  it('stays open when the call fails', async () => {
    const { log, release } = build({ resolveDispute: () => Promise.reject(new Error('down')) });

    await expect(release()).rejects.toThrow();

    expect(log).toEqual([`open ${args}`, 'call']);
  });
});
