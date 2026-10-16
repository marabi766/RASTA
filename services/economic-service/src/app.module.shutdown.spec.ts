import 'reflect-metadata';
import {
  OutboxPurgeScheduler,
  OutboxRelay,
  OutboxShutdown,
  type EventConsumer,
  type OutboxStopOptions,
} from '@rasta/nest-common';
import { AppModule } from './app.module';
import { RewardTriggerConsumer } from './consumers/reward-trigger.consumer';
import { SettlementAuthorityConsumer } from './consumers/settlement-authority.consumer';
import { PaymentReconciliationSweeper } from './payment/payment-reconciliation.sweeper';
import { ENV } from './tokens';
import { LedgerBalanceAudit } from './wallet/balance-audit';

/**
 * Codex r1 on #277 (Medium): both Kafka consumers stopped in their own
 * `onApplicationShutdown` with no bound, after the relay, the purge and the
 * payment sweep had drained, so their waits came on top of the relay's. They
 * are now `OutboxShutdown` workers, stopped beside the rest by the one
 * deadline, and their own hook only joins that stop — as is the balance audit
 * (#279, D-052 phase 3). This reads the wiring without a database or a broker:
 * AppModule's own factory, called with stand-ins for what it injects. The
 * consumer's own behaviour under a deadline is nest-common's
 * `event-consumer.stop.spec.ts`; the whole close is
 * `test/outbox-shutdown.int-spec.ts`.
 */
interface FactoryProvider {
  provide: unknown;
  inject?: unknown[];
  useFactory: (...args: unknown[]) => unknown;
}

function outboxShutdownProviders(): FactoryProvider[] {
  const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as unknown[];
  return providers.filter(
    (provider): provider is FactoryProvider =>
      typeof provider === 'object' &&
      provider !== null &&
      (provider as { provide?: unknown }).provide === OutboxShutdown,
  );
}

function outboxShutdownProvider(): FactoryProvider {
  const [found] = outboxShutdownProviders();
  if (!found) throw new Error('AppModule provides no OutboxShutdown');
  return found;
}

/** Calls the factory with recording stand-ins; returns each token's stop calls. */
async function stopThroughFactory(): Promise<{
  inject: unknown[];
  stops: Map<unknown, (OutboxStopOptions | undefined)[]>;
}> {
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
  await (provider.useFactory(...args) as OutboxShutdown).stop();
  return { inject, stops };
}

type ConsumerStop = (options?: OutboxStopOptions) => Promise<void>;

/** The `build` a consumer takes: a stand-in `EventConsumer` whose `stop` is the one given. */
const buildOf = (stop: ConsumerStop) => () =>
  ({ start: async () => undefined, stop }) as unknown as EventConsumer;

describe('AppModule shutdown wiring (D-052)', () => {
  it('has one OutboxShutdown, holding the relay, the purge and every worker', async () => {
    // Two declarations would let the later replace the earlier, silently
    // dropping its workers (the #277/#279 merge).
    expect(outboxShutdownProviders()).toHaveLength(1);

    const { inject, stops } = await stopThroughFactory();

    const expected = [
      OutboxRelay,
      OutboxPurgeScheduler,
      PaymentReconciliationSweeper,
      SettlementAuthorityConsumer,
      RewardTriggerConsumer,
      LedgerBalanceAudit,
    ];
    expect(new Set(inject)).toEqual(new Set([...expected, ENV]));
    expect(inject).toHaveLength(expected.length + 1);
    for (const token of expected) expect(stops.get(token)).toHaveLength(1);
    expect(stops.size).toBe(expected.length);
  });

  it('stops the relay and the balance audit together, by one deadline', async () => {
    const { inject, stops } = await stopThroughFactory();
    const deadlines = new Map([...stops].map(([token, calls]) => [token, calls[0]?.deadlineAt]));

    expect(inject).toEqual(expect.arrayContaining([OutboxRelay, LedgerBalanceAudit]));
    expect(deadlines.size).toBe(inject.length - 1);
    expect(new Set(deadlines.values()).size).toBe(1);
    expect(deadlines.get(LedgerBalanceAudit)).toBeGreaterThan(Date.now());
  });
});

describe('AppModule shutdown wiring (Codex r1 on #277)', () => {
  it('stops both consumers with the relay, the purge and the payment sweep, by one deadline', async () => {
    const before = Date.now();
    const { inject, stops } = await stopThroughFactory();

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
