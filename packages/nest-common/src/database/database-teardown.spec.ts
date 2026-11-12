import { DatabaseTeardown } from './database-teardown';
import { createSafePrismaClient } from './safe-prisma-client';

afterEach(() => jest.useRealTimers());

it.each([undefined, {}, { deadlineAt: Number.NaN }])(
  'bounds direct shutdown with %p',
  async (options) => {
    jest.useFakeTimers();
    const disconnect = jest.fn(() => new Promise<void>(() => undefined));
    const raw = { $disconnect: disconnect, $extends: (_extension: unknown): object => raw };
    const safe = createSafePrismaClient(() => raw, 'DATABASE_URL_ASSET');
    const logger = { error: jest.fn() };
    const teardown = new DatabaseTeardown(safe, logger);
    let returned = false;
    const closing = teardown.stop(options).then((report) => {
      returned = true;
      return report;
    });
    await jest.advanceTimersByTimeAsync(23_000);
    expect(returned).toBe(true);
    await expect(closing).resolves.toEqual({ drained: false });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Database close ABANDONED at shutdown deadline; close UNCONFIRMED',
    );
  },
);
