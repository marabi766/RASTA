import { EventEmitter } from 'node:events';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTH_OPTIONS,
  EventConsumer,
  installGracefulShutdown,
  OutboxPurgeScheduler,
  OutboxRelay,
  OutboxShutdown,
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
import { loadNotificationEnv, SERVICE_NAME, type NotificationEnv } from '../src/config/env';
import { DispatcherConsumer } from '../src/intake/dispatcher.consumer';
import { NotificationRepository } from '../src/notification/notification.repository';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { ResolutionWorker } from '../src/resolution/resolution.worker';
import { MailWorker } from '../src/channels/mail.worker';
import { databaseUrl, MAINTENANCE_TOPIC, maintenanceDue, newOrganizationId } from './helpers';

/**
 * The shutdown path through the real `AppModule` (follow-up to #247).
 *
 * Nothing stopped the outbox relay: `AppModule` had no shutdown hook, so the
 * relay kept polling through the close and after it, claiming rows the closed
 * publisher could not send, and an in-flight publish was simply cut off. The
 * two workers stopped only in `onApplicationShutdown`, each waiting for its
 * batch with no limit, so a slow one ran the close into the forced exit.
 *
 * Codex r1 on #276 (Medium): the dispatcher consumer's own `onModuleDestroy`
 * stopped `EventConsumer` with no bound, and kafkajs's `disconnect()` waits for
 * the message in flight — an ingest transaction held past the budget (it may
 * run 30 s) held the close into the same forced exit. The consumer is now an
 * `OutboxShutdown` worker, stopped beside the relay, the purge and the workers
 * by the one deadline (#270's `stop({ deadlineAt })`), and the message it
 * abandons is not committed — the group delivers it again.
 *
 * Here the real `installGracefulShutdown` closes the real module — its
 * providers, `OutboxShutdown`, the dispatcher consumer, Prisma — under the
 * real process deadline: timeout 9 s, relay grace 6 s, shared budget 7 s (9 s
 * less the 2 s reserve). The purge (D-052) stops in the same phase by the same
 * deadline: its batch bound is 5.2 s (100 ms wait + 100 ms statement + 5 s
 * margin). A handler that never ends: never.
 *
 * Stand-ins: the outbox store and the publisher; kafkajs under the real
 * `EventConsumer` — a fake that, as kafkajs does, commits a message only when
 * its `eachMessage` returned, so the shared broker's consumer group is left
 * alone; and the workers' `tick`, replaced before the timers start. The relay,
 * the purge and both workers claim across the whole table by design, and the
 * shared database's rows belong to other suites. The dispatcher, its intake
 * decision and its wiring are the real ones; only the repository's `ingest`
 * is held, where the transaction would be.
 */
const SHUTDOWN_TIMEOUT_MS = 9000;
const GRACE_SECONDS = 6;
const BUDGET_MS = SHUTDOWN_TIMEOUT_MS - 2000;

