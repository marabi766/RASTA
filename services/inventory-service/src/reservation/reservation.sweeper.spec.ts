import type { ReservationExpiry } from './expiry';
import type { ReservationRepository } from './reservation.repository';
import { ReservationSweeper } from './reservation.sweeper';

/**
 * The sweeper's own bookkeeping, without a database: what it counts, that one item failing never
 * stalls the batch, that a backlog is worked off batch after batch within one interval, and that
 * a sweep never overlaps the previous one. Its effect on real rows is `test/expiry.int-spec.ts`.
 */

const batch = (expired: number, backlog = false) => ({ item: {}, expired, backlog }) as never;

function sweeper(
  due: { organizationId: string; stockItemId: string }[],
  expireBatch: jest.Mock,
  intervalMs = 10_000,
) {
  const reservations = { dueItems: jest.fn(async () => due) } as unknown as ReservationRepository;
  const expiry = { expireBatch } as unknown as ReservationExpiry;
  return {
    sweeper: new ReservationSweeper(reservations, expiry, { intervalMs, batchSize: 5 }),
    reservations,
  };
}

describe('ReservationSweeper', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('counts what it expired, what another transaction held, and what failed — and carries on', async () => {
    const expireBatch = jest
      .fn()
      .mockResolvedValueOnce(batch(2))
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('connection reset'));
    const { sweeper: s } = sweeper(
      [
        { organizationId: 'ORG_1', stockItemId: 'SKI_1' },
        { organizationId: 'ORG_1', stockItemId: 'SKI_2' },
        { organizationId: 'ORG_2', stockItemId: 'SKI_3' },
      ],
      expireBatch,
    );

    expect(await s.runOnce()).toEqual({
      due: 3,
      expired: 2,
      skipped: 1,
      failed: 1,
      backlogged: 0,
    });
    expect(expireBatch).toHaveBeenCalledTimes(3);
    expect(expireBatch).toHaveBeenCalledWith('ORG_1', 'SKI_2', expect.any(String), 'sweeper');
  });

  it('works a backlog off in committed batches, one pass after another, every item in each pass', async () => {
    const expireBatch = jest
      .fn()
      .mockResolvedValueOnce(batch(5, true)) // SKI_1, pass 1
      .mockResolvedValueOnce(batch(1)) // SKI_2, pass 1: done
      .mockResolvedValueOnce(batch(5, true)) // SKI_1, pass 2
      .mockResolvedValueOnce(batch(3)); // SKI_1, pass 3: done
    const { sweeper: s } = sweeper(
      [
        { organizationId: 'ORG_1', stockItemId: 'SKI_1' },
        { organizationId: 'ORG_1', stockItemId: 'SKI_2' },
      ],
      expireBatch,
    );

    expect(await s.runOnce()).toEqual({
      due: 2,
      expired: 14,
      skipped: 0,
      failed: 0,
      backlogged: 0,
    });
    expect(expireBatch.mock.calls.map((call) => call[1])).toEqual([
      'SKI_1',
      'SKI_2',
      'SKI_1',
      'SKI_1',
    ]);
  });

  it('leaves what a sweep’s interval could not finish to the next sweep', async () => {
    // A clock of the test's own: each batch takes 8 ms of a 20 ms interval, whatever the host.
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const expireBatch = jest.fn(async () => {
      now += 8;
      return batch(5, true);
    });
    const { sweeper: s } = sweeper(
      [{ organizationId: 'ORG_1', stockItemId: 'SKI_1' }],
      expireBatch,
      20,
    );

    const outcome = await s.runOnce();
    // Passes end at 8 and 16 ms (under the interval) and at 24 ms (past it): three, then stop.
    expect(expireBatch).toHaveBeenCalledTimes(3);
    expect(outcome).toMatchObject({ expired: 15, backlogged: 1 });
  });

  it('does not pass again over a batch that expired nothing', async () => {
    const expireBatch = jest.fn(async () => batch(0, true));
    const { sweeper: s } = sweeper(
      [{ organizationId: 'ORG_1', stockItemId: 'SKI_1' }],
      expireBatch,
    );
    expect(await s.runOnce()).toMatchObject({ expired: 0, backlogged: 0 });
    expect(expireBatch).toHaveBeenCalledTimes(1);
  });

  it('does nothing when nothing is due', async () => {
    const expireBatch = jest.fn();
    const { sweeper: s } = sweeper([], expireBatch);
    expect(await s.runOnce()).toEqual({
      due: 0,
      expired: 0,
      skipped: 0,
      failed: 0,
      backlogged: 0,
    });
    expect(expireBatch).not.toHaveBeenCalled();
  });

  it('runs on its timer, never two sweeps at once, and survives a sweep that fails as a whole', async () => {
    jest.useFakeTimers();
    const { sweeper: s, reservations } = sweeper([], jest.fn(), 10);
    let finish: () => void = () => undefined;
    (reservations.dueItems as jest.Mock)
      .mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve([]))))
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue([]);

    s.start();
    s.start(); // a second start is a no-op
    jest.advanceTimersByTime(10);
    jest.advanceTimersByTime(10); // the first sweep is still running: no second one
    expect(reservations.dueItems).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(10); // fails as a whole — logged, not thrown
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(10);
    expect((reservations.dueItems as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);

    await s.stop();
    const calls = (reservations.dueItems as jest.Mock).mock.calls.length;
    jest.advanceTimersByTime(100);
    expect(reservations.dueItems).toHaveBeenCalledTimes(calls);
  });
});
