import { registry } from '@rasta/observability';
import type { SagaStartStore } from './saga-start.store';
import { OrderSagaClient } from './saga.client';
import type { MarketplaceEnv } from '../config/env';
import {
  DISPUTE_ORIGINS,
  DISPUTE_RELEASE_STATUSES,
  SAGA_CUSTODY,
  SAGA_CUSTODY_STATUSES,
  TERMINAL_STATUSES,
} from '../order/state-machine';

jest.mock('./runtime-logger', () => ({ installTemporalRuntimeLogger: jest.fn() }));

/**
 * #770 r2 F3: unresolved financial state is a gauge of state, sampled whether
 * or not a worker runs, and never left frozen at a healthy-looking value: a
 * sample that fails, or a starter that stopped, withdraws the series so the
 * alert reads it as unknown and keeps firing.
 */
const env = { MARKETPLACE_TEMPORAL_ENABLED: false } as unknown as MarketplaceEnv;

async function series(name: string): Promise<Record<string, number>> {
  const metric = await registry.getSingleMetric(name)?.get();
  return Object.fromEntries(
    (metric?.values ?? []).map((value) => [String(value.labels.reason ?? ''), value.value]),
  );
}

const healthy = {
  backlog: async () => ({ count: 0, age: 0 }),
  unresolved: async () => [
    { reason: 'SETTLING', count: 2, age: 4000 },
    { reason: 'DISPUTE_RELEASE', count: 0, age: 0 },
  ],
};

describe('saga state gauges (#770 r2 F3)', () => {
  it('reports unresolved orders and their age by reason, with no worker at all', async () => {
    const client = new OrderSagaClient(env, healthy as unknown as SagaStartStore);
    await client.tick();
    expect(await series('rasta_marketplace_saga_unresolved_orders')).toEqual({
      SETTLING: 2,
      DISPUTE_RELEASE: 0,
    });
    expect(await series('rasta_marketplace_saga_unresolved_age_seconds')).toEqual({
      SETTLING: 4000,
      DISPUTE_RELEASE: 0,
    });
    await client.stop();
  });

  it('withdraws a series whose sample failed instead of keeping the last value', async () => {
    let broken = false;
    const store = {
      backlog: async () => {
        if (broken) throw new Error('db down');
        return { count: 1, age: 30 };
      },
      unresolved: async () => {
        if (broken) throw new Error('db down');
        return healthy.unresolved();
      },
    } as unknown as SagaStartStore;
    const client = new OrderSagaClient(env, store);
    await client.tick();
    expect(await series('rasta_marketplace_saga_unresolved_age_seconds')).not.toEqual({});
    expect(await series('rasta_marketplace_saga_start_backlog_age_seconds')).not.toEqual({});

    broken = true;
    await client.tick();
    expect(await series('rasta_marketplace_saga_unresolved_orders')).toEqual({});
    expect(await series('rasta_marketplace_saga_unresolved_age_seconds')).toEqual({});
    expect(await series('rasta_marketplace_saga_start_backlog_age_seconds')).toEqual({});
    expect(await series('rasta_marketplace_saga_start_backlog')).toEqual({});
    await client.stop();
  });

  it('samples the state even when claiming failed', async () => {
    const unresolved = jest.fn(healthy.unresolved);
    const client = new OrderSagaClient(
      { MARKETPLACE_TEMPORAL_ENABLED: true } as unknown as MarketplaceEnv,
      {
        ...healthy,
        unresolved,
        claim: async () => {
          throw new Error('claim failed');
        },
      } as unknown as SagaStartStore,
    );
    await client.tick();
    expect(unresolved).toHaveBeenCalledTimes(1);
    expect(await series('rasta_marketplace_saga_unresolved_orders')).toHaveProperty('SETTLING', 2);
    await client.stop();
  });

  it('withdraws every state series once stopped, including a read that finishes after', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const store = {
      backlog: async () => ({ count: 0, age: 0 }),
      unresolved: async () => {
        await gate;
        return healthy.unresolved();
      },
    } as unknown as SagaStartStore;
    const client = new OrderSagaClient(env, store);
    const tick = client.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const stop = client.stop();
    finish();
    await Promise.all([tick, stop]);
    for (const name of [
      'rasta_marketplace_saga_unresolved_orders',
      'rasta_marketplace_saga_unresolved_age_seconds',
      'rasta_marketplace_saga_start_backlog',
      'rasta_marketplace_saga_start_backlog_age_seconds',
    ]) {
      expect(await series(name)).toEqual({});
    }
  });
});

describe('saga custody (#770 r2 F3)', () => {
  it('classifies terminal statuses exactly as the state machine does', () => {
    const terminal = Object.entries(SAGA_CUSTODY)
      .filter(([, who]) => who === 'TERMINAL')
      .map(([status]) => status);
    expect(terminal.sort()).toEqual([...TERMINAL_STATUSES].sort());
  });

  it('puts every step the saga drives with economic-service in its custody', () => {
    expect([...SAGA_CUSTODY_STATUSES].sort()).toEqual(
      ['CANCELLING', 'PENDING', 'RECEIPT_CONFIRMED', 'SETTLING'].sort(),
    );
  });

  it('watches every status a SETTLE can resume to for an unreleased dispute', () => {
    // A dispute origin is where SETTLE returns the order (D-083): outside the
    // saga's custody, only the release says the obligation left DISPUTED.
    for (const origin of DISPUTE_ORIGINS) {
      const watched = SAGA_CUSTODY[origin] === 'SAGA' || DISPUTE_RELEASE_STATUSES.includes(origin);
      expect({ origin, watched }).toEqual({ origin, watched: true });
    }
    expect(DISPUTE_RELEASE_STATUSES).not.toContain('DISPUTED');
  });
});
