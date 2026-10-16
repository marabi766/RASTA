import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  Inject,
  Logger,
  Module,
  type INestApplication,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { outboxShutdownBudgetMs } from '@rasta/config';
import {
  installGracefulShutdown,
  OutboxRelay,
  OutboxShutdown,
  type OutboxClaim,
  type OutboxRow,
  type OutboxStopOptions,
  type OutboxStore,
} from '@rasta/nest-common';
import { StubKafkaBroker, type StubKafkaBrokerOptions } from '@rasta/testing';
import { AppModule } from '../app.module';
import { HealthController } from '../health/health.controller';
import { PrismaService } from '../prisma/prisma.service';
import { ENV, LOGGER } from '../tokens';
import { KafkaEventPublisher } from './kafka.publisher';
import { PrismaOutboxStore } from './outbox.store';

/**
 * D-052 phase 4b: the publisher's close and the readiness probe inside the
 * shutdown budget, through AppModule's own wiring. Pending shape — a producer
 * still connecting is closed too (`pendingProducer`).
 *
 * Codex r1 on #293:
 *   F1 — the publisher closed in its own `onModuleDestroy`, by a budget of its
 *        own, while the relay drained beside it — or, at r1's head, after it in
 *        `onApplicationShutdown` — and two budgets in sequence exited 1. The
 *        r1 spec built its own coordinator, so it proved nothing about
 *        AppModule. Now `OutboxShutdown` closes the publisher once the drain
 *        has returned, by the drain's deadline.
 *   F2 — a readiness probe in flight held its HTTP request, and the HTTP
 *        server's close waits for open requests.
 *
 * Real, and AppModule's: the providers of `KafkaEventPublisher`, `OutboxRelay`
 * and `OutboxShutdown` (the very factory objects of its `@Module` metadata),
 * `HealthController`, and AppModule's own `onApplicationShutdown`. Real too:
 * kafkajs (socket, request queue, idempotent producer, admin client), Nest's
 * `app.close()` with its HTTP server, and `installGracefulShutdown`.
 * Stand-ins: the database behind them (the outbox store hands out one row, the
 * health check's database answers), the purge and the reservation sweeper
 * (stops that return at once), and the broker — `StubKafkaBroker`, which never
 * answers the request a test holds. The whole AppModule over a database is
 * `test/outbox-shutdown.int-spec.ts`.
 */
const SHUTDOWN_TIMEOUT_MS = 4000;
/** `outboxShutdownBudgetMs`: the timeout less the 2 s reserve. */
const BUDGET_MS = 2000;
/** The relay's own grace: shorter than the budget, so a drain ends before it. */
const GRACE_SECONDS = 1;

