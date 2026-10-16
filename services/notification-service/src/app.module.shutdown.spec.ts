import 'reflect-metadata';
import { OutboxShutdown, type EventConsumer, type OutboxStopOptions } from '@rasta/nest-common';
import { AppModule } from './app.module';
import { MailWorker } from './channels/mail.worker';
import { DispatcherConsumer } from './intake/dispatcher.consumer';
import { ResolutionWorker } from './resolution/resolution.worker';
import { ENV } from './tokens';

/**
 * Codex r1 on #276 (Medium): the dispatcher consumer's own `onModuleDestroy`
 * stopped its `EventConsumer` with no bound. It is now an `OutboxShutdown`
 * worker, stopped beside the relay, the purge and both workers by the one
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

describe('AppModule shutdown wiring (Codex r1 on #276)', () => {
  it('stops the dispatcher consumer with the relay, the purge and both workers, by one deadline', async () => {
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
      expect.arrayContaining([DispatcherConsumer, ResolutionWorker, MailWorker]),
    );
    expect(stops.size).toBe(inject.length - 1);
    expect(stops.get(DispatcherConsumer)).toHaveLength(1);
    const deadlines = new Set([...stops.values()].map((calls) => calls[0]?.deadlineAt));
    expect(deadlines.size).toBe(1);
    const [deadlineAt] = [...deadlines];
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 23_000);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 23_000);
  });

  it('passes the deadline to its EventConsumer, and has no unbounded stop of its own', async () => {
    const consumerStop = jest.fn(async (_options?: OutboxStopOptions) => undefined);
    const dispatcher = new DispatcherConsumer(
      () => ({ start: async () => undefined, stop: consumerStop }) as unknown as EventConsumer,
      {} as never,
      45,
      {} as never,
    );
    await dispatcher.start();

    await dispatcher.stop({ deadlineAt: 1234 });
    await dispatcher.onApplicationShutdown();

    expect(consumerStop.mock.calls).toEqual([[{ deadlineAt: 1234 }], [undefined]]);
    expect('onModuleDestroy' in DispatcherConsumer.prototype).toBe(false);
  });

  it('a stop before the consumer started has nothing to wait for', async () => {
    const dispatcher = new DispatcherConsumer(
      () => {
        throw new Error('never built');
      },
      {} as never,
      45,
      {} as never,
    );
    await expect(dispatcher.stop({ deadlineAt: 1234 })).resolves.toBeUndefined();
  });
});
