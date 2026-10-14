import 'reflect-metadata';
import { OutboxShutdown, type EventConsumer, type OutboxStopOptions } from '@rasta/nest-common';
import { AppModule } from './app.module';
import { PerformanceConsumer } from './performance/performance.consumer';
import { ENV } from './tokens';

/**
 * Codex r1 on #276 (Medium): `AppModule.onApplicationShutdown` stopped the
 * performance consumer with no bound, after the relay and the purge had
 * drained, so its wait came on top of theirs. It is now an `OutboxShutdown`
 * worker, stopped beside them by the one deadline. This reads the wiring
 * without a database or a broker: AppModule's own factory, called with
 * stand-ins for what it injects. The consumer's own behaviour under a deadline
 * is nest-common's `event-consumer.stop.spec.ts`; the whole close is
 * `test/outbox-shutdown.int-spec.ts`.
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

describe('AppModule shutdown wiring (Codex r1 on #276)', () => {
  it('stops the performance consumer with the relay and the purge, by one deadline', async () => {
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

    expect(inject).toContain(PerformanceConsumer);
    expect(stops.size).toBe(inject.length - 1);
    expect(stops.get(PerformanceConsumer)).toHaveLength(1);
    const deadlines = new Set([...stops.values()].map((calls) => calls[0]?.deadlineAt));
    expect(deadlines.size).toBe(1);
    const [deadlineAt] = [...deadlines];
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 23_000);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 23_000);
  });

  it('passes the deadline to its EventConsumer; a later stop joins it', async () => {
    const consumerStop = jest.fn(async (_options?: OutboxStopOptions) => undefined);
    const performance = new PerformanceConsumer(
      () => ({ start: async () => undefined, stop: consumerStop }) as unknown as EventConsumer,
      {} as never,
      {} as never,
      {} as never,
      silent,
    );
    await performance.start();

    await performance.stop({ deadlineAt: 1234 });
    await performance.stop();

    expect(consumerStop.mock.calls).toEqual([[{ deadlineAt: 1234 }], [undefined]]);
  });

  it('disabled (the default), there is nothing to stop', async () => {
    const performance = new PerformanceConsumer(
      null,
      {} as never,
      {} as never,
      {} as never,
      silent,
    );
    await performance.start();
    await expect(performance.stop({ deadlineAt: 1234 })).resolves.toBeUndefined();
  });

  it('AppModule no longer stops it on its own in onApplicationShutdown', async () => {
    const performanceStop = jest.fn(async () => undefined);
    const outboxStop = jest.fn(async () => undefined);
    const module = Object.create(AppModule.prototype) as AppModule;
    Object.assign(module, {
      performance: { stop: performanceStop },
      outboxShutdown: { stop: outboxStop },
    });

    await module.onApplicationShutdown();

    expect(outboxStop).toHaveBeenCalledTimes(1);
    expect(performanceStop).not.toHaveBeenCalled();
  });
});
