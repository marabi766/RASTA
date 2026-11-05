import { NativeConnection, Worker } from '@temporalio/worker';
import { sagaWorkerUp } from '../observability/metrics';
import { LIVENESS_PROBE_INTERVAL_MS, OrderSagaWorker } from './worker';

jest.mock('./runtime-logger', () => ({ installTemporalRuntimeLogger: jest.fn() }));
jest.mock('@temporalio/worker', () => ({
  NativeConnection: { connect: jest.fn() },
  Worker: { create: jest.fn() },
}));

/**
 * FU-104: a worker that failed or stopped polling used only to log. The
 * liveness gauge is 1 only while the SDK says RUNNING **and** Temporal lists
 * this worker's identity among the pollers of both task queues; anything else,
 * including not knowing, is 0.
 */
const env = {
  MARKETPLACE_TEMPORAL_ENABLED: true,
  TEMPORAL_ADDRESS: 'localhost:7233',
  TEMPORAL_NAMESPACE: 'default',
  MARKETPLACE_TEMPORAL_TASK_QUEUE: 'q',
  SHUTDOWN_TIMEOUT_MS: 2_100,
};

async function up(): Promise<number | undefined> {
  const metric = await sagaWorkerUp.get();
  return metric.values.find((value) => value.labels.service === 'marketplace-service')?.value;
}

type Pollers = (type: number, identity: string) => { identity: string }[] | null | undefined;

function build(options: { pollers?: Pollers; state?: () => string } = {}) {
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const run = jest.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  );
  const getState = jest.fn(options.state ?? (() => 'RUNNING'));
  const pollers = options.pollers ?? ((_type, identity) => [{ identity: 'other' }, { identity }]);
  let identity = '';
  const describeTaskQueue = jest.fn(async (request: { taskQueueType: number }) => ({
    pollers: pollers(request.taskQueueType, identity),
  }));
  const withDeadline = jest.fn((_deadline: number, fn: () => Promise<unknown>) => fn());
  (NativeConnection.connect as jest.Mock).mockResolvedValue({
    close: jest.fn(async () => undefined),
    withDeadline,
    workflowService: { describeTaskQueue },
  });
  (Worker.create as jest.Mock).mockImplementation(async (options: { identity: string }) => {
    identity = options.identity;
    return { run, shutdown: jest.fn(), getState };
  });
  const worker = new OrderSagaWorker(env as never, {} as never, {} as never);
  return {
    worker,
    describeTaskQueue,
    withDeadline,
    getState,
    finish: () => finish(),
    fail: (error: Error) => fail(error),
  };
}

