import 'reflect-metadata';
import { OutboxShutdown, type EventConsumer, type OutboxStopOptions } from '@rasta/nest-common';
import { AppModule } from './app.module';
import { RewardTriggerConsumer } from './consumers/reward-trigger.consumer';
import { SettlementAuthorityConsumer } from './consumers/settlement-authority.consumer';
import { ENV } from './tokens';

/**
 * Codex r1 on #277 (Medium): both Kafka consumers stopped in their own
 * `onApplicationShutdown` with no bound, after the relay, the purge and the
 * payment sweep had drained, so their waits came on top of the relay's. They
 * are now `OutboxShutdown` workers, stopped beside the rest by the one
 * deadline, and their own hook only joins that stop. This reads the wiring
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

type ConsumerStop = (options?: OutboxStopOptions) => Promise<void>;

/** The `build` a consumer takes: a stand-in `EventConsumer` whose `stop` is the one given. */
const buildOf = (stop: ConsumerStop) => () =>
  ({ start: async () => undefined, stop }) as unknown as EventConsumer;

describe('AppModule shutdown wiring (Codex r1 on #277)', () => {
  it('stops both consumers with the relay, the purge and the payment sweep, by one deadline', async () => {
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
      expect.arrayContaining([SettlementAuthorityConsumer, RewardTriggerConsumer]),
    );
    expect(stops.size).toBe(inject.length - 1);
    expect(stops.get(SettlementAuthorityConsumer)).toHaveLength(1);
    expect(stops.get(RewardTriggerConsumer)).toHaveLength(1);
    const deadlines = new Set([...stops.values()].map((calls) => calls[0]?.deadlineAt));
    expect(deadlines.size).toBe(1);
    const [deadlineAt] = [...deadlines];
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 23_000);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 23_000);
  });

  it.each([
    ['SettlementAuthorityConsumer', SettlementAuthorityConsumer],
    ['RewardTriggerConsumer', RewardTriggerConsumer],
  ] as const)(
    '%s passes the deadline to its EventConsumer; its own hook joins that stop',
    async (_name, Consumer) => {
      const consumerStop = jest.fn(async (_options?: OutboxStopOptions) => undefined);
      const consumer = new Consumer(buildOf(consumerStop), {} as never, {} as never, {} as never);

      await consumer.stop({ deadlineAt: 1234 });
      await consumer.onApplicationShutdown();

      // The second call carries no deadline of its own; `EventConsumer.stop`
      // returns the stop already in progress (nest-common's lifecycle spec).
      expect(consumerStop.mock.calls).toEqual([[{ deadlineAt: 1234 }], [undefined]]);
    },
  );
});
