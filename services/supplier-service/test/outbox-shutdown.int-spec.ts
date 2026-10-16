import { EventEmitter } from 'node:events';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { EventEnvelope } from '@rasta/contracts';
import {
  AUTH_OPTIONS,
  EventConsumer,
  installGracefulShutdown,
  OutboxPurgeScheduler,
  OutboxRelay,
  type AuthGuardOptions,
  type InternalTokenService,
  type OutboxClaim,
  type OutboxRow,
  type PurgePublishedBatch,
  type TokenVerifier,
} from '@rasta/nest-common';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { ENV } from '../src/tokens';
import { loadSupplierEnv, SERVICE_NAME, type SupplierEnv } from '../src/config/env';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import {
  PERFORMANCE_CONSUMED_TOPICS,
  PerformanceConsumer,
} from '../src/performance/performance.consumer';
import { databaseUrl } from './helpers';

/**
 * The whole shutdown path through the real AppModule, with the performance
 * consumer enabled.
 *
 * Codex r1 on #276 (Medium): `AppModule.onApplicationShutdown` stopped the
 * performance consumer with no bound, after `OutboxShutdown` had drained the
 * relay and the purge in the destroy phase. kafkajs's `disconnect()` waits for
 * the message in flight, so a handler still running when the drain ended held
 * the close past SHUTDOWN_TIMEOUT_MS into the forced exit. The consumer is now
 * an `OutboxShutdown` worker, stopped beside the relay and the purge by the one
 * deadline (#270's `stop({ deadlineAt })`), and the message it abandons is not
 * committed — the group delivers it again.
 *
 * The settings make the old order fail by construction: relay grace 6 s, purge
 * batch bound 5.2 s (100 ms wait + 100 ms statement + 5 s margin), budget 7 s,
 * timeout 9 s. A handler that never finishes, stopped after the drain: never.
 *
 * Stand-ins: the outbox store and the publisher (the relay and the purge claim
 * and delete across the whole table by design, so the shared database's own
 * outbox is left alone), and kafkajs under the real `EventConsumer` — a fake
 * that, as kafkajs does, commits a message only when its `eachMessage`
 * returned, so no broker is reached and the shared group is left alone. The
 * consumer is enabled through the real gate: `loadSupplierEnv` with this
 * service's SASL username over TLS, never connected. The consumer's wiring and
 * the close are the real ones; its handler is held where the transaction would
 * be.
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
  topic: 'rasta.supplier.v1',
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

/** A rating, as marketplace-service publishes it: a fact this consumer records. */
const reviewSubmitted = (): Buffer => {
  const orderId = `ORD_${ulid()}`;
  const envelope: EventEnvelope = {
    eventId: `EVT_${ulid()}`,
    eventName: 'REVIEW_SUBMITTED',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'marketplace-service',
    producerVersion: '1.0.0',
    aggregateType: 'Order',
    aggregateId: orderId,
    tenantId: 'ORG-SHUTDOWN-BUYER',
    correlationId: `COR_${ulid()}`,
    payload: {
      orderId,
      buyerOrganizationId: 'ORG-SHUTDOWN-BUYER',
      supplierOrganizationId: 'ORG-SHUTDOWN-SUPPLIER',
      reviewId: `REV_${ulid()}`,
      rating: 4,
      submittedAt: new Date().toISOString(),
    },
  };
  return Buffer.from(JSON.stringify(envelope));
};

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
      topic: PERFORMANCE_CONSUMED_TOPICS[0],
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

interface Booted {
  app: INestApplication;
  env: SupplierEnv;
  calls: { publish: number; purge: number; handled: number };
  kafka: FakeKafkaConsumer;
}

/**
 * The real AppModule with the stand-ins above. `handle` replaces the
 * performance consumer's, and `relayRow` decides whether the relay claims a
 * probe whose publish never returns.
 */
