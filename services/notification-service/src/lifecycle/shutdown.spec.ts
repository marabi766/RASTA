import {
  NotificationShutdown,
  notificationShutdownBudgetMs,
  SHUTDOWN_RESERVE_MS,
  withinDeadline,
  type ShutdownStopOptions,
} from './shutdown';
import type { ScrubbedLogger } from '../logging/scrub';

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

function logger(): ScrubbedLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    info: () => undefined,
    warn: (message) => void warnings.push(message),
    error: () => undefined,
    debug: () => undefined,
  };
}

describe('notificationShutdownBudgetMs', () => {
  it('is SHUTDOWN_TIMEOUT_MS less the 2 s reserve', () => {
    expect(SHUTDOWN_RESERVE_MS).toBe(2_000);
    expect(notificationShutdownBudgetMs({ SHUTDOWN_TIMEOUT_MS: 25_000 })).toBe(23_000);
  });
});

describe('NotificationShutdown', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('stops the relay and every worker in the same call, the workers by the same deadline', async () => {
    const order: string[] = [];
    const seen: ShutdownStopOptions[] = [];
    const relay = {
      stop: jest.fn(async () => {
        order.push('relay');
      }),
    };
    const worker = (name: string) => ({
      stop: jest.fn(async (options?: ShutdownStopOptions) => {
        order.push(name);
        seen.push(options ?? {});
      }),
    });
    const resolution = worker('resolution');
    const mail = worker('mail');
    const shutdown = new NotificationShutdown({
      relay,
      workers: [resolution, mail],
      budgetMs: 7_000,
      now: () => 1_000,
    });

    await shutdown.onModuleDestroy();

    expect(order.sort()).toEqual(['mail', 'relay', 'resolution']);
    expect(seen).toEqual([{ deadlineAt: 8_000 }, { deadlineAt: 8_000 }]);
  });

  it('starts every stop before any of them returns', async () => {
    const started: string[] = [];
    const shutdown = new NotificationShutdown({
      relay: {
        stop: () => {
          started.push('relay');
          return never();
        },
      },
      workers: [
        {
          stop: () => {
            started.push('worker');
            return never();
          },
        },
      ],
      budgetMs: 1_000,
    });

    void shutdown.stop();

    expect(started).toEqual(['relay', 'worker']);
  });

  it('returns by the deadline when the relay never stops, and says so', async () => {
    jest.useFakeTimers();
    const log = logger();
    const shutdown = new NotificationShutdown({
      relay: { stop: () => never() },
      workers: [],
      budgetMs: 7_000,
      logger: log,
    });

    let returned = false;
    const stopping = shutdown.stop().then(() => {
      returned = true;
    });
    await jest.advanceTimersByTimeAsync(6_999);
    expect(returned).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await stopping;

    expect(log.warnings.join('\n')).toContain('abandoned');
  });

  it('is one stop: a later call joins the first', async () => {
    const relay = { stop: jest.fn(async () => undefined) };
    const shutdown = new NotificationShutdown({ relay, workers: [], budgetMs: 1_000 });

    const first = shutdown.stop();
    expect(shutdown.onModuleDestroy()).toBe(first);
    await first;
    await shutdown.stop();

    expect(relay.stop).toHaveBeenCalledTimes(1);
  });

  it('refuses a budget that leaves nothing for the drain', () => {
    const relay = { stop: async () => undefined };
    expect(() => new NotificationShutdown({ relay, workers: [], budgetMs: 0 })).toThrow(
      /SHUTDOWN_TIMEOUT_MS must be more than 2000 ms/,
    );
  });
});

describe('withinDeadline', () => {
  it('reports finished for work that ends, rejected work included', async () => {
    await expect(withinDeadline(Promise.resolve(), 1_000)).resolves.toBe('finished');
    await expect(withinDeadline(Promise.reject(new Error('x')), 1_000)).resolves.toBe('finished');
  });

  it('reports abandoned past the bound, or at once for a bound already spent', async () => {
    await expect(withinDeadline(never(), 10)).resolves.toBe('abandoned');
    await expect(withinDeadline(Promise.reject(new Error('late')), 0)).resolves.toBe('abandoned');
  });
});
