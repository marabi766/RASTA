import { EventEmitter } from 'node:events';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { EventEnvelope } from '@rasta/contracts';
import {
  AUTH_OPTIONS,
  EventConsumer,
  installGracefulShutdown,
  type AuthGuardOptions,
  type HandlerOutcome,
  type InternalTokenService,
  type OutboxStopOptions,
  type TokenVerifier,
} from '@rasta/nest-common';
import { AppModule } from '../src/app.module';
import { ENV } from '../src/tokens';
import { loadAnalyticsEnv, SERVICE_NAME, type AnalyticsEnv } from '../src/config/env';
import { MAINTENANCE_TOPIC } from '../src/maintenance/maintenance-fact';
import { MaintenanceFactsConsumer } from '../src/maintenance/maintenance-facts.consumer';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  cleanup,
  databaseUrl,
  maintenanceCompleted,
  newCompletion,
  newOrganizationId,
  ownerClient,
} from './helpers';

/**
 * The whole shutdown path through the real AppModule, with the projection enabled (#337 r1,
 * Medium).
 *
 * Two defects, both reproduced here before the fix:
 *
 *   1. **Order.** Nest runs a module's providers' destroy hooks before the module's own, so
 *      `PrismaService.onModuleDestroy()` disconnected the database before
 *      `AppModule.onModuleDestroy()` asked the projection to stop: a handler still in flight
 *      lost its database under it. The projection now stops in the destroy phase and the
 *      database disconnects in `onApplicationShutdown`, after it.
 *   2. **No deadline.** The projection called `EventConsumer.stop()` without `deadlineAt`, which
 *      waits for the message in flight — and for a broker that does not answer — without bound,
 *      past SHUTDOWN_TIMEOUT_MS into the forced exit. It now passes the D-052 budget
 *      (`outboxShutdownBudgetMs`: the timeout less the 2 s reserve).
 *
 * Stand-ins: kafkajs under the real `EventConsumer` — a fake that, as kafkajs does, commits a
 * message only when its `eachMessage` returned and waits for the message in flight before its
 * `disconnect()` resolves — and the token verifier. The consumer is enabled through the real
 * gate (`loadAnalyticsEnv` with this service's SASL username over TLS, never connected). The
 * database is real.
 *
 * Settings: timeout 6 s, so the budget is 4 s.
 */