const row = (): OutboxRow => ({
  id: 'SHUTDOWN-PROBE',
  aggregateType: 'Probe',
  aggregateId: 'SHUTDOWN-PROBE',
  eventName: 'PROBE',
  eventVersion: 1,
  topic: 'rasta.inventory.v1',
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

/** Hands the relay one row, once — or none. */
function outboxStore(withRow: boolean): OutboxStore & { published: string[] } {
  let claimed = !withRow;
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

interface FactoryProvider {
  provide: unknown;
  inject?: unknown[];
  useFactory: (...args: unknown[]) => unknown;
}

/** AppModule's own provider for `token`, the object its `@Module` declares. */
function appModuleProvider(token: unknown): FactoryProvider {
  const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as unknown[];
  const found = providers.find(
    (provider): provider is FactoryProvider =>
      typeof provider === 'object' &&
      provider !== null &&
      (provider as { provide?: unknown }).provide === token,
  );
  if (!found) throw new Error(`AppModule provides no ${String(token)}`);
  return found;
}

/** When each shutdown participant's stop began and returned, and with what deadline. */
type Timeline = { event: string; at: number; deadlineAt?: number }[];

interface Booted {
  app: INestApplication;
  publisher: KafkaEventPublisher;
  store: ReturnType<typeof outboxStore>;
  timeline: Timeline;
  port: number;
}

async function boot(broker: StubKafkaBroker, options: { relayRow: boolean }): Promise<Booted> {
  const store = outboxStore(options.relayRow);
  // What AppModule's factories read of the environment.
  const env = {
    NODE_ENV: 'test',
    SERVICE_NAME: 'inventory-service',
    KAFKA_CLIENT_ID: 'inventory-service',
    KAFKA_BROKERS: broker.brokers,
    KAFKA_SASL_MECHANISM: 'scram-sha-512',
    KAFKA_SSL: false,
    KAFKA_ALLOW_PLAINTEXT: true,
    SHUTDOWN_TIMEOUT_MS,
    OUTBOX_POLL_INTERVAL_MS: 20,
    OUTBOX_BATCH_SIZE: 10,
    OUTBOX_CLAIM_LEASE_SECONDS: 30,
    OUTBOX_CLAIM_BACKOFF_SECONDS: 1,
    OUTBOX_CLAIM_BACKOFF_MAX_SECONDS: 60,
    OUTBOX_SHUTDOWN_GRACE_SECONDS: GRACE_SECONDS,
  };

  const timeline: Timeline = [];
  const record = (event: string, deadlineAt?: number) =>
    timeline.push({ event, at: Date.now(), deadlineAt });
  // Every other participant AppModule hands OutboxShutdown — the purge, the
  // sweeper — stops at once.
  const shutdownProvider = appModuleProvider(OutboxShutdown);
  const others: Provider[] = (shutdownProvider.inject ?? [])
    .filter((token) => !([OutboxRelay, KafkaEventPublisher, ENV] as unknown[]).includes(token))
    .map((token) => ({
      provide: token as string,
      useValue: {
        stop: async (stopOptions?: OutboxStopOptions) => {
          record(
            `${(token as { name?: string }).name ?? String(token)}.stop`,
            stopOptions?.deadlineAt,
          );
        },
      },
    }));

  @Module({
    controllers: [HealthController],
    providers: [
      appModuleProvider(KafkaEventPublisher) as Provider,
      appModuleProvider(OutboxRelay) as Provider,
      shutdownProvider as Provider,
      ...others,
      { provide: ENV, useValue: env },
      { provide: LOGGER, useValue: silent },
      { provide: PrismaOutboxStore, useValue: store },
      { provide: PrismaService, useValue: { isHealthy: async () => true } },
    ],
  })
  class ProductionShutdownWiring implements OnApplicationShutdown {
    constructor(@Inject(OutboxShutdown) readonly outboxShutdown: OutboxShutdown) {}
    /** AppModule's own body, run on this module's fields. */
    onApplicationShutdown(): Promise<void> {
      return AppModule.prototype.onApplicationShutdown.call(this as unknown as AppModule);
    }
  }

  const moduleRef = await Test.createTestingModule({
    imports: [ProductionShutdownWiring],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;

  const publisher = app.get(KafkaEventPublisher);
  const relay = app.get(OutboxRelay);
  const relayStop = relay.stop.bind(relay);
  jest.spyOn(relay, 'stop').mockImplementation(async (stopOptions) => {
    record('relay.stop', stopOptions?.deadlineAt);
    await relayStop(stopOptions);
    record('relay.stopped');
  });
  const publisherStop = publisher.stop.bind(publisher);
  jest.spyOn(publisher, 'stop').mockImplementation(async (stopOptions) => {
    record('publisher.stop', stopOptions?.deadlineAt);
    await publisherStop(stopOptions);
    record('publisher.stopped');
  });
  relay.start();
  return { app, publisher, store, timeline, port };
}

async function closeUnderDeadline(
  app: INestApplication,
): Promise<{ exits: number[]; errors: string[]; tookMs: number }> {
  const exits: number[] = [];
  const errors: string[] = [];
  const shutdown = installGracefulShutdown(app, {
    serviceName: 'inventory-service',
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    exit: (code) => exits.push(code),
    signalSource: new EventEmitter(),
    logger: { warn: () => undefined, error: (message) => errors.push(message) },
  });
  const startedAt = Date.now();
  await shutdown.shutdown('SIGTERM');
  return { exits, errors, tookMs: Date.now() - startedAt };
}

type Producerish = { disconnect(): Promise<void> };
/** The producer the publisher holds: connected (`producer`) or still connecting. */
const producerOf = (
  publisher: KafkaEventPublisher,
  field: 'producer' | 'pendingProducer',
): Producerish => (publisher as unknown as Record<typeof field, Producerish>)[field];

/** The publisher closed after the drain, by the drain's deadline: one budget. */
function expectOneBudget(timeline: Timeline): void {
  const at = (event: string) => timeline.find((entry) => entry.event === event);
  const relayStop = at('relay.stop');
  const relayStopped = at('relay.stopped');
  const publisherStop = at('publisher.stop');
  expect(relayStop).toBeDefined();
  expect(relayStopped).toBeDefined();
  expect(publisherStop).toBeDefined();
  expect(timeline.indexOf(publisherStop!)).toBeGreaterThan(timeline.indexOf(relayStopped!));
  // Every participant, the publisher included, by the one deadline.
  const deadlines = new Set(
    timeline.filter((entry) => entry.event.endsWith('.stop')).map((entry) => entry.deadlineAt),
  );
  expect(deadlines).toEqual(new Set([relayStop!.deadlineAt]));
  expect(timeline.filter((entry) => entry.event === 'publisher.stop')).toHaveLength(1);
}

describe('inventory-service shutdown through AppModule’s wiring: publisher and readiness probe (D-052 phase 4b)', () => {
  expect(outboxShutdownBudgetMs({ SHUTDOWN_TIMEOUT_MS })).toBe(BUDGET_MS);

  let broker: StubKafkaBroker | undefined;
  let booted: Booted | undefined;
  let warnings: string[];

  const start = async (options?: StubKafkaBrokerOptions): Promise<StubKafkaBroker> =>
    (broker = await StubKafkaBroker.start(options));

  beforeEach(() => {
    warnings = [];
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown) => void warnings.push(String(message)));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    // Releasing answers a held connect with INVALID_REQUEST, which kafkajs logs.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await booted?.app.close().catch(() => undefined);
    booted = undefined;
    await broker?.stop();
    broker = undefined;
    jest.restoreAllMocks();
  });

  it('wires the publisher into OutboxShutdown, after the drain', () => {
    expect(appModuleProvider(OutboxShutdown).inject).toEqual(
      expect.arrayContaining([OutboxRelay, KafkaEventPublisher, ENV]),
    );
  });

  it('a producer still connecting, its ApiVersions never answered: closed after the drain, by its deadline — exit 0', async () => {
    const held = await start({ holdConnect: true });
    booted = await boot(held, { relayRow: true });
    const { app, publisher, store, timeline } = booted;
    await held.waitForHeld('ApiVersions');
    const disconnect = jest.spyOn(producerOf(publisher, 'pendingProducer'), 'disconnect');

    const closing = closeUnderDeadline(app);
    // A second stop while the coordinator's is under way joins it (the
    // unspied method: the timeline records the coordinator's calls only).
    const again = new Promise<number>((resolve) => {
      setTimeout(
        () => {
          const from = Date.now();
          void KafkaEventPublisher.prototype.stop
            .call(publisher)
            .then(() => resolve(Date.now() - from));
        },
        GRACE_SECONDS * 1000 + 200,
      );
    });
    const { exits, errors, tookMs } = await closing;
    // Joined: it returned with the first close, at the one deadline.
    expect(await again).toBeGreaterThanOrEqual(BUDGET_MS - GRACE_SECONDS * 1000 - 300);

    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    // The relay waited out its 1 s grace on the publish; the close got what was
    // left of the one 2 s budget, not 2 s of its own.
    expect(tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(tookMs).toBeLessThan(BUDGET_MS + 1000);
    expectOneBudget(timeline);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([
      expect.stringMatching(/^Kafka producer: disconnect did not finish by the shutdown deadline/),
    ]);
    expect(held.held('Produce')).toBe(0);
    expect(store.published).toEqual([]);
  }, 20_000);

  it('a connected producer, its Produce never answered: closed after the drain, by its deadline — exit 0', async () => {
    const held = await start();
    booted = await boot(held, { relayRow: true });
    const { app, publisher, store, timeline } = booted;
    await held.waitForHeld('Produce');
    const disconnect = jest.spyOn(producerOf(publisher, 'producer'), 'disconnect');

    const { exits, errors, tookMs } = await closeUnderDeadline(app);

    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(tookMs).toBeLessThan(BUDGET_MS + 1000);
    expectOneBudget(timeline);
    // The relay's grace ended first (1 s); the producer close began after it.
    const relayStopped = timeline.find((entry) => entry.event === 'relay.stopped')!;
    const publisherStop = timeline.find((entry) => entry.event === 'publisher.stop')!;
    expect(publisherStop.at).toBeGreaterThanOrEqual(relayStopped.at);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([
      expect.stringMatching(/^Kafka producer: disconnect did not finish by the shutdown deadline/),
    ]);
    expect(held.held('Produce')).toBe(1);
    expect(store.published).toEqual([]);
  }, 20_000);

  it('a broker that answers: the drain publishes, the close finishes at once, no warning', async () => {
    const answering = await start();
    booted = await boot(answering, { relayRow: true });
    const { app, store, timeline, port } = booted;
    await answering.waitForHeld('Produce');
    answering.release();
    while (store.published.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    // The probe over HTTP: an admin client's round trip, closed.
    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(((await ready.json()) as { checks: { kafka: boolean } }).checks.kafka).toBe(true);

    const { exits, errors, tookMs } = await closeUnderDeadline(app);

    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeLessThan(1000);
    expectOneBudget(timeline);
    expect(warnings).toEqual([]);
    expect(store.published).toEqual(['SHUTDOWN-PROBE']);
  }, 20_000);

  it('F2: a readiness probe in flight on a silent broker answers at once when the shutdown begins — the HTTP close is not held', async () => {
    const held = await start({ holdConnect: true });
    booted = await boot(held, { relayRow: false });
    const { app, publisher, port } = booted;

    let answeredAt = 0;
    const response = fetch(`http://127.0.0.1:${port}/health/ready`).then(async (answer) => {
      answeredAt = Date.now();
      return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
    });
    // The probe's admin client is mid-connect: its ApiVersions is held.
    await held.waitForHeld('ApiVersions');

    const startedAt = Date.now();
    const { exits, errors, tookMs } = await closeUnderDeadline(app);
    const { status, body } = await response;

    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    // Answered as the close began — not at the probe's bound, not at the
    // broker's request timeout — and the close did not wait on it.
    expect(answeredAt - startedAt).toBeLessThan(300);
    expect(tookMs).toBeLessThan(1000);
    expect(status).toBe(200);
    expect(body).toMatchObject({ checks: { database: true, kafka: false }, degraded: ['kafka'] });

    // Once the shutdown began, a probe opens nothing.
    const before = held.held('ApiVersions');
    await expect(publisher.isHealthy()).resolves.toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(held.held('ApiVersions')).toBe(before);
  }, 20_000);

  it('F2: a probe on a silent broker answers "not healthy" within its bound while the service runs', async () => {
    const held = await start({ holdConnect: true });
    booted = await boot(held, { relayRow: false });
    const from = Date.now();
    await expect(booted.publisher.isHealthy()).resolves.toBe(false);
    // kafkaProbeTimeoutMs: a quarter of the 2 s budget.
    expect(Date.now() - from).toBeGreaterThanOrEqual(450);
    expect(Date.now() - from).toBeLessThan(1000);
  }, 20_000);
});
