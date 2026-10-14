import { EXPIRY_SWEEP_INTERVAL_MS, InsuranceExpirySweepScheduler } from './expiry-sweep.scheduler';
import type { InsuranceService } from './insurance.service';

/**
 * Codex r3 on #247: the expiry sweep stops with the relay and the purge, in
 * the destroy phase, by their shared deadline — no new batch once stopping,
 * no wait past the deadline for the one in flight.
 */
describe('InsuranceExpirySweepScheduler', () => {
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
  type Sweep = InsuranceService['runExpirySweep'];

  const schedulerWith = (sweep: Sweep) => {
    const warnings: string[] = [];
    const scheduler = new InsuranceExpirySweepScheduler(
      { runExpirySweep: sweep } as unknown as InsuranceService,
      { warn: (_obj, msg) => warnings.push(msg) },
    );
    return { scheduler, warnings };
  };

  it('tells the sweep to stop between batches and waits for the batch in flight', async () => {
    let asked: (() => boolean) | undefined;
    let finishBatch!: () => void;
    const { scheduler } = schedulerWith(async (options) => {
      asked = options?.shouldStop;
      await new Promise<void>((resolve) => (finishBatch = resolve));
      return { warned: 0, expired: 0, held: 0 };
    });
    void scheduler.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    expect(asked?.()).toBe(false);

    let stopped = false;
    const stopping = scheduler.stop({ deadlineAt: Date.now() + 5000 }).then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(asked?.()).toBe(true);
    expect(stopped).toBe(false);
    finishBatch();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('returns by the deadline when the batch in flight never finishes, with a warning', async () => {
    const { scheduler, warnings } = schedulerWith(() => never());
    void scheduler.runOnce();
    const startedAt = Date.now();
    await scheduler.stop({ deadlineAt: Date.now() + 300 });
    const ms = Date.now() - startedAt;
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(1000);
    expect(warnings).toEqual([expect.stringMatching(/abandoned/)]);
  });

  it('runs on its interval until stopped, then never again; one stop', async () => {
    jest.useFakeTimers();
    try {
      let runs = 0;
      const { scheduler } = schedulerWith(async () => {
        runs += 1;
        return { warned: 0, expired: 0, held: 0 };
      });
      scheduler.start();
      jest.advanceTimersByTime(EXPIRY_SWEEP_INTERVAL_MS);
      await Promise.resolve();
      expect(runs).toBe(1);

      const first = scheduler.stop({ deadlineAt: Date.now() + 1000 });
      expect(scheduler.stop()).toBe(first);
      await first;
      jest.advanceTimersByTime(3 * EXPIRY_SWEEP_INTERVAL_MS);
      await scheduler.runOnce();
      expect(runs).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a failed sweep does not reject: the next interval retries', async () => {
    const { scheduler } = schedulerWith(() => Promise.reject(new Error('database down')));
    await expect(scheduler.runOnce()).resolves.toBeUndefined();
  });
});