describe('OrderSagaWorker liveness (FU-104)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sagaWorkerUp.set({ service: 'marketplace-service' }, 1);
  });
  afterEach(() => jest.useRealTimers());

  it('is 1 when running and listed by Temporal on both queues under its own identity', async () => {
    const { worker, describeTaskQueue, withDeadline } = build();
    await worker.onApplicationBootstrap();
    await expect(worker.probeLiveness()).resolves.toBe(true);
    expect(await up()).toBe(1);

    const types = describeTaskQueue.mock.calls.map(([request]) => request.taskQueueType);
    expect(types).toEqual(expect.arrayContaining([1, 2]));
    expect(describeTaskQueue).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'default', taskQueue: { name: 'q' } }),
    );
    // Every question to the server is bounded.
    expect(withDeadline).toHaveBeenCalled();
    for (const [deadline] of withDeadline.mock.calls) {
      expect(deadline).toBeLessThanOrEqual(Date.now() + 5_000);
    }
    await worker.stop({ deadlineAt: Date.now() + 50 });
  });

  it('gives Temporal a unique identity, and matches only that one', async () => {
    const { worker } = build({ pollers: () => [{ identity: `${process.pid}@host` }] });
    await worker.onApplicationBootstrap();
    const { identity } = (Worker.create as jest.Mock).mock.calls[0]![0] as { identity: string };
    expect(identity).toMatch(/^marketplace-saga@.+\/\d+\/[0-9a-f-]{36}$/);
    await expect(worker.probeLiveness()).resolves.toBe(false);
    expect(await up()).toBe(0);
    await worker.stop({ deadlineAt: Date.now() + 50 });
  });

  it.each([
    ['no pollers at all', () => null],
    [
      'listed on the workflow queue only',
      (type: number, id: string) => (type === 1 ? [{ identity: id }] : []),
    ],
    [
      'listed on the activity queue only',
      (type: number, id: string) => (type === 2 ? [{ identity: id }] : []),
    ],
  ])('is 0 when %s (zero workers, or one that stopped polling)', async (_name, pollers) => {
    const { worker } = build({ pollers: pollers as Pollers });
    await worker.onApplicationBootstrap();
    await expect(worker.probeLiveness()).resolves.toBe(false);
    expect(await up()).toBe(0);
    await worker.stop({ deadlineAt: Date.now() + 50 });
  });

  it('is 0 when the server cannot be asked: unknown is down', async () => {
    const { worker, describeTaskQueue } = build();
    describeTaskQueue.mockRejectedValue(new Error('deadline exceeded'));
    await worker.onApplicationBootstrap();
    await expect(worker.probeLiveness()).resolves.toBe(false);
    expect(await up()).toBe(0);
    await worker.stop({ deadlineAt: Date.now() + 50 });
  });

  it('is 0 when the SDK no longer reports RUNNING, even while still listed', async () => {
    const { worker, getState } = build();
    await worker.onApplicationBootstrap();
    await expect(worker.probeLiveness()).resolves.toBe(true);
    getState.mockReturnValue('FAILED');
    await expect(worker.probeLiveness()).resolves.toBe(false);
    expect(await up()).toBe(0);
    await worker.stop({ deadlineAt: Date.now() + 50 });
  });

  it.each([
    ['fails', (h: ReturnType<typeof build>) => h.fail(new Error('poll failed'))],
    ['returns', (h: ReturnType<typeof build>) => h.finish()],
  ])('drops to 0 at once and stops probing when run() %s', async (_name, end) => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const harness = build();
    await harness.worker.onApplicationBootstrap();
    await harness.worker.probeLiveness();
    expect(await up()).toBe(1);

    end(harness);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await up()).toBe(0);

    const asked = harness.describeTaskQueue.mock.calls.length;
    jest.advanceTimersByTime(LIVENESS_PROBE_INTERVAL_MS * 3);
    expect(harness.describeTaskQueue.mock.calls.length).toBe(asked);
    // An explicit look after the end still reads 0.
    await expect(harness.worker.probeLiveness()).resolves.toBe(false);
    expect(await up()).toBe(0);
  });

  it('a look in flight when run() ends reports 0, not the answer it was waiting for', async () => {
    const harness = build();
    await harness.worker.onApplicationBootstrap();
    await expect(harness.worker.probeLiveness()).resolves.toBe(true);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const listed = harness.describeTaskQueue.getMockImplementation()!;
    harness.describeTaskQueue.mockImplementation(async (request) => {
      await gate;
      return listed(request);
    });
    const look = harness.worker.probeLiveness();
    harness.fail(new Error('poll failed'));
    await new Promise((resolve) => setImmediate(resolve));
    release();

    await expect(look).resolves.toBe(false);
    expect(await up()).toBe(0);
  });

  it('probes on an interval while running', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const { worker, describeTaskQueue } = build();
    await worker.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    const first = describeTaskQueue.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    jest.advanceTimersByTime(LIVENESS_PROBE_INTERVAL_MS);
    await new Promise((resolve) => setImmediate(resolve));
    expect(describeTaskQueue.mock.calls.length).toBeGreaterThan(first);
    jest.useRealTimers();
    await worker.stop({ deadlineAt: Date.now() + 50 });
  });

  it('is 0 from the moment stop begins', async () => {
    const { worker, describeTaskQueue } = build();
    await worker.onApplicationBootstrap();
    await worker.probeLiveness();
    expect(await up()).toBe(1);
    const stopping = worker.stop({ deadlineAt: Date.now() + 50 });
    expect(await up()).toBe(0);
    await expect(worker.probeLiveness()).resolves.toBe(false);
    await stopping;
    expect(describeTaskQueue).toHaveBeenCalled();
  });

  it('is 0 when the worker could not start', async () => {
    (NativeConnection.connect as jest.Mock).mockRejectedValue(new Error('unreachable'));
    const worker = new OrderSagaWorker(env as never, {} as never, {} as never);
    await worker.onApplicationBootstrap();
    expect(await up()).toBe(0);
    await expect(worker.probeLiveness()).resolves.toBe(false);
  });

  it('is 0 when Temporal is disabled', async () => {
    const worker = new OrderSagaWorker(
      { ...env, MARKETPLACE_TEMPORAL_ENABLED: false } as never,
      {} as never,
      {} as never,
    );
    await worker.onApplicationBootstrap();
    expect(await up()).toBe(0);
  });
});
