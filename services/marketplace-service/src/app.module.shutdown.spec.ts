import 'reflect-metadata';
import { OutboxRelay, OutboxShutdown, type OutboxStopOptions } from '@rasta/nest-common';
import { AppModule } from './app.module';
import { KafkaEventPublisher } from './outbox/kafka.publisher';
import { ENV } from './tokens';
import { OrderSagaWorker } from './temporal/worker';

/** D-052: the Temporal worker is stopped with the relay, by one deadline. */
describe('AppModule shutdown wiring (D-052)', () => {
  it('stops the relay and the saga worker together, by one deadline', async () => {
    const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as {
      provide?: unknown;
      inject?: unknown[];
      useFactory: (...args: unknown[]) => unknown;
    }[];
    const provider = providers.find((p) => p.provide === OutboxShutdown);
    if (!provider) throw new Error('AppModule provides no OutboxShutdown');

    const inject = provider.inject ?? [];
    const deadlines = new Map<unknown, number | undefined>();
    const args = inject.map((token) =>
      token === ENV
        ? { SHUTDOWN_TIMEOUT_MS: 25_000 }
        : {
            stop: async (options?: OutboxStopOptions) => {
              deadlines.set(token, options?.deadlineAt);
            },
          },
    );
    await (provider.useFactory(...args) as OutboxShutdown).stop();

    expect(inject).toEqual(
      expect.arrayContaining([OutboxRelay, OrderSagaWorker, KafkaEventPublisher]),
    );
    // The publisher too, closed after them (D-052 phase 4b): app.module.publisher-close.spec.ts.
    expect(deadlines.size).toBe(3);
    expect(new Set(deadlines.values()).size).toBe(1);
    expect([...deadlines.values()][0]).toBeGreaterThan(Date.now());
  });
});
