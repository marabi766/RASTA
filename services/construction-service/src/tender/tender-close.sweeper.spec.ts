import type { ClaimedTender, TenderCloseRepository } from './tender-close.repository';
import type { CloseResult, TenderCloseService } from './tender-close.service';
import { TenderCloseSweeper } from './tender-close.sweeper';

/**
 * What a sweep does with what it claimed — the bound on it and the way one tender's
 * failure is kept from stalling the rest. The database behaviour (claim, fence, clock,
 * races) is in `test/tender-close.int-spec.ts`.
 */

const claim = (id: string): ClaimedTender => ({ id, organizationId: `ORG_${id}`, fence: 'F1' });

function sweeperWith(claimed: ClaimedTender[], results: Record<string, CloseResult | Error>) {
  const claimDue = jest.fn().mockResolvedValue(claimed);
  const close = jest.fn(async (target: { tenderId: string }) => {
    const result = results[target.tenderId] ?? 'CLOSED';
    if (result instanceof Error) throw result;
    return result;
  });
  const recordFailure = jest.fn().mockResolvedValue(undefined);
  const sweeper = new TenderCloseSweeper(
    { claimDue } as unknown as TenderCloseRepository,
    { close, recordFailure } as unknown as TenderCloseService,
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

describe('TenderCloseSweeper', () => {
  it('claims at most the configured batch, for the configured lease, under one fence', async () => {
    const { sweeper, claimDue } = sweeperWith([], {});

    await sweeper.runOnce();

    expect(claimDue).toHaveBeenCalledWith(7, 45, expect.stringMatching(/^[0-9A-Z]{26}$/));
  });

  it('closes each claimed tender in its own organization, under the fence it claimed with', async () => {
    const { sweeper, close } = sweeperWith([claim('A'), claim('B')], {});

    const outcome = await sweeper.runOnce();

    expect(close).toHaveBeenCalledWith({ organizationId: 'ORG_A', tenderId: 'A', fence: 'F1' });
    expect(close).toHaveBeenCalledWith({ organizationId: 'ORG_B', tenderId: 'B', fence: 'F1' });
    expect(outcome).toEqual({ claimed: 2, closed: 2, noop: 0, notDue: 0, lost: 0, failed: 0 });
  });

  it('counts every result, and a failure does not stall the rest of the batch', async () => {
    const { sweeper, close } = sweeperWith(
      [claim('A'), claim('B'), claim('C'), claim('D'), claim('E')],
      {
        A: 'NOOP',
        B: new Error('the database went away'),
        C: 'NOT_DUE',
        D: 'NOT_OWNER',
        E: 'CLOSED',
      },
    );

    const outcome = await sweeper.runOnce();

    expect(close).toHaveBeenCalledTimes(5);
    expect(outcome).toEqual({ claimed: 5, closed: 1, noop: 1, notDue: 1, lost: 1, failed: 1 });
  });

  it('records a failure with the configured backoff, only for the tender that failed', async () => {
    const { sweeper, recordFailure } = sweeperWith([claim('A'), claim('B')], {
      B: new Error('boom'),
    });

    await sweeper.runOnce();

    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith(
      { organizationId: 'ORG_B', tenderId: 'B', fence: 'F1' },
      { baseSeconds: 10, maxSeconds: 900 },
    );
  });

  it('survives a failure that cannot even be recorded', async () => {
    const { sweeper, recordFailure } = sweeperWith([claim('A'), claim('B')], {
      A: new Error('boom'),
    });
    recordFailure.mockRejectedValueOnce(new Error('still down'));

    const outcome = await sweeper.runOnce();

    expect(outcome).toEqual({ claimed: 2, closed: 1, noop: 0, notDue: 0, lost: 0, failed: 1 });
  });

  it('does nothing when nothing is overdue', async () => {
    const { sweeper, close } = sweeperWith([], {});

    expect(await sweeper.runOnce()).toEqual({
      claimed: 0,
      closed: 0,
      noop: 0,
      notDue: 0,
      lost: 0,
      failed: 0,
    });
    expect(close).not.toHaveBeenCalled();
  });

  /**
   * D-052: the sweep stops with the relay and the purge, in the destroy phase, by
   * their shared deadline — no new tender once stopping, and no wait past the
   * deadline for the one being closed.
   */
  describe('stop', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    /** A sweep the timer started over three tenders, held in closing the first. */
    async function heldInTheFirstClose() {
      const built = sweeperWith([claim('A'), claim('B'), claim('C')], {});
      let finish: () => void = () => undefined;
      built.close.mockImplementationOnce(
        () =>
          new Promise<CloseResult>((resolve) => {
            finish = () => resolve('CLOSED');
          }),
      );
      built.sweeper.start();
      await jest.advanceTimersByTimeAsync(5000);
      expect(built.close).toHaveBeenCalledTimes(1);
      return { ...built, finish: () => finish() };
    }

    it('starts no further tender once stopping, and waits for the one being closed', async () => {
      const { sweeper, close, finish } = await heldInTheFirstClose();

      let stopped = false;
      const stopping = sweeper.stop({ deadlineAt: Date.now() + 5000 }).then(() => {
        stopped = true;
      });
      await jest.advanceTimersByTimeAsync(100);
      expect(stopped).toBe(false);

      finish();
      await stopping;
      expect(close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith({ organizationId: 'ORG_A', tenderId: 'A', fence: 'F1' });
    });

    it('returns by the deadline when the close in flight never finishes', async () => {
      const { sweeper } = await heldInTheFirstClose();

      let stopped = false;
      const stopping = sweeper.stop({ deadlineAt: Date.now() + 300 }).then(() => {
        stopped = true;
      });
      await jest.advanceTimersByTimeAsync(299);
      expect(stopped).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopped).toBe(true);
    });

    it('clears its timer, returns at once when idle, and is one stop', async () => {
      const { sweeper, claimDue } = sweeperWith([], {});
      sweeper.start();

      const first = sweeper.stop({ deadlineAt: Date.now() + 1000 });
      expect(sweeper.stop()).toBe(first);
      await first;
      sweeper.start(); // not once stopped
      await jest.advanceTimersByTimeAsync(3 * 5000);
      expect(claimDue).not.toHaveBeenCalled();
    });
  });
});