const SHUTDOWN_TIMEOUT_MS = 6000;
const BUDGET_MS = 4000;

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

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

  /** `disconnect: 'never'` is a broker that never answers the leave-group. */
  constructor(private readonly disconnectBehaviour: 'answers' | 'never' = 'answers') {}

  async connect(): Promise<void> {}
  async subscribe(): Promise<void> {}
  async run(config: { eachMessage: EachMessage }): Promise<void> {
    this.eachMessage = config.eachMessage;
  }
  deliver(offset: string, envelope: EventEnvelope): Promise<void> {
    if (!this.eachMessage) throw new Error('the consumer is not running');
    this.inFlight = this.eachMessage({
      topic: MAINTENANCE_TOPIC,
      partition: 0,
      message: { value: Buffer.from(JSON.stringify(envelope)), headers: {}, offset, key: null },
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
    if (this.disconnectBehaviour === 'never') await never();
  }
}

/** The dead-letter producer: a broker that accepts the connection and never acknowledges a send. */
class StalledDlqProducer {
  sends = 0;
  async connect(): Promise<void> {}
  send(): Promise<void> {
    this.sends += 1;
    return never();
  }
  async disconnect(): Promise<void> {}
}

interface Booted {
  app: INestApplication;
  env: AnalyticsEnv;
  kafka: FakeKafkaConsumer;
  producer: StalledDlqProducer;
  /** What happened, in order: the handler, the projection's stop, the database's disconnect. */
  order: string[];
  handled: number;
  stopOptions: OutboxStopOptions[];
}

/**
 * The real AppModule with the stand-ins above. `hold` decides what the handler does before
 * running the real one: never return, wait for a gate, or nothing.
 */
async function boot(options: {
  hold?: () => Promise<void>;
  disconnect?: 'answers' | 'never';
}): Promise<Booted> {
  const source: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl(),
    KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
    // The gate's terms (ADR-061 § 3): this service's own SASL username, TLS, no PLAINTEXT
    // opt-out. Nothing connects: kafkajs is the fake above.
    ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED: 'true',
    KAFKA_ALLOW_PLAINTEXT: 'false',
    KAFKA_SSL: 'true',
    KAFKA_SASL_USERNAME: SERVICE_NAME,
    KAFKA_SASL_PASSWORD: 'shutdown-probe-never-sent',
    OIDC_ISSUER_URL: 'http://analyticstest.invalid/realms/rasta',
    OIDC_JWKS_URI: 'http://analyticstest.invalid/realms/rasta/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: `itest-${'x'.repeat(40)}`,
    SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
    OUTBOX_SHUTDOWN_GRACE_SECONDS: '2',
  };
  // No file is read for a connection that is never made.
  delete source.KAFKA_SSL_CA_FILE;
  const env = loadAnalyticsEnv(source);
  expect(env.ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED).toBe(true);

  const kafka = new FakeKafkaConsumer(options.disconnect);
  const producer = new StalledDlqProducer();
  const booted = { env, kafka, producer, order: [], handled: 0, stopOptions: [] } as Omit<
    Booted,
    'app'
  >;

  // The real EventConsumer the AppModule builds, with kafkajs swapped for the fakes before it
  // connects.
  const realStart = EventConsumer.prototype.start;
  jest.spyOn(EventConsumer.prototype, 'start').mockImplementation(function (this: EventConsumer) {
    (this as unknown as { kafka: unknown }).kafka = {
      consumer: () => kafka,
      producer: () => producer,
    };
    return realStart.call(this);
  });

  const realHandle = MaintenanceFactsConsumer.prototype.handle;
  jest.spyOn(MaintenanceFactsConsumer.prototype, 'handle').mockImplementation(async function (
    this: MaintenanceFactsConsumer,
    envelope: EventEnvelope,
  ) {
    booted.handled += 1;
    await options.hold?.();
    try {
      return (await realHandle.call(this, envelope)) as HandlerOutcome;
    } finally {
      booted.order.push('handler returned');
    }
  });

  const realStop = MaintenanceFactsConsumer.prototype.stop;
  jest.spyOn(MaintenanceFactsConsumer.prototype, 'stop').mockImplementation(async function (
    this: MaintenanceFactsConsumer,
    stop?: OutboxStopOptions,
  ) {
    booted.stopOptions.push(stop ?? {});
    await realStop.call(this, stop);
    booted.order.push('projection stopped');
  });

  const realDisconnect = PrismaService.prototype.disconnect;
  jest.spyOn(PrismaService.prototype, 'disconnect').mockImplementation(async function (
    this: PrismaService,
  ) {
    booted.order.push('database disconnected');
    await realDisconnect.call(this);
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(AUTH_OPTIONS)
    .useValue({
      serviceName: SERVICE_NAME,
      tokenVerifier: {} as unknown as TokenVerifier,
      internalTokens: {} as unknown as InternalTokenService,
    } satisfies AuthGuardOptions)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { ...booted, app } as Booted;
}

async function closeUnderDeadline(
  booted: Booted,
): Promise<{ exits: number[]; errors: string[]; tookMs: number; startedAt: number }> {
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
  return { exits, errors, tookMs: Date.now() - startedAt, startedAt };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const organizations: string[] = [];
const events: string[] = [];

function completion() {
  const organizationId = newOrganizationId();
  organizations.push(organizationId);
  const envelope = maintenanceCompleted(newCompletion(organizationId));
  events.push(envelope.eventId);
  return { organizationId, envelope };
}

describe('analytics-service shutdown: the projection stops by the deadline, then the database disconnects', () => {
  let booted: Booted | undefined;

  afterEach(async () => {
    // Closed by the test; a second close is a no-op either way.
    await booted?.app.close().catch(() => undefined);
    booted = undefined;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(organizations, events);
  });

  it('lets a handler still in flight finish on a live database, then disconnects', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    booted = await boot({ hold: () => gate });
    const { kafka } = booted;
    const { organizationId, envelope } = completion();

    const delivered = kafka.deliver('31', envelope);
    await until(() => booted!.handled > 0);

    // The handler is held until the close has begun, then writes its fact — which it can only
    // do if the database is still connected.
    setTimeout(release, 300);
    const { exits, errors, tookMs } = await closeUnderDeadline(booted);
    await delivered;

    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeLessThan(BUDGET_MS);
    expect(booted.order).toEqual([
      'handler returned',
      'projection stopped',
      'database disconnected',
    ]);
    expect(kafka.committed).toEqual(['31']);

    const owner = ownerClient();
    try {
      expect(await owner.factMaintenance.count({ where: { organizationId } })).toBe(1);
    } finally {
      await owner.$disconnect();
    }
  }, 30_000);

  it('gives up a handler that never returns at the deadline, uncommitted, and still closes cleanly', async () => {
    booted = await boot({ hold: () => never() });
    const { kafka } = booted;
    void kafka.deliver('32', completion().envelope);
    await until(() => booted!.handled > 0);

    const { exits, errors, tookMs, startedAt } = await closeUnderDeadline(booted);

    // A clean close, not the timeout: exit 0 and nothing logged as an error.
    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(tookMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    // The stop was handed the D-052 deadline, inside SHUTDOWN_TIMEOUT_MS.
    const [{ deadlineAt }] = booted.stopOptions as [OutboxStopOptions];
    expect(deadlineAt! - startedAt).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(deadlineAt! - startedAt).toBeLessThanOrEqual(BUDGET_MS + 100);
    // The database disconnected only after the projection's stop returned.
    expect(booted.order).toEqual(['projection stopped', 'database disconnected']);
    // The message was not committed, so the group delivers it again.
    expect(kafka.committed).toEqual([]);
  }, 30_000);

  it.each([
    [
      'a broker that never answers the disconnect',
      { disconnect: 'never' as const },
      () => completion().envelope,
    ],
    [
      'a dead letter the broker never acknowledges',
      { disconnect: 'answers' as const },
      // A payload organization that is not the envelope's: VALIDATION_FAILED, dead-lettered at
      // once, and the send to the DLQ never returns.
      () => {
        const { envelope } = completion();
        return { ...envelope, tenantId: newOrganizationId() } as EventEnvelope;
      },
    ],
  ])(
    'closes by the deadline over %s',
    async (_label, settings, envelopeOf) => {
      booted = await boot(settings);
      const { kafka, producer } = booted;
      void kafka.deliver('33', envelopeOf());
      await until(
        () => booted!.handled > 0 && (settings.disconnect === 'never' || producer.sends > 0),
      );

      const { exits, errors, tookMs } = await closeUnderDeadline(booted);

      expect(exits).toEqual([0]);
      expect(errors).toEqual([]);
      expect(tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
      expect(tookMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
      expect(booted.order.slice(-2)).toEqual(['projection stopped', 'database disconnected']);
    },
    30_000,
  );
});
