import { EventEmitter } from 'node:events';
import { Logger, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { outboxShutdownBudgetMs } from '@rasta/config';
import {
  installGracefulShutdown,
  kafkaConnection,
  OutboxRelay,
  OutboxShutdown,
  type OutboxClaim,
  type OutboxRow,
  type OutboxStore,
} from '@rasta/nest-common';
import { StubKafkaBroker } from '@rasta/testing';
import { KafkaEventPublisher } from './kafka.publisher';

/**
 * D-052 phase 4b (Codex r2 on #276, F2): the publisher's close inside the
 * shutdown budget. Plain shape — one producer, opened on first publish.
 *
 * kafkajs's `disconnect()` waits for every request in flight, and Nest waits
 * for every `onModuleDestroy`. A Produce the broker never answered kept
 * `app.close()` pending after `OutboxShutdown` had finished, and the process
 * exited 1 at SHUTDOWN_TIMEOUT_MS.
 *
 * Real: the publisher, kafkajs (socket, request queue, idempotent producer),
 * the relay, `OutboxShutdown`, Nest's close and `installGracefulShutdown`.
 * Stand-ins: the outbox store (one row), and the broker — `StubKafkaBroker`,
 * which never answers the Produce. The module registers the publisher before
 * the coordinator, as AppModule does, so their destroy hooks start in the same
 * order. The connection is `kafkaConnection(env, …)`, AppModule's call.
 */
const SHUTDOWN_TIMEOUT_MS = 4000;
/** `outboxShutdownBudgetMs`: the timeout less the 2 s reserve. */
const BUDGET_MS = 2000;

const row = (): OutboxRow => ({
  id: 'SHUTDOWN-PROBE',
  aggregateType: 'Probe',
  aggregateId: 'SHUTDOWN-PROBE',
  eventName: 'PROBE',
  eventVersion: 1,
  topic: 'rasta.fleet.v1',
  partitionKey: 'SHUTDOWN-PROBE',
  payload: {},
  headers: {},
  organizationId: 'ORG-SHUTDOWN-PROBE',
  correlationId: 'SHUTDOWN-PROBE',
  createdAt: new Date(),
  publishedAt: null,
  attempts: 0,
  lastError: null,
});

/** Hands the relay one row, once. */
function oneRowStore(): OutboxStore & { published: string[] } {
  let claimed = false;
  const published: string[] = [];
  const store: Partial<OutboxStore> & { published: string[] } = {
    published,
    claimPending: async (): Promise<OutboxClaim> => {
      if (claimed) return { token: null, rows: [], reclaimed: 0 };
      claimed = true;
      return { token: 'tok-shutdown', rows: [row()], reclaimed: 0 };
    },
    markPublished: async (ids: readonly string[]) => {
      published.push(...ids);
      return ids.length;
    },
    markFailed: async () => 1,
    release: async (ids: readonly string[]) => ids.length,
    renew: async (ids: readonly string[]) => [...ids],
    oldestPendingAgeSeconds: async () => 0,
  };
  return store as OutboxStore & { published: string[] };
}

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface Booted {
  app: INestApplication;
  publisher: KafkaEventPublisher;
  store: ReturnType<typeof oneRowStore>;
}

async function boot(broker: StubKafkaBroker): Promise<Booted> {
  const store = oneRowStore();
  const connection = kafkaConnection(
    {
      NODE_ENV: 'test',
      SERVICE_NAME: 'fleet-service',
      KAFKA_BROKERS: broker.brokers,
      KAFKA_SASL_MECHANISM: 'scram-sha-512',
      KAFKA_SSL: false,
      KAFKA_ALLOW_PLAINTEXT: true,
      SHUTDOWN_TIMEOUT_MS,
    },
    'fleet-service',
  );

  @Module({
    providers: [
      { provide: KafkaEventPublisher, useFactory: () => new KafkaEventPublisher(connection) },
      {
        provide: OutboxRelay,
        inject: [KafkaEventPublisher],
        useFactory: (publisher: KafkaEventPublisher) =>
          new OutboxRelay({
            store,
            publisher,
            pollIntervalMs: 20,
            leaseSeconds: 30,
            shutdownGraceSeconds: 1,
            logger: silent,
          }),
      },
      {
        provide: OutboxShutdown,
        inject: [OutboxRelay],
        useFactory: (relay: OutboxRelay) =>
          new OutboxShutdown({ relay, budgetMs: outboxShutdownBudgetMs({ SHUTDOWN_TIMEOUT_MS }) }),
      },
    ],
  })
  class ShutdownProbeModule {}

  const moduleRef = await Test.createTestingModule({ imports: [ShutdownProbeModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  app.get(OutboxRelay).start();
  return { app, publisher: app.get(KafkaEventPublisher), store };
}

async function closeUnderDeadline(
  app: INestApplication,
): Promise<{ exits: number[]; errors: string[]; tookMs: number }> {
  const exits: number[] = [];
  const errors: string[] = [];
  const shutdown = installGracefulShutdown(app, {
    serviceName: 'fleet-service',
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    exit: (code) => exits.push(code),
    signalSource: new EventEmitter(),
    logger: { warn: () => undefined, error: (message) => errors.push(message) },
  });
  const startedAt = Date.now();
  await shutdown.shutdown('SIGTERM');
  return { exits, errors, tookMs: Date.now() - startedAt };
}

/** The publisher's producer, once its first publish has connected it. */
const producerOf = (publisher: KafkaEventPublisher): { disconnect(): Promise<void> } =>
  (publisher as unknown as { producer: { disconnect(): Promise<void> } }).producer;

describe('fleet-service KafkaEventPublisher: close within the shutdown budget (D-052 phase 4b)', () => {
  expect(outboxShutdownBudgetMs({ SHUTDOWN_TIMEOUT_MS })).toBe(BUDGET_MS);

  let broker: StubKafkaBroker | undefined;
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown) => void warnings.push(String(message)));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    // Releasing answers a held connect with INVALID_REQUEST, which kafkajs logs.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await broker?.stop();
    broker = undefined;
    jest.restoreAllMocks();
  });

  it('a Produce the broker never answers: app.close() returns at the budget, exit 0, the close abandoned with a warning', async () => {
    broker = await StubKafkaBroker.start();
    const { app, publisher, store } = await boot(broker);
    await broker.waitForHeld('Produce');
    const disconnect = jest.spyOn(producerOf(publisher), 'disconnect');

    const closing = closeUnderDeadline(app);
    // A second hook while the first close is under way joins it.
    const againFrom = Date.now();
    const again = publisher.onModuleDestroy().then(() => Date.now() - againFrom);
    const { exits, errors, tookMs } = await closing;
    // Joined: it returned with the first close, not at once.
    expect(await again).toBeGreaterThanOrEqual(BUDGET_MS - 100);

    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    // It did wait for the close — until the shared deadline, not past it.
    expect(tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(tookMs).toBeLessThan(BUDGET_MS + 1000);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([
      expect.stringMatching(/^Kafka producer: disconnect did not finish by the shutdown deadline/),
    ]);
    // The Produce was still in flight at exit: nothing acknowledged it.
    expect(broker.held('Produce')).toBe(1);
    expect(store.published).toEqual([]);
  }, 20_000);

  it('a broker that answers: the close finishes at once, no warning', async () => {
    broker = await StubKafkaBroker.start();
    const { app, store } = await boot(broker);
    await broker.waitForHeld('Produce');
    broker.release();
    while (store.published.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));

    const { exits, errors, tookMs } = await closeUnderDeadline(app);

    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeLessThan(1000);
    expect(warnings).toEqual([]);
    expect(store.published).toEqual(['SHUTDOWN-PROBE']);
  }, 20_000);
});
