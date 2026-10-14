import 'reflect-metadata';
import { OutboxShutdown, type EventConsumer, type OutboxStopOptions } from '@rasta/nest-common';
import { AppModule, ENV } from './app.module';
import { TimelineConsumer } from './consumers/timeline.consumer';

/**
 * Codex on #267 (Medium): the timeline consumer's own `onModuleDestroy`
 * stopped its `EventConsumer` with no bound. It is now one of `OutboxShutdown`'s
 * workers, stopped beside the relay, the purge and the expiry sweep by the one
 * deadline. This reads the wiring without a database or a broker:
 * AppModule's own factory, called with stand-ins for what it injects. The
 * consumer's own behaviour under a deadline is nest-common's
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

describe('AppModule shutdown wiring (Codex on #267)', () => {
  it('stops the timeline consumer with the relay, the purge and the sweep, by one deadline', async () => {
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

    expect(inject).toContain(TimelineConsumer);
    expect(stops.size).toBe(inject.length - 1);
    expect(stops.get(TimelineConsumer)).toHaveLength(1);
    const deadlines = new Set([...stops.values()].map((calls) => calls[0]?.deadlineAt));
    expect(deadlines.size).toBe(1);
    const [deadlineAt] = [...deadlines];
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 23_000);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 23_000);
  });

  it('passes the deadline to its EventConsumer, and has no unbounded stop of its own', async () => {
    const stop = jest.fn(async (_options?: OutboxStopOptions) => undefined);
    const timeline = new TimelineConsumer(
      () => ({ start: async () => undefined, stop }) as unknown as EventConsumer,
      {} as never,
      {} as never,
    );
    await timeline.onModuleInit();

    await timeline.stop({ deadlineAt: 1234 });
    await timeline.onApplicationShutdown();

    expect(stop.mock.calls).toEqual([[{ deadlineAt: 1234 }], [undefined]]);
    expect('onModuleDestroy' in TimelineConsumer.prototype).toBe(false);
  });
});
