import { flushOutbox } from './flush.command';

/** The loop's decisions, with a fake clock: no broker, no database, no real waiting. */
describe('outbox:flush loop (#240 r5)', () => {
  function harness(batches: number[], leftAfter: number[]) {
    let clock = 0;
    const slept: number[] = [];
    let i = 0;
    return {
      slept,
      options: (maxSeconds = 300) => ({
        tick: async () => batches[Math.min(i, batches.length - 1)]!,
        unpublished: async () => leftAfter[Math.min(i++, leftAfter.length - 1)]!,
        maxSeconds,
        pollMs: 500,
        now: () => clock,
        sleep: async (ms: number) => {
          slept.push(ms);
          clock += ms;
        },
      }),
    };
  }

  it('is drained at once when nothing is unpublished', async () => {
    const h = harness([0], [0]);
    await expect(flushOutbox(h.options())).resolves.toEqual({
      drained: true,
      timedOut: false,
      published: 0,
      unpublished: 0,
      ticks: 1,
    });
    expect(h.slept).toEqual([]);
  });

  it('keeps going without waiting while batches publish, and stops at zero', async () => {
    const h = harness([100, 100, 40], [140, 40, 0]);
    const report = await flushOutbox(h.options());
    expect(report).toMatchObject({ drained: true, published: 240, ticks: 3 });
    expect(h.slept).toEqual([]);
  });

  it('waits when a batch published nothing (rows in backoff or under a lease)', async () => {
    const h = harness([0, 0, 3], [3, 3, 0]);
    const report = await flushOutbox(h.options());
    expect(report).toMatchObject({ drained: true, published: 3, ticks: 3 });
    expect(h.slept).toEqual([500, 500]);
  });

  it('gives up at the deadline, reporting what is left; never reports drained', async () => {
    const h = harness([0], [2]);
    const report = await flushOutbox(h.options(2));
    expect(report).toMatchObject({ drained: false, timedOut: true, unpublished: 2 });
    // 500 ms steps up to the 2 s deadline.
    expect(h.slept.reduce((a, b) => a + b, 0)).toBe(2000);
  });

  it('does not sleep past the deadline', async () => {
    const h = harness([0], [1]);
    await flushOutbox({ ...h.options(1), pollMs: 5000 });
    expect(h.slept).toEqual([1000]);
  });

  it('propagates a publish error rather than reporting it as a timeout', async () => {
    const h = harness([0], [1]);
    await expect(
      flushOutbox({
        ...h.options(),
        tick: async () => {
          throw new Error('broker unreachable');
        },
      }),
    ).rejects.toThrow('broker unreachable');
  });
});
