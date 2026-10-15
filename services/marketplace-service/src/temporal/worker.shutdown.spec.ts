import { NativeConnection, Worker } from '@temporalio/worker';
import { OrderSagaWorker } from './worker';

jest.mock('./runtime-logger', () => ({ installTemporalRuntimeLogger: jest.fn() }));
jest.mock('@temporalio/worker', () => ({
  NativeConnection: { connect: jest.fn() },
  Worker: { create: jest.fn() },
}));

/**
 * Codex on #277 (finding 2): `onModuleDestroy` awaited `worker.run()` with no
 * deadline and `Worker.create()` set no `shutdownForceTime`, so an activity
 * awaiting economic-service (up to ECONOMIC_REQUEST_TIMEOUT_MS = 60 s, which
 * ignores Temporal cancellation) held the close past the whole
 * SHUTDOWN_TIMEOUT_MS.
 */
const env = {
  MARKETPLACE_TEMPORAL_ENABLED: true,
  TEMPORAL_ADDRESS: 'localhost:7233',
  TEMPORAL_NAMESPACE: 'default',
  MARKETPLACE_TEMPORAL_TASK_QUEUE: 'q',
  SHUTDOWN_TIMEOUT_MS: 2_100, // budget: 100 ms
};

/** `'stopped'` if `work` settles within 2 s, else `'hung'`; leaves no timer behind. */
async function settles(work: Promise<unknown>): Promise<'stopped' | 'hung'> {
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    work.then(() => 'stopped' as const),
    new Promise<'hung'>((resolve) => (timer = setTimeout(() => resolve('hung'), 2_000))),
  ]);
  clearTimeout(timer);
  return outcome;
}

function build(run: () => Promise<void>) {
  const shutdown = jest.fn();
  const close = jest.fn(async () => undefined);
  (NativeConnection.connect as jest.Mock).mockResolvedValue({ close });
  (Worker.create as jest.Mock).mockResolvedValue({ run, shutdown });
  const worker = new OrderSagaWorker(env as never, {} as never, {} as never);
  return { worker, shutdown, close };
}

describe('OrderSagaWorker shutdown (Codex on #277, finding 2)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('derives the SDK force time from the shutdown budget', async () => {
    const { worker } = build(() => new Promise<void>(() => undefined));
    await worker.onApplicationBootstrap();

    expect(Worker.create).toHaveBeenCalledWith(expect.objectContaining({ shutdownForceTime: 100 }));
  });

  it('returns at the shared deadline while an activity is still running', async () => {
    const { worker, shutdown, close } = build(() => new Promise<void>(() => undefined));
    await worker.onApplicationBootstrap();

    const started = Date.now();
    const outcome = await settles(worker.stop({ deadlineAt: started + 80 }));

    expect(outcome).toBe('stopped');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(shutdown).toHaveBeenCalledTimes(1);
    // The worker is abandoned, not closed under: the process is exiting.
    expect(close).not.toHaveBeenCalled();
  });

  it('bounds the destroy hook by the budget when OutboxShutdown did not stop it first', async () => {
    const { worker } = build(() => new Promise<void>(() => undefined));
    await worker.onApplicationBootstrap();

    const started = Date.now();
    const outcome = await settles(worker.onModuleDestroy());

    expect(outcome).toBe('stopped');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('closes the connection after a clean drain, and stops only once', async () => {
    let finish!: () => void;
    const { worker, shutdown, close } = build(() => new Promise<void>((r) => (finish = r)));
    await worker.onApplicationBootstrap();

    const first = worker.stop({ deadlineAt: Date.now() + 5_000 });
    expect(worker.stop()).toBe(first);
    finish();
    await first;

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when Temporal is disabled', async () => {
    const worker = new OrderSagaWorker(
      { ...env, MARKETPLACE_TEMPORAL_ENABLED: false } as never,
      {} as never,
      {} as never,
    );
    await worker.onApplicationBootstrap();
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