async function boot(options: {
  handle: () => Promise<void | 'SKIPPED'>;
  relayRow: boolean;
}): Promise<Booted> {
  const source: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl(),
    KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
    // The gate's terms (ADR-061 § 3): this service's own SASL username, TLS,
    // no PLAINTEXT opt-out. Nothing connects: kafkajs is the fake below.
    SUPPLIER_PERFORMANCE_CONSUMER_ENABLED: 'true',
    KAFKA_ALLOW_PLAINTEXT: 'false',
    KAFKA_SSL: 'true',
    KAFKA_SASL_USERNAME: SERVICE_NAME,
    KAFKA_SASL_PASSWORD: 'shutdown-probe-never-sent',
    OIDC_ISSUER_URL: 'http://suppliertest.invalid/realms/rasta',
    OIDC_JWKS_URI: 'http://suppliertest.invalid/realms/rasta/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: `itest-${'x'.repeat(40)}`,
    SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
    OUTBOX_SHUTDOWN_GRACE_SECONDS: String(GRACE_SECONDS),
    OUTBOX_POLL_INTERVAL_MS: '50',
    OUTBOX_PURGE_MAX_WAIT_MS: '100',
    OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: '100',
    // No scheduled run: the test puts the one batch in flight itself.
    OUTBOX_PURGE_INTERVAL_SECONDS: '86400',
  };
  // No file is read for a connection that is never made.
  delete source.KAFKA_SSL_CA_FILE;
  const env = loadSupplierEnv(source);
  expect(env.SUPPLIER_PERFORMANCE_CONSUMER_ENABLED).toBe(true);

  const calls = { publish: 0, purge: 0, handled: 0 };
  let claimed = !options.relayRow;
  const store: Partial<Record<keyof PrismaOutboxStore, unknown>> = {
    claimPending: async (): Promise<OutboxClaim> => {
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
  // The real EventConsumer the AppModule builds, with kafkajs swapped for the
  // fake before it connects. No dead letter is reached here.
  const realStart = EventConsumer.prototype.start;
  jest.spyOn(EventConsumer.prototype, 'start').mockImplementation(function (this: EventConsumer) {
    (this as unknown as { kafka: unknown }).kafka = {
      consumer: () => kafka,
      producer: () => {
        throw new Error('no dead letter is expected in this suite');
      },
    };
    return realStart.call(this);
  });
  jest.spyOn(PerformanceConsumer.prototype, 'handle').mockImplementation(() => {
    calls.handled += 1;
    return options.handle();
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
      isHealthy: async () => true,
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
  return { app, env, calls, kafka };
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

describe('supplier-service shutdown: relay, purge and performance consumer by one deadline (D-052)', () => {
  let booted: Booted | undefined;

  afterEach(async () => {
    // Closed by the test; a second close is a no-op either way.
    await booted?.app.close().catch(() => undefined);
    booted = undefined;
    jest.restoreAllMocks();
  });

  it('finishes the close under SHUTDOWN_TIMEOUT_MS with a publish, a purge batch and a consumer handler that never end', async () => {
    booted = await boot({ handle: () => never(), relayRow: true });
    const { app, calls, kafka } = booted;
    expect(app.get(OutboxRelay)).toBeInstanceOf(OutboxRelay);
    const purge = app.get(OutboxPurgeScheduler);
    expect(purge.stopBoundMs).toBe(5200);

    // The relay's poll claims the probe and its publish hangs; the purge's
    // batch hangs too; and the performance handler never returns.
    void purge.runOnce();
    void kafka.deliver('71', reviewSubmitted());
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
    expect(calls).toMatchObject({ publish: 1, purge: 1, handled: 1 });
    expect(kafka.committed).toEqual([]);
  }, 30_000);

  it('a handler that finishes after the close: its message is still not committed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    booted = await boot({
      handle: async () => {
        await gate;
        return 'SKIPPED';
      },
      relayRow: false,
    });
    const { kafka } = booted;
    const delivered = kafka.deliver('72', reviewSubmitted());
    await until(() => booted!.calls.handled > 0);

    const { exits, errors, tookMs } = await closeUnderDeadline(booted);

    // Nothing else waits here, so the time is the consumer's, held to the
    // shared budget.
    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(tookMs).toBeLessThan(BUDGET_MS + 1500);

    // It returns now, after the deadline. The stop gave the message up, so
    // `eachMessage` throws and kafkajs keeps the offset; the redelivery meets
    // the `processed_event` marker a recorded fact commits with.
    release();
    await delivered;
    expect(kafka.committed).toEqual([]);
    expect(kafka.uncommitted).toEqual(['72']);
  }, 30_000);
});
