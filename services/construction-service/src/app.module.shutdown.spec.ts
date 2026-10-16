import 'reflect-metadata';
import {
  OutboxPurgeScheduler,
  OutboxRelay,
  OutboxShutdown,
  type EventConsumer,
  type OutboxStopOptions,
} from '@rasta/nest-common';
import { AppModule } from './app.module';
import { PolicyReconciliationSweeper } from './approval/policy-reconciliation.sweeper';
import { OrganizationMovedConsumer } from './events/organization-moved.consumer';
import { SupplierStandingConsumer } from './events/supplier-standing.consumer';
import { AwardStandingCheckSweeper } from './tender/award-standing-check.sweeper';
import { StandingBootstrap } from './tender/standing-bootstrap';
import { TenderCloseSweeper } from './tender/tender-close.sweeper';
import { ENV } from './tokens';

/**
 * Codex r1 on #277 (Medium): `AppModule.onApplicationShutdown` stopped both
 * Kafka consumers, one after the other, with no bound, after the relay, the
 * purge and the sweeps had drained, so their waits came on top of the relay's.
 * They are now `OutboxShutdown` workers, stopped beside the rest by the one
 * deadline — as is the standing bootstrap (#279, D-052 phase 3). This reads the
 * wiring without a database or a broker: AppModule's own factory, called with
 * stand-ins for what it injects. The consumer's own behaviour under a deadline
 * is nest-common's `event-consumer.stop.spec.ts`; the whole close is
 * `test/outbox-shutdown.int-spec.ts`.
 */
interface FactoryProvider {
  provide: unknown;
  inject?: unknown[];
  useFactory: (...args: unknown[]) => unknown;
}

function outboxShutdownProviders(): FactoryProvider[] {
  const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as unknown[];
  return providers.filter(
    (provider): provider is FactoryProvider =>
      typeof provider === 'object' &&
      provider !== null &&
      (provider as { provide?: unknown }).provide === OutboxShutdown,
  );
}

function outboxShutdownProvider(): FactoryProvider {
  const [found] = outboxShutdownProviders();
  if (!found) throw new Error('AppModule provides no OutboxShutdown');
  return found;
}

/** Calls the factory with recording stand-ins; returns each token's stop calls. */
async function stopThroughFactory(): Promise<{
  inject: unknown[];
  stops: Map<unknown, (OutboxStopOptions | undefined)[]>;
}> {
  const provider = outboxShutdownProvider();
  const inject = provider.inject ?? [];
  const stops = new Map<unknown, (OutboxStopOptions | undefined)[]>();
  const args = inject.map((token) =>
    token === ENV
      ? { SHUTDOWN_TIMEOUT_MS: 25_000 }
      : {
          stop: async (options?: OutboxStopOptions) => {
            stops.set(token, [...(stops.get(token) ?? []), options]);
          },
        },
  );
  await (provider.useFactory(...args) as OutboxShutdown).stop();
  return { inject, stops };
}

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

describe('AppModule shutdown wiring (D-052)', () => {
  it('has one OutboxShutdown, holding the relay, the purge and every worker', async () => {
    // Two declarations would let the later replace the earlier, silently
    // dropping its workers (the #277/#279 merge).
    expect(outboxShutdownProviders()).toHaveLength(1);

    const { inject, stops } = await stopThroughFactory();

    const expected = [
      OutboxRelay,
      OutboxPurgeScheduler,
      PolicyReconciliationSweeper,
      TenderCloseSweeper,
      AwardStandingCheckSweeper,
      OrganizationMovedConsumer,
      SupplierStandingConsumer,
      StandingBootstrap,
    ];
    expect(new Set(inject)).toEqual(new Set([...expected, ENV]));
    expect(inject).toHaveLength(expected.length + 1);
    for (const token of expected) expect(stops.get(token)).toHaveLength(1);
    expect(stops.size).toBe(expected.length);
  });

  it('stops the relay and the standing bootstrap together, by one deadline', async () => {
    const { inject, stops } = await stopThroughFactory();
    const deadlines = new Map([...stops].map(([token, calls]) => [token, calls[0]?.deadlineAt]));

    expect(inject).toEqual(expect.arrayContaining([OutboxRelay, StandingBootstrap]));
    expect(deadlines.size).toBe(inject.length - 1);
    expect(new Set(deadlines.values()).size).toBe(1);
    expect(deadlines.get(StandingBootstrap)).toBeGreaterThan(Date.now());
  });
});

describe('AppModule shutdown wiring (Codex r1 on #277)', () => {
  it('stops both consumers with the relay, the purge and the sweeps, by one deadline', async () => {
    const before = Date.now();
    const { inject, stops } = await stopThroughFactory();

    expect(inject).toEqual(
      expect.arrayContaining([OrganizationMovedConsumer, SupplierStandingConsumer]),
    );
    expect(stops.size).toBe(inject.length - 1);
    expect(stops.get(OrganizationMovedConsumer)).toHaveLength(1);
    expect(stops.get(SupplierStandingConsumer)).toHaveLength(1);
    const deadlines = new Set([...stops.values()].map((calls) => calls[0]?.deadlineAt));
    expect(deadlines.size).toBe(1);
    const [deadlineAt] = [...deadlines];
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 23_000);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 23_000);
  });

  it.each([
    ['OrganizationMovedConsumer', OrganizationMovedConsumer],
    ['SupplierStandingConsumer', SupplierStandingConsumer],
  ] as const)('%s passes the deadline to its EventConsumer', async (_name, Consumer) => {
    const consumerStop = jest.fn(async (_options?: OutboxStopOptions) => undefined);
    const consumer = new Consumer(
      () => ({ start: async () => undefined, stop: consumerStop }) as unknown as EventConsumer,
      {} as never,
      silent,
    );
    await consumer.start();

    await consumer.stop({ deadlineAt: 1234 });

    expect(consumerStop.mock.calls).toEqual([[{ deadlineAt: 1234 }]]);
  });

  it.each([
    ['OrganizationMovedConsumer', OrganizationMovedConsumer],
    ['SupplierStandingConsumer', SupplierStandingConsumer],
  ] as const)('%s stopped before it started has nothing to wait for', async (_name, Consumer) => {
    const consumer = new Consumer(
      () => {
        throw new Error('never built');
      },
      {} as never,
      silent,
    );
    await expect(consumer.stop({ deadlineAt: 1234 })).resolves.toBeUndefined();
  });

  it('AppModule no longer stops the consumers or the bootstrap on its own in onApplicationShutdown', async () => {
    const movesStop = jest.fn(async () => undefined);
    const standingStop = jest.fn(async () => undefined);
    const bootstrapStop = jest.fn(async () => undefined);
    const outboxStop = jest.fn(async () => undefined);
    const module = Object.create(AppModule.prototype) as AppModule;
    Object.assign(module, {
      moves: { stop: movesStop },
      standing: { stop: standingStop },
      bootstrap: { stop: bootstrapStop },
      outboxShutdown: { stop: outboxStop },
    });

    await module.onApplicationShutdown();

    expect(outboxStop).toHaveBeenCalledTimes(1);
    expect(movesStop).not.toHaveBeenCalled();
    expect(standingStop).not.toHaveBeenCalled();
    expect(bootstrapStop).not.toHaveBeenCalled();
  });
});
