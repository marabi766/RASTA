import { RastaError } from '@rasta/nest-common';
import type { ClaimedRfq, RfqRepository } from './rfq.repository';
import type { RfqCloseResult, RfqCloseService, RfqCloseTarget } from './rfq-close.service';
import { RfqCloseSweeper } from './rfq-close.sweeper';

/**
 * What a sweep does with the RFQs it claimed — the bound on it, and the way one RFQ's failure is
 * kept from stalling the rest. The database behaviour (claim, fence, clock, deadline, races) is in
 * `test/rfq-close.int-spec.ts`.
 */

const claim = (id: string): ClaimedRfq => ({ id, organizationId: `ORG_${id}`, fence: 'F1' });

function sweeperWith(claimed: ClaimedRfq[], results: Record<string, RfqCloseResult | Error>) {
  const claimDue = jest.fn().mockResolvedValue(claimed);
  const close = jest.fn(async (target: RfqCloseTarget) => {
    const answer = results[target.rfqId] ?? 'CLOSED';
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const recordFailure = jest.fn().mockResolvedValue(undefined);
  const sweeper = new RfqCloseSweeper(
    { claimDue } as unknown as RfqRepository,
    { close, recordFailure } as unknown as RfqCloseService,
    {
      intervalMs: 5000,
      batchSize: 7,
      leaseSeconds: 45,
      retryBackoffBaseSeconds: 10,
      retryBackoffMaxSeconds: 900,
    },
  );
  return { sweeper, claimDue, close, recordFailure };
}

describe('RfqCloseSweeper', () => {
  it('claims at most the configured batch, for the configured lease, under one fence', async () => {
    const { sweeper, claimDue } = sweeperWith([], {});

    expect(await sweeper.runOnce()).toEqual({
      claimed: 0,
      closed: 0,
      noop: 0,
      notDue: 0,
      lost: 0,
      failed: 0,
    });
    expect(claimDue).toHaveBeenCalledWith(7, 45, expect.stringMatching(/^[0-9A-Z]{26}$/));
  });

  it('closes each claimed RFQ in its own organization under the fence it claimed with, and counts each result', async () => {
    const { sweeper, close } = sweeperWith(
      [claim('A'), claim('B'), claim('C'), claim('D'), claim('E')],
      { B: 'NOOP', C: 'NOT_DUE', D: 'NOT_OWNER', E: 'NOT_FOUND' },
    );

    const outcome = await sweeper.runOnce();

    expect(close).toHaveBeenCalledWith({ organizationId: 'ORG_A', rfqId: 'A', fence: 'F1' });
    expect(outcome).toEqual({ claimed: 5, closed: 1, noop: 2, notDue: 1, lost: 1, failed: 0 });
  });

  it('one RFQ failing records its failure with the backoff and never stops the rest', async () => {
    const { sweeper, recordFailure } = sweeperWith([claim('A'), claim('B')], {
      A: RastaError.forbidden('x'),
    });

    const outcome = await sweeper.runOnce();

    expect(outcome).toMatchObject({ claimed: 2, closed: 1, failed: 1 });
    expect(recordFailure).toHaveBeenCalledWith(
      { organizationId: 'ORG_A', rfqId: 'A', fence: 'F1' },
      { baseSeconds: 10, maxSeconds: 900 },
    );
  });

  it('a failure to record the failure is logged, and the lease is the fallback', async () => {
    const { sweeper, recordFailure } = sweeperWith([claim('A'), claim('B')], {
      A: new Error('database down'),
    });
    recordFailure.mockRejectedValueOnce(new Error('still down'));

    await expect(sweeper.runOnce()).resolves.toMatchObject({ failed: 1, closed: 1 });
  });

  it('stopped, it closes nothing more, runs no timer, and stops once', async () => {
    const { sweeper, close } = sweeperWith([claim('A')], {});
    await sweeper.stop({ deadlineAt: Date.now() + 1000 });
    sweeper.start();

    expect(await sweeper.runOnce()).toMatchObject({ claimed: 1, closed: 0 });
    expect(close).not.toHaveBeenCalled();
    await expect(sweeper.stop()).resolves.toBeUndefined();
  });

  it('runs on its timer, never overlapping itself, and waits for the sweep in flight when stopped', async () => {
    jest.useFakeTimers();
    try {
      let release!: () => void;
      const { sweeper, claimDue } = sweeperWith([], {});
      claimDue.mockImplementation(() => new Promise((resolve) => (release = () => resolve([]))));
      sweeper.start();
      sweeper.start();
      jest.advanceTimersByTime(5000);
      jest.advanceTimersByTime(5000);
      expect(claimDue).toHaveBeenCalledTimes(1);

      const stopping = sweeper.stop();
      release();
      await stopping;
      jest.advanceTimersByTime(20_000);
      expect(claimDue).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('abandons a sweep still running at the shutdown deadline', async () => {
    const { sweeper, claimDue } = sweeperWith([], {});
    claimDue.mockImplementation(() => new Promise(() => undefined));
    jest.useFakeTimers();
    try {
      sweeper.start();
      jest.advanceTimersByTime(5000);
    } finally {
      jest.useRealTimers();
    }
    await expect(sweeper.stop({ deadlineAt: Date.now() + 20 })).resolves.toBeUndefined();
  });

  it('a sweep that fails as a whole is logged and retried by the next tick', async () => {
    jest.useFakeTimers();
    try {
      const { sweeper, claimDue } = sweeperWith([], {});
      claimDue.mockRejectedValueOnce(new Error('database down'));
      sweeper.start();
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(5000);
      await sweeper.stop();
      expect(claimDue.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
