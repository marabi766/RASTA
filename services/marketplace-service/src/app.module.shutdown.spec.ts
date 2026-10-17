import 'reflect-metadata';
import {
  OutboxPurgeScheduler,
  OutboxRelay,
  OutboxShutdown,
  type OutboxStopOptions,
} from '@rasta/nest-common';
import { AppModule } from './app.module';
import { KafkaEventPublisher } from './outbox/kafka.publisher';
import { ENV } from './tokens';
import { OrderSagaWorker } from './temporal/worker';
import { ReturnMirrorConsumer } from './returns/return-mirror.consumer';

interface FactoryProvider {
  provide?: unknown;
  inject?: unknown[];
  useFactory: (...args: unknown[]) => unknown;
}

function outboxShutdownProviders(): FactoryProvider[] {
  const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as FactoryProvider[];
  return providers.filter((p) => p.provide === OutboxShutdown);
}

/** Calls the factory with recording stand-ins; returns each token's stop calls. */
async function stopThroughFactory(): Promise<{
  inject: unknown[];
  stops: Map<unknown, (OutboxStopOptions | undefined)[]>;
}> {
  const [provider] = outboxShutdownProviders();
  if (!provider) throw new Error('AppModule provides no OutboxShutdown');
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

/** D-052: the Temporal worker is stopped with the relay and the purge, by one deadline. */
describe('AppModule shutdown wiring (D-052)', () => {
  it('has one OutboxShutdown, holding the relay, the purge, the saga worker and the return mirror', async () => {
    // Two declarations would let the later replace the earlier, silently
    // dropping its workers (the #277/#279 merge).
    expect(outboxShutdownProviders()).toHaveLength(1);

    const { inject, stops } = await stopThroughFactory();

    // The publisher is closed last, after the drain, by the same deadline (D-052
    // phase 4b): app.module.publisher-close.spec.ts.
    const expected = [
      OutboxRelay,
      OutboxPurgeScheduler,
      OrderSagaWorker,
      ReturnMirrorConsumer,
      KafkaEventPublisher,
    ];
    expect(new Set(inject)).toEqual(new Set([...expected, ENV]));
    expect(inject).toHaveLength(expected.length + 1);
    for (const token of expected) expect(stops.get(token)).toHaveLength(1);
    expect(stops.size).toBe(expected.length);
  });

  it('stops the relay and the saga worker together, by one deadline', async () => {
    const { inject, stops } = await stopThroughFactory();
    const deadlines = new Map([...stops].map(([token, calls]) => [token, calls[0]?.deadlineAt]));

    expect(inject).toEqual(
      expect.arrayContaining([
        OutboxRelay,
        OrderSagaWorker,
        ReturnMirrorConsumer,
        KafkaEventPublisher,
      ]),
    );
    expect(deadlines.size).toBe(inject.length - 1);
    expect(new Set(deadlines.values()).size).toBe(1);
    expect(deadlines.get(OrderSagaWorker)).toBeGreaterThan(Date.now());
    expect(deadlines.get(ReturnMirrorConsumer)).toBeGreaterThan(Date.now());
  });
});
