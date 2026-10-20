import 'reflect-metadata';
import {
  OutboxPurgeScheduler,
  OutboxRelay,
  OutboxShutdown,
  type OutboxStopOptions,
} from '@rasta/nest-common';
import { AppModule } from './app.module';
import { ENV } from './tokens';

/**
 * D-052: the relay and the purge stop together in the destroy phase, by one deadline inside
 * SHUTDOWN_TIMEOUT_MS, and `onApplicationShutdown` only joins that stop. This reads the wiring
 * without a database or a broker: AppModule's own factory, called with stand-ins for what it
 * injects. The publisher closing last is
 * `app.module.publisher-close.spec.ts`.
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

describe('AppModule shutdown wiring (D-052)', () => {
  it('stops the relay and the purge by one deadline', async () => {
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
            close: async () => undefined,
            disconnect: async () => undefined,
          },
    );
    const shutdown = provider.useFactory(...args) as OutboxShutdown;

    const before = Date.now();
    await shutdown.stop();

    expect(inject).toEqual(expect.arrayContaining([OutboxRelay, OutboxPurgeScheduler]));
    expect(stops.get(OutboxRelay)).toHaveLength(1);
    expect(stops.get(OutboxPurgeScheduler)).toHaveLength(1);
    const deadlines = new Set(
      [OutboxRelay, OutboxPurgeScheduler].map((token) => stops.get(token)?.[0]?.deadlineAt),
    );
    expect(deadlines.size).toBe(1);
    const [deadlineAt] = [...deadlines];
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 23_000);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 23_000);
  });

  it('onApplicationShutdown joins the outbox stop and stops nothing on its own', async () => {
    const outboxStop = jest.fn(async () => undefined);
    const module = Object.create(AppModule.prototype) as AppModule;
    Object.assign(module, { outboxShutdown: { stop: outboxStop } });

    await module.onApplicationShutdown();

    expect(outboxStop).toHaveBeenCalledTimes(1);
  });
});
