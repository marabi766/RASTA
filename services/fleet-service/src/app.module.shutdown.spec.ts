import 'reflect-metadata';
import { OutboxShutdown, type OutboxStopOptions } from '@rasta/nest-common';
import { AppModule } from './app.module';
import { AssetSyncConsumer } from './consumers/asset-sync.consumer';
import { ENV } from './tokens';

/**
 * Codex on #267 (Medium): the asset-sync consumer's own `onModuleDestroy`
 * stopped its `EventConsumer` with no bound. It is now one of `OutboxShutdown`'s
 * workers, stopped beside the relay and the purge by the one deadline. This
 * reads the wiring without a database or a broker: AppModule's own factory,
 * called with stand-ins for what it injects. The behaviour under a real close
 * is `test/outbox-shutdown.int-spec.ts`.
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

describe('AppModule shutdown wiring (Codex on #267)', () => {
  it('stops the asset-sync consumer with the relay and the purge, by one deadline', async () => {
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

    expect(inject).toContain(AssetSyncConsumer);
    // Every component it injects is stopped once, the consumer included…
    expect(stops.size).toBe(inject.length - 1);
    expect(stops.get(AssetSyncConsumer)).toHaveLength(1);
    // …all with the same deadline: the 23 s budget of a 25 s timeout.
    const deadlines = new Set([...stops.values()].map((calls) => calls[0]?.deadlineAt));
    expect(deadlines.size).toBe(1);
    const [deadlineAt] = [...deadlines];
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 23_000);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 23_000);
  });

  it('leaves the consumer no unbounded stop of its own in the destroy phase', () => {
    expect('onModuleDestroy' in AssetSyncConsumer.prototype).toBe(false);
  });
});
