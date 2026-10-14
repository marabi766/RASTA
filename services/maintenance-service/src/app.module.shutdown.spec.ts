import 'reflect-metadata';
import { OutboxShutdown, type EventConsumer, type OutboxStopOptions } from '@rasta/nest-common';
import { AppModule } from './app.module';
import { AssetSyncConsumer } from './consumers/asset-sync.consumer';
import { UsageConsumer } from './consumers/usage.consumer';
import { ENV } from './tokens';

/**
 * Codex on #267 (Medium): the usage and asset-sync consumers' own
 * `onModuleDestroy` stopped their `EventConsumer`s with no bound. They are now
 * `OutboxShutdown` workers, stopped beside the relay, the purge and the due
 * scanner by the one deadline. This reads the wiring without a database or a
 * broker: AppModule's own factory, called with stand-ins for what it injects.
 * The consumer's own behaviour under a deadline is nest-common's
 * `event-consumer.stop.spec.ts` and `event-consumer.lifecycle.spec.ts`.
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

const consumerStub = (stop: (options?: OutboxStopOptions) => Promise<void>) => () =>
  ({ start: async () => undefined, stop }) as unknown as EventConsumer;

describe('AppModule shutdown wiring (Codex on #267)', () => {
  it('stops both consumers with the relay, the purge and the scanner, by one deadline', async () => {
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

    expect(inject).toEqual(expect.arrayContaining([UsageConsumer, AssetSyncConsumer]));
    expect(stops.size).toBe(inject.length - 1);
    expect(stops.get(UsageConsumer)).toHaveLength(1);
    expect(stops.get(AssetSyncConsumer)).toHaveLength(1);
    const deadlines = new Set([...stops.values()].map((calls) => calls[0]?.deadlineAt));
    expect(deadlines.size).toBe(1);
    const [deadlineAt] = [...deadlines];
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 23_000);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 23_000);
  });

  it('each passes the deadline to its EventConsumer, and has no unbounded stop of its own', async () => {
    const usageStop = jest.fn(async (_options?: OutboxStopOptions) => undefined);
    const syncStop = jest.fn(async (_options?: OutboxStopOptions) => undefined);
    const usage = new UsageConsumer(consumerStub(usageStop), {} as never, {} as never);
    const sync = new AssetSyncConsumer(consumerStub(syncStop), {} as never);
    await usage.onModuleInit();
    await sync.onModuleInit();

    await usage.stop({ deadlineAt: 1234 });
    await sync.stop({ deadlineAt: 1234 });
    await usage.onApplicationShutdown();
    await sync.onApplicationShutdown();

    expect(usageStop.mock.calls).toEqual([[{ deadlineAt: 1234 }], [undefined]]);
    expect(syncStop.mock.calls).toEqual([[{ deadlineAt: 1234 }], [undefined]]);
    expect('onModuleDestroy' in UsageConsumer.prototype).toBe(false);
    expect('onModuleDestroy' in AssetSyncConsumer.prototype).toBe(false);
  });
});
