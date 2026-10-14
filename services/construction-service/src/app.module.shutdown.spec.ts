import 'reflect-metadata';
import { OutboxShutdown, type EventConsumer, type OutboxStopOptions } from '@rasta/nest-common';
import { AppModule } from './app.module';
import { OrganizationMovedConsumer } from './events/organization-moved.consumer';
import { SupplierStandingConsumer } from './events/supplier-standing.consumer';
import { ENV } from './tokens';

/**
 * Codex r1 on #277 (Medium): `AppModule.onApplicationShutdown` stopped both
 * Kafka consumers, one after the other, with no bound, after the relay, the
 * purge and the sweeps had drained, so their waits came on top of the relay's.
 * They are now `OutboxShutdown` workers, stopped beside the rest by the one
 * deadline. This reads the wiring without a database or a broker: AppModule's
 * own factory, called with stand-ins for what it injects. The consumer's own
 * behaviour under a deadline is nest-common's `event-consumer.stop.spec.ts`;
 * the whole close is `test/outbox-shutdown.int-spec.ts`.
 */
interface FactoryProvider {
  provide: unknown;
  inject?: unknown[];
  useFactory: (...args: unknown[]) => unknown;
}

function outboxShutdownProvider(): FactoryProvider {
  const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as unknown[];
  const found = providers.find(
    (provider): provider is FactoryProvider =>
      typeof provider === 'object' &&
      provider !== null &&
      (provider as { provide?: unknown }).provide === OutboxShutdown,
  );
  if (!found) throw new Error('AppModule provides no OutboxShutdown');
  return found;
}

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

describe('AppModule shutdown wiring (Codex r1 on #277)', () => {
  it('stops both consumers with the relay, the purge and the sweeps, by one deadline', async () => {
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
    const shutdown = provider.useFactory(...args) as OutboxShutdown;

    const before = Date.now();
    await shutdown.stop();

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

  it('AppModule no longer stops the consumers on its own in onApplicationShutdown', async () => {
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
  });
});
