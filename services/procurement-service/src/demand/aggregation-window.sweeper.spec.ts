import type { ClaimedWindow, WindowSweepRepository } from './window-sweep.repository';
import type { SweepStep, SweepTarget, WindowSweepService } from './window-sweep.service';
import { AggregationWindowSweeper } from './aggregation-window.sweeper';

/**
 * What a sweep does with what it claimed — the bound on it, the steps of one large window, and the
 * way one window's failure is kept from stalling the rest. The database behaviour (claim, fence,
 * clock, races, batches) is in `test/window-sweep.int-spec.ts`.
 */

const claim = (id: string): ClaimedWindow => ({ id, organizationId: `ORG_${id}`, fence: 'F1' });

const step = (result: SweepStep['result'], pending = false): SweepStep => ({ result, pending });

/** Each window answers its steps in order; an `Error` is a failed step. */
function sweeperWith(claimed: ClaimedWindow[], steps: Record<string, (SweepStep | Error)[]>) {
  const claimDue = jest.fn().mockResolvedValue(claimed);
  const taken = new Map<string, number>();
  const stepFn = jest.fn(async (target: SweepTarget) => {
    const index = taken.get(target.aggregationId) ?? 0;
    taken.set(target.aggregationId, index + 1);
    const answer = steps[target.aggregationId]?.[index] ?? step('ENDED');
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const recordFailure = jest.fn().mockResolvedValue(undefined);
  const sweeper = new AggregationWindowSweeper(
    { claimDue } as unknown as WindowSweepRepository,
    { step: stepFn, recordFailure } as unknown as WindowSweepService,
    {
      intervalMs: 5000,
      batchSize: 7,
      leaseSeconds: 45,
      retryBackoffBaseSeconds: 10,
      retryBackoffMaxSeconds: 900,
    },
  );
  return { sweeper, claimDue, step: stepFn, recordFailure };
}

const NONE = { claimed: 0, ended: 0, followed: 0, noop: 0, notDue: 0, lost: 0, failed: 0 };

describe('AggregationWindowSweeper', () => {
  it('claims at most the configured batch, for the configured lease, under one fence', async () => {
    const { sweeper, claimDue } = sweeperWith([], {});

    await sweeper.runOnce();

    expect(claimDue).toHaveBeenCalledWith(7, 45, expect.stringMatching(/^[0-9A-Z]{26}$/));
  });

  it('sweeps each claimed window in its own organization, under the fence it claimed with, renewing with the lease', async () => {
    const { sweeper, step: stepFn } = sweeperWith([claim('A'), claim('B')], {});

    const outcome = await sweeper.runOnce();

    expect(stepFn).toHaveBeenCalledWith(
      { organizationId: 'ORG_A', aggregationId: 'A', fence: 'F1' },
      45,
    );
    expect(stepFn).toHaveBeenCalledWith(
      { organizationId: 'ORG_B', aggregationId: 'B', fence: 'F1' },
      45,
    );
    expect(outcome).toEqual({ ...NONE, claimed: 2, ended: 2 });
  });

  it('keeps stepping one window while anything of its end is left (its digest, its demands to follow), then goes on to the next', async () => {
    const { sweeper, step: stepFn } = sweeperWith([claim('A'), claim('B')], {
      A: [step('ENDED', true), step('FOLLOWED', true), step('FOLLOWED', true), step('FOLLOWED')],
    });

    const outcome = await sweeper.runOnce();

    expect(stepFn.mock.calls.map(([target]) => target.aggregationId)).toEqual([
      'A',
      'A',
      'A',
      'A',
      'B',
    ]);
    expect(outcome).toEqual({ ...NONE, claimed: 2, ended: 2, followed: 3 });
  });

  it('counts every result, and a failure does not stall the rest of the batch', async () => {
    const { sweeper, step: stepFn } = sweeperWith(
      [claim('A'), claim('B'), claim('C'), claim('D'), claim('E'), claim('F')],
      {
        A: [step('NOOP')],
        B: [new Error('the database went away')],
        C: [step('NOT_DUE')],
        D: [step('NOT_OWNER')],
        E: [step('ENDED')],
        F: [step('NOT_FOUND')],
      },
    );

    const outcome = await sweeper.runOnce();

    expect(stepFn).toHaveBeenCalledTimes(6);
    expect(outcome).toEqual({
      claimed: 6,
      ended: 1,
      followed: 0,
      noop: 2,
      notDue: 1,
      lost: 1,
      failed: 1,
    });
  });

  it('stops a window at its first failed step and records it with the configured backoff', async () => {
    const {
      sweeper,
      step: stepFn,
      recordFailure,
    } = sweeperWith([claim('A'), claim('B')], {
      A: [step('ENDED', true), new Error('boom'), step('FOLLOWED')],
    });

    await sweeper.runOnce();

    expect(stepFn.mock.calls.map(([target]) => target.aggregationId)).toEqual(['A', 'A', 'B']);
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith(
      { organizationId: 'ORG_A', aggregationId: 'A', fence: 'F1' },
      { baseSeconds: 10, maxSeconds: 900 },
    );
  });

  it('survives a failure that cannot even be recorded', async () => {
    const { sweeper, recordFailure } = sweeperWith([claim('A'), claim('B')], {
      A: [new Error('boom')],
    });
    recordFailure.mockRejectedValueOnce(new Error('still down'));

    const outcome = await sweeper.runOnce();

    expect(outcome).toEqual({ ...NONE, claimed: 2, ended: 1, failed: 1 });
  });

  it('does nothing when nothing is due', async () => {
    const { sweeper, step: stepFn } = sweeperWith([], {});

    expect(await sweeper.runOnce()).toEqual(NONE);
    expect(stepFn).not.toHaveBeenCalled();
  });

  /**
   * D-052: the sweep stops with the relay and the purge, in the destroy phase, by their shared
   * deadline — no new step once stopping, not even the next batch of the window in hand, and no
   * wait past the deadline for the one running.
   */
  describe('stop', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    /** A sweep the timer started over two windows, held in the first step of a large one. */
    async function heldInTheFirstStep() {
      const built = sweeperWith([claim('A'), claim('B')], {
        A: [step('ENDED', true), step('FOLLOWED', true)],
      });
      let finish: () => void = () => undefined;
      built.step.mockImplementationOnce(
        () =>
          new Promise<SweepStep>((resolve) => {
            finish = () => resolve(step('ENDED', true));
          }),
      );
      built.sweeper.start();
      await jest.advanceTimersByTimeAsync(5000);
      expect(built.step).toHaveBeenCalledTimes(1);
      return { ...built, finish: () => finish() };
    }

    it('starts no further step once stopping — not the next batch either — and waits for the one running', async () => {
      const { sweeper, step: stepFn, finish } = await heldInTheFirstStep();

      let stopped = false;
      const stopping = sweeper.stop({ deadlineAt: Date.now() + 5000 }).then(() => {
        stopped = true;
      });
      await jest.advanceTimersByTimeAsync(100);
      expect(stopped).toBe(false);

      finish();
      await stopping;
      expect(stepFn).toHaveBeenCalledTimes(1);
    });

    it('returns by the deadline when the step in flight never finishes', async () => {
      const { sweeper } = await heldInTheFirstStep();

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

    it('never overlaps itself: a slow sweep is followed by the next tick, not joined', async () => {
      const { sweeper, claimDue, finish } = await heldInTheFirstStep();

      await jest.advanceTimersByTimeAsync(3 * 5000);
      expect(claimDue).toHaveBeenCalledTimes(1);

      finish();
      await sweeper.stop({ deadlineAt: Date.now() + 1000 });
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
