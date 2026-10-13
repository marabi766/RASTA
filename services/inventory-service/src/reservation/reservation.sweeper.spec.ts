import type { PrismaService } from '../prisma/prisma.service';
import type { StockRepository } from '../stock/stock.repository';
import type { ReservationExpiry } from './expiry';
import type { ReservationRepository } from './reservation.repository';
import { ReservationSweeper } from './reservation.sweeper';

/**
 * The sweeper's own bookkeeping, without a database: what it counts, that one item failing never
 * stalls the batch, and that a sweep never overlaps the previous one. Its effect on real rows is
 * `test/expiry.int-spec.ts`.
 */

const item = (version: number) => ({ id: 'SKI_1', organizationId: 'ORG_1', version }) as never;

function sweeper(
  due: { organizationId: string; stockItemId: string }[],
  lock: jest.Mock,
  expireDue: jest.Mock = jest.fn(async (_tx, locked: { version: number }) => ({
    ...locked,
    version: locked.version + 2,
  })),
) {
  const tx = {
    $queryRaw: jest.fn(async () => [{}]),
    $queryRawUnsafe: jest.fn(async () => [{ now: new Date('2026-10-13T10:00:00Z') }]),
  };
  const prisma = {
    transaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const reservations = { dueItems: jest.fn(async () => due) } as unknown as ReservationRepository;
  const stock = { lock } as unknown as StockRepository;
  const expiry = { expireDue } as unknown as ReservationExpiry;
  return {
    sweeper: new ReservationSweeper(prisma, reservations, stock, expiry, {
      intervalMs: 10,
      batchSize: 5,
      lockTimeoutMs: 100,
    }),
    reservations,
    expireDue,
  };
}

describe('ReservationSweeper', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('counts what it expired, what another transaction held, and what failed — and carries on', async () => {
    const lock = jest
      .fn()
      .mockResolvedValueOnce(item(1))
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('connection reset'));
    const { sweeper: s, expireDue } = sweeper(
      [
        { organizationId: 'ORG_1', stockItemId: 'SKI_1' },
        { organizationId: 'ORG_1', stockItemId: 'SKI_2' },
        { organizationId: 'ORG_2', stockItemId: 'SKI_3' },
      ],
      lock,
    );

    expect(await s.runOnce()).toEqual({ due: 3, expired: 2, skipped: 1, failed: 1 });
    expect(expireDue).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledWith(expect.anything(), 'ORG_1', 'SKI_2', { skipLocked: true });
  });

  it('does nothing when nothing is due', async () => {
    const lock = jest.fn();
    const { sweeper: s } = sweeper([], lock);
    expect(await s.runOnce()).toEqual({ due: 0, expired: 0, skipped: 0, failed: 0 });
    expect(lock).not.toHaveBeenCalled();
  });

  it('runs on its timer, never two sweeps at once, and survives a sweep that fails as a whole', async () => {
    jest.useFakeTimers();
    const lock = jest.fn();
    const { sweeper: s, reservations } = sweeper([], lock);
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
