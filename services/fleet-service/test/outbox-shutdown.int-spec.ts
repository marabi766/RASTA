import { EventEmitter } from 'node:events';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DLQ_REASONS } from '@rasta/contracts';
import {
  AUTH_OPTIONS,
  EventConsumer,
  installGracefulShutdown,
  OutboxPurgeScheduler,
  OutboxRelay,
  runUnscoped,
  UnprocessableEventError,
  type AuthGuardOptions,
  type InternalTokenService,
  type OutboxClaim,
  type OutboxRow,
  type PurgePublishedBatch,
  type TokenVerifier,
} from '@rasta/nest-common';
import { AppModule } from '../src/app.module';
import { ENV } from '../src/tokens';
import { loadFleetEnv, SERVICE_NAME, type FleetEnv } from '../src/config/env';
import { AssetSyncConsumer, CONSUMER_NAME } from '../src/consumers/asset-sync.consumer';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import type { PrismaService } from '../src/prisma/prisma.service';
import { cleanup, databaseUrl, id, newPrisma, producerShaped, tenants } from './helpers';

/**
 * The whole shutdown path through the real AppModule.
 *
 * Codex r2 on #247: the purge drained in Nest's destroy phase and the relay's
 * grace started only in `onApplicationShutdown`, so two bounds that each fit
 * SHUTDOWN_TIMEOUT_MS ran one after the other and overran it: the process
 * exited 1, forced, mid-close.
 *
 * Codex on #267 (Medium): the asset-sync consumer's own `onModuleDestroy`
 * stopped `EventConsumer` with no bound, and kafkajs's `disconnect()` waits for
 * the message in flight — a handler that does not return, or a dead letter
 * whose send does not, held the close into the same forced exit. The consumer
 * is now an `OutboxShutdown` worker, stopped beside the relay and the purge by
 * the one deadline.
 *
 * Codex r1 on #270: the deadline bounded the wait, not the message — a handler
 * or a dead-letter send that finished after it let `eachMessage` return, and
 * kafkajs committed the offset the stop had said it abandoned. Now neither is
 * committed; the redelivery meets the handler's marker.
 *
 * The settings make the old orders fail by construction: relay grace 6 s, purge
 * batch bound 5.2 s (100 ms wait + 100 ms statement + 5 s margin), budget 7 s,
 * timeout 9 s. Relay and purge in sequence: 11.2 s. A consumer that never
 * finishes: never.
 *
 * Stand-ins: the outbox store and the publisher (the relay and the purge claim
 * and delete across the whole table by design, so the shared database's own
 * outbox is left alone), and kafkajs under the real `EventConsumer` — a fake
 * that, as kafkajs does, commits a message only when its `eachMessage`
 * returned, so the shared broker's consumer group is left alone too. The
 * consumer, its wiring and the close are the real ones.
 */
const SHUTDOWN_TIMEOUT_MS = 9000;
const GRACE_SECONDS = 6;
/** `outboxShutdownBudgetMs`: the timeout less the 2 s reserve. */
const BUDGET_MS = 7000;