let rowSeq = 0;
const probeRow = (): OutboxRow => {
  rowSeq += 1;
  const id = `SHUTDOWN-PROBE-${rowSeq}`;
  return {
    id,
    aggregateType: 'Probe',
    aggregateId: id,
    eventName: 'PROBE',
    eventVersion: 1,
    topic: 'rasta.notification.v1',
    partitionKey: id,
    payload: {},
    headers: {},
    organizationId: 'ORG-SHUTDOWN-PROBE',
    correlationId: id,
    createdAt: new Date(),
    publishedAt: null,
    attempts: 0,
    lastError: null,
  };
};

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  deliver(topic: string, offset: string, value: Buffer): Promise<void> {
    if (!this.eachMessage) throw new Error('the consumer is not running');
    this.inFlight = this.eachMessage({
      topic,
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

/** A due-soon reminder, as maintenance-service publishes it: a rule claims it. */
const dueSoon = (): Buffer =>
  Buffer.from(
    JSON.stringify(
      maintenanceDue({ organizationId: newOrganizationId(), scheduleId: `MSC_${ulid()}` }),
    ),
  );

interface Probe {
  /** Epoch ms of every relay claim. */
  claims: number[];
  /** Epoch ms of every worker tick, per worker. */
  ticks: { resolution: number[]; mail: number[] };
  publishes: number;
  /** Purge batches begun; each one never ends. */
  purges: number;
  /** Events the dispatcher handed to the repository's `ingest`. */
  ingests: number;
}

interface Behaviour {
  /** The relay always has a row to claim; otherwise one, once. */
  endlessRows: boolean;
  /** `publish` never returns; otherwise it succeeds until the publisher closes. */
  publishHangs: boolean;
  /** The mail worker's batch never ends; otherwise both ticks return at once. */
  mailHangs: boolean;
  /**
   * What the dispatcher's `ingest` waits for before it answers "already
   * processed"; absent, it never answers. The real one would hold its
   * transaction there.
   */
  ingestGate?: Promise<void>;
}

async function boot(behaviour: Behaviour): Promise<{
  app: INestApplication;
  env: NotificationEnv;
  probe: Probe;
  kafka: FakeKafkaConsumer;
}> {
  const env = loadNotificationEnv({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl(),
    KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
    KAFKA_ALLOW_PLAINTEXT: process.env.KAFKA_ALLOW_PLAINTEXT ?? 'true',
    IDENTITY_SERVICE_URL: 'http://notificationtest.invalid:3101',
    OIDC_ISSUER_URL: 'http://notificationtest.invalid/realms/rasta',
    OIDC_JWKS_URI: 'http://notificationtest.invalid/realms/rasta/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: `itest-${'x'.repeat(40)}`,
    SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
    OUTBOX_SHUTDOWN_GRACE_SECONDS: String(GRACE_SECONDS),
    OUTBOX_POLL_INTERVAL_MS: '50',
    OUTBOX_PURGE_MAX_WAIT_MS: '100',
    OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: '100',
    // No scheduled run: a test puts the one batch in flight itself.
    OUTBOX_PURGE_INTERVAL_SECONDS: '86400',
    NOTIFICATION_RESOLUTION_POLL_INTERVAL_MS: '100',
    NOTIFICATION_MAIL_POLL_INTERVAL_MS: '100',
  });

  const probe: Probe = {
    claims: [],
    ticks: { resolution: [], mail: [] },
    publishes: 0,
    purges: 0,
    ingests: 0,
  };
  let claimedOnce = false;
  const store: Partial<Record<keyof PrismaOutboxStore, unknown>> = {
    claimPending: async (): Promise<OutboxClaim> => {
      probe.claims.push(Date.now());
      if (!behaviour.endlessRows && claimedOnce) return { token: null, rows: [], reclaimed: 0 };
      claimedOnce = true;
      return { token: `tok-${probe.claims.length}`, rows: [probeRow()], reclaimed: 0 };
    },
    markPublished: async (ids: readonly string[]) => ids.length,
    markFailed: async () => 1,
    release: async (ids: readonly string[]) => ids.length,
    renew: async (ids: readonly string[]) => [...ids],
    oldestPendingAgeSeconds: async () => 0,
    pendingCount: async () => 0,
    activeLeaseCount: async () => 0,
    purgePublished: (): Promise<PurgePublishedBatch> => {
      probe.purges += 1;
      return never();
    },
  };

  // Like the real publisher: refuses once `OutboxShutdown` has closed it, after
  // the drain (D-052 phase 4b).
  let publisherClosed = false;
  const publisher = {
    publish: (): Promise<void> => {
      probe.publishes += 1;
      if (behaviour.publishHangs) return never<void>();
      if (publisherClosed) return Promise.reject(new Error('Kafka publisher has been shut down'));
      return Promise.resolve();
    },
    isHealthy: async () => true,
    stop: async () => {
      publisherClosed = true;
    },
  };

  // The real EventConsumer the AppModule builds, with kafkajs swapped for the
  // fake before it connects. No dead letter is reached here: the producer is
  // never asked for.
  const kafka = new FakeKafkaConsumer();
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
  const gate = behaviour.ingestGate;
  jest.spyOn(NotificationRepository.prototype, 'ingest').mockImplementation(async () => {
    probe.ingests += 1;
    if (!gate) return never();
    await gate;
    return { kind: 'DUPLICATE_EVENT' };
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(PrismaOutboxStore)
    .useValue(store)
    .overrideProvider(KafkaEventPublisher)
    .useValue(publisher)
    .overrideProvider(AUTH_OPTIONS)
    .useValue({
      serviceName: SERVICE_NAME,
      tokenVerifier: {} as unknown as TokenVerifier,
      internalTokens: {} as unknown as InternalTokenService,
    } satisfies AuthGuardOptions)
    .compile();

  // Before `init()` starts the timers: the real workers, with their batch replaced.
  jest.spyOn(moduleRef.get(ResolutionWorker), 'tick').mockImplementation(async () => {
    probe.ticks.resolution.push(Date.now());
    return 0;
  });
  jest.spyOn(moduleRef.get(MailWorker), 'tick').mockImplementation(() => {
    probe.ticks.mail.push(Date.now());
    return behaviour.mailHangs ? never<number>() : Promise.resolve(0);
  });

  const app = moduleRef.createNestApplication();
  await app.init();
  // The real dispatcher, consuming through the real EventConsumer.
  expect(app.get(DispatcherConsumer).isRunning()).toBe(true);
  return { app, env, probe, kafka };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await pause(20);
  }
}

/** Closes `app` the way `main.ts` does and reports how it ended. */
async function closeLikeMain(app: INestApplication, env: NotificationEnv) {
  const exits: number[] = [];
  const errors: string[] = [];
  const shutdown = installGracefulShutdown(app, {
    serviceName: SERVICE_NAME,
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    exit: (code) => exits.push(code),
    signalSource: new EventEmitter(),
    logger: { warn: () => undefined, error: (message) => errors.push(message) },
  });
  const startedAt = Date.now();
  await shutdown.shutdown('SIGTERM');
  const endedAt = Date.now();
  return { exits, errors, startedAt, endedAt, tookMs: endedAt - startedAt };
}

const after = (stamps: readonly number[], at: number) => stamps.filter((t) => t > at);

describe('notification-service shutdown: relay, purge, workers and consumer by one deadline', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    // Closed by the test; a second close is a no-op either way.
    await app?.close().catch(() => undefined);
    app = undefined;
    jest.restoreAllMocks();
  });

  it('drains a slow relay inside the close, by its grace, and exits 0', async () => {
    const booted = await boot({ endlessRows: false, publishHangs: true, mailHangs: false });
    app = booted.app;
    expect(app.get(OutboxRelay)).toBeInstanceOf(OutboxRelay);
    expect(app.get(OutboxShutdown)).toBeInstanceOf(OutboxShutdown);
    await waitFor(() => booted.probe.publishes === 1, 'the relay to publish');

    const closed = await closeLikeMain(app, booted.env);

    expect(closed.exits).toEqual([0]);
    expect(closed.errors).toEqual([]);
    // The relay was stopped and its publish waited for, up to its grace —
    // never stopped, the close returned at once and cut the publish off.
    expect(closed.tookMs).toBeGreaterThanOrEqual(GRACE_SECONDS * 1000 - 100);
    expect(closed.tookMs).toBeLessThan(GRACE_SECONDS * 1000 + 1500);
    expect(booted.probe.publishes).toBe(1);
  }, 30_000);

  it('claims nothing once the close has begun, though the publisher closed under it', async () => {
    const booted = await boot({ endlessRows: true, publishHangs: false, mailHangs: false });
    app = booted.app;
    await waitFor(() => booted.probe.claims.length >= 3, 'the relay to claim');

    const closed = await closeLikeMain(app, booted.env);
    // Long enough for several polls, had anything kept polling.
    await pause(500);

    expect(closed.exits).toEqual([0]);
    expect(closed.errors).toEqual([]);
    expect(after(booted.probe.claims, closed.endedAt)).toEqual([]);
    expect(after(booted.probe.ticks.resolution, closed.endedAt)).toEqual([]);
    expect(after(booted.probe.ticks.mail, closed.endedAt)).toEqual([]);
  }, 30_000);

  it('ends a slow relay, a purge batch and a mail batch that never end by the shared budget, under the timeout', async () => {
    const booted = await boot({ endlessRows: false, publishHangs: true, mailHangs: true });
    app = booted.app;
    const purge = app.get(OutboxPurgeScheduler);
    expect(purge.stopBoundMs).toBe(5200);
    void purge.runOnce();
    await waitFor(
      () =>
        booted.probe.publishes === 1 &&
        booted.probe.ticks.mail.length === 1 &&
        booted.probe.purges === 1,
      'the publish, the mail batch and the purge batch to start',
    );

    const closed = await closeLikeMain(app, booted.env);
    await pause(500);

    // A clean close, not the timeout: exit 0 and nothing logged as an error.
    expect(closed.exits).toEqual([0]);
    expect(closed.errors).toEqual([]);
    // The mail batch has no bound of its own, so the budget ended it: the
    // longest wait, beside the relay's grace and the purge's bound rather than
    // after them.
    expect(closed.tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(closed.tookMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    // And started nothing new while closing.
    expect(booted.probe.publishes).toBe(1);
    expect(booted.probe.ticks.mail).toHaveLength(1);
    expect(booted.probe.claims).toHaveLength(1);
    expect(booted.probe.purges).toBe(1);
  }, 30_000);

  it('ends a dispatcher ingest that never returns by the shared budget: exit 0, its event not committed (Codex r1 on #276)', async () => {
    const booted = await boot({ endlessRows: false, publishHangs: false, mailHangs: false });
    app = booted.app;
    void booted.kafka.deliver(MAINTENANCE_TOPIC, '61', dueSoon());
    await waitFor(() => booted.probe.ingests === 1, 'the dispatcher to ingest');

    const closed = await closeLikeMain(app, booted.env);

    // A clean close, not the timeout. Nothing else waits here, so the time is
    // the consumer's: held to the shared budget — with no bound, it never
    // returned and the close was forced (exit 1).
    expect(closed.exits).toEqual([0]);
    expect(closed.errors).toEqual([]);
    expect(closed.tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(closed.tookMs).toBeLessThan(BUDGET_MS + 1500);
    expect(closed.tookMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    // The event was abandoned, not committed: the group delivers it again.
    expect(booted.kafka.committed).toEqual([]);
    expect(booted.probe.ingests).toBe(1);
  }, 30_000);

  it('an ingest that finishes after the close: its event is still not committed', async () => {
    let release!: () => void;
    const ingestGate = new Promise<void>((resolve) => (release = resolve));
    const booted = await boot({
      endlessRows: false,
      publishHangs: false,
      mailHangs: false,
      ingestGate,
    });
    app = booted.app;
    const delivered = booted.kafka.deliver(MAINTENANCE_TOPIC, '62', dueSoon());
    await waitFor(() => booted.probe.ingests === 1, 'the dispatcher to ingest');

    const closed = await closeLikeMain(app, booted.env);
    expect(closed.exits).toEqual([0]);
    expect(closed.tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);

    // It answers now, after the deadline. The stop gave the message up, so
    // `eachMessage` throws and kafkajs keeps the offset; the redelivery meets
    // the `processed_event` marker the transaction wrote (A-09).
    release();
    await delivered;
    expect(booted.kafka.committed).toEqual([]);
    expect(booted.kafka.uncommitted).toEqual(['62']);
  }, 30_000);

  it('ends a slow relay, a purge batch, a mail batch and a dispatcher ingest that never end by the shared budget', async () => {
    const booted = await boot({ endlessRows: false, publishHangs: true, mailHangs: true });
    app = booted.app;
    const purge = app.get(OutboxPurgeScheduler);
    void purge.runOnce();
    void booted.kafka.deliver(MAINTENANCE_TOPIC, '63', dueSoon());
    await waitFor(
      () =>
        booted.probe.publishes === 1 &&
        booted.probe.ticks.mail.length === 1 &&
        booted.probe.purges === 1 &&
        booted.probe.ingests === 1,
      'the publish, the mail batch, the purge batch and the ingest to start',
    );

    const closed = await closeLikeMain(app, booted.env);

    expect(closed.exits).toEqual([0]);
    expect(closed.errors).toEqual([]);
    // All four waited for beside one another, not one after the other.
    expect(closed.tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(closed.tookMs).toBeLessThan(BUDGET_MS + 1500);
    expect(booted.kafka.committed).toEqual([]);
    expect(booted.probe.ingests).toBe(1);
  }, 30_000);
});
