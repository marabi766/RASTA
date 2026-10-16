import 'reflect-metadata';
import { OutboxShutdown, type EventConsumer, type OutboxStopOptions } from '@rasta/nest-common';
import { AppModule } from './app.module';
import { OrganizationMovedConsumer } from './events/organization-moved.consumer';
import { TenderAwardedConsumer } from './events/tender-awarded.consumer';
import { ENV } from './tokens';

/**
 * Codex r1 on #277 (Medium): `AppModule.onApplicationShutdown` stopped both
 * Kafka consumers, one after the other, with no bound, after the relay, the
 * purge and the sweep had drained, so their waits came on top of the relay's.
 * They are now `OutboxShutdown` workers, stopped beside the rest by the one
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

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

type ConsumerStop = (options?: OutboxStopOptions) => Promise<void>;

/** A consumer over a stand-in `EventConsumer` whose `stop` is the one given. */
const factoryOf = (stop: ConsumerStop) => () =>
  ({ start: async () => undefined, stop }) as unknown as EventConsumer;

const awarded = (stop: ConsumerStop) =>
  new TenderAwardedConsumer(
    factoryOf(stop),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    silent,
  );
const moves = (stop: ConsumerStop) =>
  new OrganizationMovedConsumer(factoryOf(stop), {} as never, silent);

describe('AppModule shutdown wiring (Codex r1 on #277)', () => {
  it('stops both consumers with the relay, the purge and the sweep, by one deadline', async () => {
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
      expect.arrayContaining([TenderAwardedConsumer, OrganizationMovedConsumer]),
    );
    expect(stops.size).toBe(inject.length - 1);
    expect(stops.get(TenderAwardedConsumer)).toHaveLength(1);
    expect(stops.get(OrganizationMovedConsumer)).toHaveLength(1);
    const deadlines = new Set([...stops.values()].map((calls) => calls[0]?.deadlineAt));
    expect(deadlines.size).toBe(1);
    const [deadlineAt] = [...deadlines];
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 23_000);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 23_000);
  });

  it.each([
    ['TenderAwardedConsumer', awarded],
    ['OrganizationMovedConsumer', moves],
  ] as const)('%s passes the deadline to its EventConsumer', async (_name, build) => {
    const consumerStop = jest.fn(async (_options?: OutboxStopOptions) => undefined);
    const consumer = build(consumerStop);
    await consumer.start();

    await consumer.stop({ deadlineAt: 1234 });

    expect(consumerStop.mock.calls).toEqual([[{ deadlineAt: 1234 }]]);
  });

  it('a consumer stopped before it started has nothing to wait for', async () => {
    const consumerStop = jest.fn(async () => undefined);
    await expect(awarded(consumerStop).stop({ deadlineAt: 1234 })).resolves.toBeUndefined();
    await expect(moves(consumerStop).stop({ deadlineAt: 1234 })).resolves.toBeUndefined();
    expect(consumerStop).not.toHaveBeenCalled();
  });

  it('AppModule no longer stops the consumers on its own in onApplicationShutdown', async () => {
    const awardedStop = jest.fn(async () => undefined);
    const movesStop = jest.fn(async () => undefined);
    const outboxStop = jest.fn(async () => undefined);
    const module = Object.create(AppModule.prototype) as AppModule;
    Object.assign(module, {
      awarded: { stop: awardedStop },
      moves: { stop: movesStop },
      outboxShutdown: { stop: outboxStop },
    });

    await module.onApplicationShutdown();

    expect(outboxStop).toHaveBeenCalledTimes(1);
    expect(awardedStop).not.toHaveBeenCalled();
    expect(movesStop).not.toHaveBeenCalled();
  });
});