const probeRow = (): OutboxRow => ({
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

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** The real projection, taken before any test replaces it. */
const realHandle = AssetSyncConsumer.prototype.handle;

/** A new machine for `organizationId`, as asset-service publishes it. */
const assetCreated = (organizationId: string, assetId: string): Buffer =>
  Buffer.from(
    JSON.stringify({
      eventId: id('EVT'),
      eventName: 'ASSET_CREATED',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'asset-service',
      producerVersion: '1.0.0',
      aggregateType: 'Asset',
      aggregateId: assetId,
      correlationId: id('COR'),
      tenantId: organizationId,
      payload: producerShaped('ASSET_CREATED', {
        organizationId,
        assetId,
        status: 'ACTIVE',
        name: 'لودر',
      }),
    }),
  );

/** How many processed-event markers the asset-sync consumer holds for the event. */
const processedCount = (prisma: PrismaService, event: Buffer): Promise<number> =>
  prisma.client.processedEvent.count({
    where: {
      eventId: (JSON.parse(event.toString('utf8')) as { eventId: string }).eventId,
      consumerName: CONSUMER_NAME,
    },
  });

type EachMessage = (payload: {
  topic: string;
  partition: number;
  message: { value: Buffer; headers: Record<string, never>; offset: string; key: null };
  heartbeat: () => Promise<void>;
  pause: () => () => void;
}) => Promise<void>;

/** kafkajs's consumer, reduced to what decides the outcome: commit only on return. */
class FakeKafkaConsumer {
  readonly committed: string[] = [];
  readonly uncommitted: string[] = [];
  private eachMessage?: EachMessage;
  private inFlight: Promise<void> = Promise.resolve();
  async connect(): Promise<void> {}
  async subscribe(): Promise<void> {}
  async run(config: { eachMessage: EachMessage }): Promise<void> {
    this.eachMessage = config.eachMessage;
  }
  deliver(offset: string, value: Buffer): Promise<void> {
    if (!this.eachMessage) throw new Error('the consumer is not running');
    this.inFlight = this.eachMessage({
      topic: 'rasta.asset.v1',
      partition: 0,
      message: { value, headers: {}, offset, key: null },
      heartbeat: async () => undefined,
      pause: () => () => undefined,
    }).then(
      () => void this.committed.push(offset),
      () => void this.uncommitted.push(offset),
    );
    return this.inFlight;
  }
  /** Like kafkajs: waits for the message in flight before it resolves. */
  async disconnect(): Promise<void> {
    await this.inFlight;
  }
}

/**
 * The dead-letter producer, as kafkajs behaves (Codex r1 on #270): closing it
 * cancels nothing — `disconnect()` waits for the send in flight, which lands if
 * the broker answers (`release()`).
 */
class FakeDlqProducer {
  sends = 0;
  landed = 0;
  disconnects = 0;
  private readonly pending = new Set<Promise<void>>();
  private answer!: () => void;
  private readonly answered = new Promise<void>((resolve) => (this.answer = resolve));
  constructor(private readonly hangSend: boolean) {}
  release(): void {
    this.answer();
  }
  async connect(): Promise<void> {}
  async send(): Promise<void> {
    this.sends += 1;
    const request = (this.hangSend ? this.answered : Promise.resolve()).then(() => {
      this.landed += 1;
    });
    this.pending.add(request);
    try {
      await request;
    } finally {
      this.pending.delete(request);
    }
  }
  async disconnect(): Promise<void> {
    this.disconnects += 1;
    await Promise.all([...this.pending]);
  }
}

const assetEvent = (eventId: string): Buffer =>
  Buffer.from(
    JSON.stringify({
      eventId,
      eventName: 'ASSET_CREATED',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'asset-service',
      producerVersion: '1.0.0',
      aggregateType: 'Asset',
      aggregateId: 'AST-SHUTDOWN-PROBE',
      correlationId: 'SHUTDOWN-PROBE',
      tenantId: 'ORG-SHUTDOWN-PROBE',
      payload: {},
    }),
  );

interface Booted {
  app: INestApplication;
  env: FleetEnv;
  calls: { publish: number; purge: number; claims: number; handled: number };
  kafka: FakeKafkaConsumer;
  dlq: FakeDlqProducer;
}

/**
 * The real AppModule with the stand-ins above. `handle` replaces the asset-sync
 * projection, and `relayRow` decides whether the relay claims a probe whose
 * publish never returns.
 */
async function boot(options: {
  handle: (
    this: AssetSyncConsumer,
    ...args: Parameters<AssetSyncConsumer['handle']>
  ) => Promise<void | 'SKIPPED'>;
  relayRow: boolean;
  hangDeadLetter: boolean;
}): Promise<Booted> {
  const env = loadFleetEnv({
    ...process.env,
    NODE_ENV: 'test',
    KAFKA_ALLOW_PLAINTEXT: process.env.KAFKA_ALLOW_PLAINTEXT ?? 'true',
    DATABASE_URL: databaseUrl(),
    KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
    OIDC_ISSUER_URL: 'http://auth.invalid/realms/rasta',
    OIDC_JWKS_URI: 'http://auth.invalid/realms/rasta/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: `itest-${'x'.repeat(40)}`,
    ASSET_SERVICE_URL: 'http://127.0.0.1:9',
    MAINTENANCE_SERVICE_URL: 'http://127.0.0.1:9',
    SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
    OUTBOX_SHUTDOWN_GRACE_SECONDS: String(GRACE_SECONDS),
    OUTBOX_POLL_INTERVAL_MS: '50',
    OUTBOX_PURGE_MAX_WAIT_MS: '100',
    OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: '100',
    // No scheduled run: the test puts the one batch in flight itself.
    OUTBOX_PURGE_INTERVAL_SECONDS: '86400',
    // The parked-insurance sweep reads the shared database; not within the test.
    FLEET_INSURANCE_PARKED_SWEEP_INTERVAL_SECONDS: '3600',
  });

  const calls = { publish: 0, purge: 0, claims: 0, handled: 0 };
  let claimed = !options.relayRow;
  const store: Partial<Record<keyof PrismaOutboxStore, unknown>> = {
    claimPending: async (): Promise<OutboxClaim> => {
      calls.claims += 1;
      if (claimed) return { token: null, rows: [], reclaimed: 0 };
      claimed = true;
      return { token: 'tok-shutdown', rows: [probeRow()], reclaimed: 0 };
    },
    markPublished: async (ids: readonly string[]) => ids.length,
    markFailed: async () => 1,
    release: async (ids: readonly string[]) => ids.length,
    renew: async (ids: readonly string[]) => [...ids],
    oldestPendingAgeSeconds: async () => 0,
    pendingCount: async () => 0,
    activeLeaseCount: async () => 0,
    purgePublished: (): Promise<PurgePublishedBatch> => {
      calls.purge += 1;
      return never();
    },
  };

  const kafka = new FakeKafkaConsumer();
  const dlq = new FakeDlqProducer(options.hangDeadLetter);
  // The real EventConsumer the AppModule builds, with kafkajs swapped for the
  // fakes before it connects.
  const realStart = EventConsumer.prototype.start;
  jest.spyOn(EventConsumer.prototype, 'start').mockImplementation(function (this: EventConsumer) {
    (this as unknown as { kafka: unknown }).kafka = { consumer: () => kafka, producer: () => dlq };
    return realStart.call(this);
  });
  jest.spyOn(AssetSyncConsumer.prototype, 'handle').mockImplementation(function (
    this: AssetSyncConsumer,
    ...args
  ) {
    calls.handled += 1;
    return options.handle.apply(this, args);
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(PrismaOutboxStore)
    .useValue(store)
    .overrideProvider(KafkaEventPublisher)
    .useValue({
      publish: () => {
        calls.publish += 1;
        return never<void>();
      },
      // OutboxShutdown closes the publisher after the drain (D-052 phase 4b).
      stop: async () => undefined,
    })
    .overrideProvider(AUTH_OPTIONS)
    .useValue({
      serviceName: SERVICE_NAME,
      tokenVerifier: {} as unknown as TokenVerifier,
      internalTokens: {} as unknown as InternalTokenService,
    } satisfies AuthGuardOptions)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, env, calls, kafka, dlq };
}

async function closeUnderDeadline(
  booted: Booted,
): Promise<{ exits: number[]; errors: string[]; tookMs: number }> {
  const exits: number[] = [];
  const errors: string[] = [];
  const shutdown = installGracefulShutdown(booted.app, {
    serviceName: SERVICE_NAME,
    timeoutMs: booted.env.SHUTDOWN_TIMEOUT_MS,
    exit: (code) => exits.push(code),
    signalSource: new EventEmitter(),
    logger: { warn: () => undefined, error: (message) => errors.push(message) },
  });
  const startedAt = Date.now();
  await shutdown.shutdown('SIGTERM');
  return { exits, errors, tookMs: Date.now() - startedAt };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('fleet-service shutdown: relay, purge and consumer by one deadline (D-052)', () => {
  let booted: Booted | undefined;

  afterEach(async () => {
    // Closed by the test; a second close is a no-op either way.
    await booted?.app.close().catch(() => undefined);
    booted = undefined;
    jest.restoreAllMocks();
  });

  it('finishes the close under SHUTDOWN_TIMEOUT_MS with a publish, a purge batch and a consumer handler that never end', async () => {
    booted = await boot({ handle: () => never(), relayRow: true, hangDeadLetter: false });
    const { app, calls, kafka } = booted;
    expect(app.get(OutboxRelay)).toBeInstanceOf(OutboxRelay);
    const purge = app.get(OutboxPurgeScheduler);
    expect(purge.stopBoundMs).toBe(5200);

    // The relay's poll claims the probe and its publish hangs; the purge's
    // batch hangs too; and the asset-sync handler never returns.
    void purge.runOnce();
    void kafka.deliver('41', assetEvent('01JSHUTDOWNPROBE0000000041'));
    await until(() => calls.publish > 0 && calls.purge > 0 && calls.handled > 0);
    expect(calls).toMatchObject({ publish: 1, purge: 1, handled: 1 });

    const { exits, errors, tookMs } = await closeUnderDeadline(booted);

    // A clean close, not the timeout: exit 0 and nothing logged as an error.
    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    // The consumer was waited for until the shared deadline, beside the
    // relay's grace and the purge, not after them.
    expect(tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(tookMs).toBeLessThan(BUDGET_MS + 1500);
    // And started nothing new while closing; the message was not committed,
    // so the group delivers it again.
    expect(calls.purge).toBe(1);
    expect(calls.publish).toBe(1);
    expect(calls.handled).toBe(1);
    expect(kafka.committed).toEqual([]);
  }, 30_000);

  it('finishes the close under SHUTDOWN_TIMEOUT_MS with a dead-letter send that never returns', async () => {
    booted = await boot({
      handle: async () => {
        throw new UnprocessableEventError(DLQ_REASONS.SOURCE_UNCONFIRMED, 'shutdown probe');
      },
      relayRow: false,
      hangDeadLetter: true,
    });
    const { calls, kafka, dlq } = booted;
    const delivered = kafka.deliver('42', assetEvent('01JSHUTDOWNPROBE0000000042'));
    await until(() => dlq.sends > 0);
    expect(dlq.sends).toBe(1);

    const { exits, errors, tookMs } = await closeUnderDeadline(booted);

    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    expect(tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(dlq.disconnects).toBe(1);

    // The broker accepts the send after the close (kafkajs's close waits for it
    // rather than cancel it). The message is still not committed, so it is
    // delivered and dead-lettered again.
    dlq.release();
    await delivered;
    expect(dlq.landed).toBe(1);
    expect(kafka.committed).toEqual([]);
    expect(kafka.uncommitted).toEqual(['42']);
    expect(calls.handled).toBe(1);
  }, 30_000);

  it('a handler that finishes after the close: its message is not committed, and its redelivery is skipped — applied once', async () => {
    const org = tenants().a;
    const assetId = id('AST');
    const event = assetCreated(org, assetId);
    const prisma = newPrisma();
    await prisma.onModuleInit();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const outcomes: unknown[] = [];
      booted = await boot({
        // The real projection, held until after the close.
        handle: async function (this: AssetSyncConsumer, ...args) {
          await gate;
          const outcome = await realHandle.apply(this, args);
          outcomes.push(outcome);
          return outcome;
        },
        relayRow: false,
        hangDeadLetter: false,
      });
      const first = booted.kafka;
      const delivered = first.deliver('43', event);
      await until(() => booted!.calls.handled > 0);

      const { exits, tookMs } = await closeUnderDeadline(booted);
      expect(exits).toEqual([0]);
      expect(tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);

      // It ends now, its effect committed with its marker, after the deadline.
      release();
      await delivered;
      expect(outcomes).toEqual([undefined]);
      expect(first.committed).toEqual([]);
      expect(first.uncommitted).toEqual(['43']);
      expect(await processedCount(prisma, event)).toBe(1);
      jest.restoreAllMocks();

      // The group delivers it again, to the next process: the marker stops it
      // before any effect.
      booted = await boot({
        handle: async function (this: AssetSyncConsumer, ...args) {
          const outcome = await realHandle.apply(this, args);
          outcomes.push(outcome);
          return outcome;
        },
        relayRow: false,
        hangDeadLetter: false,
      });
      const effects = jest.spyOn(FleetRepository.prototype, 'upsertAssetRef');
      await booted.kafka.deliver('43', event);
      expect(outcomes).toHaveLength(2);
      expect(effects).not.toHaveBeenCalled();
      expect(booted.kafka.committed).toEqual(['43']);
      expect(await processedCount(prisma, event)).toBe(1);
      const rows = await runUnscoped('test reads the replica across tenants', () =>
        prisma.client.assetRef.findMany({ where: { id: assetId } }),
      );
      expect(rows).toHaveLength(1);
    } finally {
      await cleanup(prisma, [org]);
      await prisma.onModuleDestroy();
    }
  }, 60_000);
});
