import { registry } from '@rasta/observability';
import type { SagaStartStore } from './saga-start.store';
import { OrderSagaClient } from './saga.client';
import {
  STATE_FRESH_MS,
  STATE_READ_TIMEOUT_MS,
  STATE_SAMPLE_INTERVAL_MS,
} from './saga-state-sample';
import type { MarketplaceEnv } from '../config/env';

jest.mock('./runtime-logger', () => ({ installTemporalRuntimeLogger: jest.fn() }));

/**
 * #770 r2 F3, #792 r1 F3: saga state is a gauge of state, sampled whether or
 * not a worker runs, on a timer of its own, and never left frozen at a
 * healthy-looking value: a sample that fails, times out, hangs or goes stale,
 * or a starter that stopped, withdraws the series so the alert reads it as
 * unknown and keeps firing.
 */
const env = { MARKETPLACE_TEMPORAL_ENABLED: false } as unknown as MarketplaceEnv;

async function series(name: string): Promise<Record<string, number>> {
  const metric = await registry.getSingleMetric(name)?.get();
  return Object.fromEntries(
    (metric?.values ?? []).map((value) => [String(value.labels.reason ?? ''), value.value]),
  );
}

// Economic readiness is the start gate (main), not part of sampling: proven here.
const economic = { provesHeldFunds: async () => true };
const healthy = { backlog: async () => ({ count: 2, age: 400 }) };

const STATE_SERIES = [
  'rasta_marketplace_saga_start_backlog',
  'rasta_marketplace_saga_start_backlog_age_seconds',
];

const never = () => new Promise<never>(() => undefined);

describe('saga state gauges (#770 r2 F3)', () => {
  afterEach(() => jest.useRealTimers());

  it('reports the start backlog and its age with no worker at all', async () => {
    const client = new OrderSagaClient(env, healthy as unknown as SagaStartStore, economic);
    await client.sampleState();
    expect(await series('rasta_marketplace_saga_start_backlog')).toEqual({ '': 2 });
    expect(await series('rasta_marketplace_saga_start_backlog_age_seconds')).toEqual({ '': 400 });
    await client.stop();
  });

  it('withdraws a series whose sample failed instead of keeping the last value', async () => {
    let broken = false;
    const store = {
      backlog: async () => {
        if (broken) throw new Error('db down');
        return { count: 1, age: 30 };
      },
    } as unknown as SagaStartStore;
    const client = new OrderSagaClient(env, store, economic);
    await client.sampleState();
    for (const name of STATE_SERIES) expect(await series(name)).not.toEqual({});

    broken = true;
    await client.sampleState();
    for (const name of STATE_SERIES) expect(await series(name)).toEqual({});
    await client.stop();
  });

  // #792 r1 F3: the review's probe. One good read, then a read that never
  // settles, then 720 polls: before, the good read's value stayed scrapeable.
  it('withdraws a hung read within its own deadline and keeps it withdrawn for 720 polls', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const backlog = jest
      .fn<Promise<unknown>, []>()
      .mockImplementationOnce(healthy.backlog)
      .mockImplementation(never);
    const client = new OrderSagaClient(env, { backlog } as unknown as SagaStartStore, economic);
    client.startPolling();
    await jest.advanceTimersByTimeAsync(0);
    expect(await series('rasta_marketplace_saga_start_backlog')).toEqual({ '': 2 });

    // The second read hangs; its own deadline withdraws it, long before freshness would.
    await jest.advanceTimersByTimeAsync(STATE_SAMPLE_INTERVAL_MS + STATE_READ_TIMEOUT_MS - 1);
    expect(await series('rasta_marketplace_saga_start_backlog')).toEqual({ '': 2 });
    await jest.advanceTimersByTimeAsync(1);
    for (const name of STATE_SERIES) expect(await series(name)).toEqual({});

    for (let poll = 0; poll < 720; poll += 1) {
      await jest.advanceTimersByTimeAsync(STATE_SAMPLE_INTERVAL_MS);
    }
    for (const name of STATE_SERIES) expect(await series(name)).toEqual({});
    // The hung read holds its slot: no pile of reads behind it.
    expect(backlog).toHaveBeenCalledTimes(2);

    // Stopping does not wait on the hung read past the read's own bound.
    const stopping = client.stop();
    await jest.advanceTimersByTimeAsync(STATE_READ_TIMEOUT_MS);
    await stopping;
    for (const name of STATE_SERIES) expect(await series(name)).toEqual({});
  });

  it('samples on its own timer while a claim hangs forever (independent of start delivery)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const backlog = jest.fn(healthy.backlog);
    let release!: (claims: unknown[]) => void;
    const claim = jest.fn(() => new Promise((resolve) => (release = resolve)));
    const client = new OrderSagaClient(
      { MARKETPLACE_TEMPORAL_ENABLED: true } as unknown as MarketplaceEnv,
      { backlog, claim } as unknown as SagaStartStore,
      economic,
    );
    client.startPolling();
    for (let poll = 0; poll < 10; poll += 1) {
      await jest.advanceTimersByTimeAsync(STATE_SAMPLE_INTERVAL_MS);
    }
    expect(claim).toHaveBeenCalledTimes(1);
    expect(backlog).toHaveBeenCalledTimes(11);
    expect(await series('rasta_marketplace_saga_start_backlog')).toEqual({ '': 2 });
    release([]);
    await client.stop();
  });

  it('drops an answer that comes after its deadline', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    let answer!: (value: unknown) => void;
    const client = new OrderSagaClient(
      env,
      {
        backlog: () => new Promise((resolve) => (answer = resolve)),
      } as unknown as SagaStartStore,
      economic,
    );
    const sampled = client.sampleState();
    await jest.advanceTimersByTimeAsync(STATE_READ_TIMEOUT_MS);
    await sampled;
    answer(await healthy.backlog());
    await jest.advanceTimersByTimeAsync(0);
    for (const name of STATE_SERIES) expect(await series(name)).toEqual({});
    await client.stop();
  });

  // Whatever stalls, the timer included: a scrape past the freshness horizon,
  // by the monotonic clock, finds nothing.
  it('withdraws at scrape a sample older than the freshness horizon, with no read since', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const client = new OrderSagaClient(env, healthy as unknown as SagaStartStore, economic);
    await client.sampleState();
    jest.advanceTimersByTime(STATE_FRESH_MS - 1);
    for (const name of STATE_SERIES) expect(await series(name)).not.toEqual({});
    jest.advanceTimersByTime(1);
    for (const name of STATE_SERIES) expect(await series(name)).toEqual({});
    await client.stop();
  });

  it('withdraws every state series once stopped, including a read that finishes after', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const store = {
      backlog: async () => {
        await gate;
        return healthy.backlog();
      },
    } as unknown as SagaStartStore;
    const client = new OrderSagaClient(env, store, economic);
    const sampled = client.sampleState();
    await new Promise((resolve) => setImmediate(resolve));
    const stop = client.stop();
    finish();
    await Promise.all([sampled, stop]);
    for (const name of STATE_SERIES) expect(await series(name)).toEqual({});
  });
});
