import { EventEmitter } from 'node:events';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTH_OPTIONS,
  installGracefulShutdown,
  OutboxRelay,
  OutboxShutdown,
  type AuthGuardOptions,
  type InternalTokenService,
  type OutboxClaim,
  type OutboxRow,
  type TokenVerifier,
} from '@rasta/nest-common';
import { AppModule } from '../src/app.module';
import { ENV } from '../src/tokens';
import { loadNotificationEnv, SERVICE_NAME, type NotificationEnv } from '../src/config/env';
import { DispatcherConsumer } from '../src/intake/dispatcher.consumer';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { ResolutionWorker } from '../src/resolution/resolution.worker';
import { MailWorker } from '../src/channels/mail.worker';
import { databaseUrl } from './helpers';

/**
 * The shutdown path through the real `AppModule` (follow-up to #247).
 *
 * Nothing stopped the outbox relay: `AppModule` had no shutdown hook, so the
 * relay kept polling through the close and after it, claiming rows the closed
 * publisher could not send, and an in-flight publish was simply cut off. The
 * two workers stopped only in `onApplicationShutdown`, each waiting for its
 * batch with no limit, so a slow one ran the close into the forced exit.
 *
 * Here the real `installGracefulShutdown` closes the real module — its
 * providers, `OutboxShutdown`, Prisma — under the real process deadline:
 * timeout 9 s, relay grace 6 s, shared budget 7 s (9 s less the 2 s reserve).
 *
 * Only the outbox store, the broker and the consumer are stand-ins, and the
 * workers' `tick` is replaced before the timers start: both claim across the
 * whole table by design, and the shared database's rows belong to other suites.
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

interface Probe {
  /** Epoch ms of every relay claim. */
  claims: number[];
  /** Epoch ms of every worker tick, per worker. */
  ticks: { resolution: number[]; mail: number[] };
  publishes: number;
}

interface Behaviour {
  /** The relay always has a row to claim; otherwise one, once. */
  endlessRows: boolean;
  /** `publish` never returns; otherwise it succeeds until the publisher closes. */
  publishHangs: boolean;
  /** The mail worker's batch never ends; otherwise both ticks return at once. */
  mailHangs: boolean;
}

async function boot(behaviour: Behaviour): Promise<{
  app: INestApplication;
  env: NotificationEnv;
  probe: Probe;
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
    NOTIFICATION_RESOLUTION_POLL_INTERVAL_MS: '100',
    NOTIFICATION_MAIL_POLL_INTERVAL_MS: '100',
  });

  const probe: Probe = { claims: [], ticks: { resolution: [], mail: [] }, publishes: 0 };
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
  };

  // Like the real publisher: refuses once the destroy phase has closed it.
  let publisherClosed = false;
  const publisher = {
    publish: (): Promise<void> => {
      probe.publishes += 1;
      if (behaviour.publishHangs) return never<void>();
      if (publisherClosed) return Promise.reject(new Error('Kafka publisher has been shut down'));
      return Promise.resolve();
    },
    isHealthy: async () => true,
    onModuleDestroy: async () => {
      publisherClosed = true;
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(PrismaOutboxStore)
    .useValue(store)
    .overrideProvider(KafkaEventPublisher)
    .useValue(publisher)
    .overrideProvider(DispatcherConsumer)
    .useValue({
      start: async () => undefined,
      onModuleDestroy: async () => undefined,
      isRunning: () => false,
    })
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
  return { app, env, probe };
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

describe('notification-service shutdown: relay and workers by one deadline', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    // Closed by the test; a second close is a no-op either way.
    await app?.close().catch(() => undefined);
    app = undefined;
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

  it('ends a slow relay and a mail batch that never ends by the shared budget, under the timeout', async () => {
    const booted = await boot({ endlessRows: false, publishHangs: true, mailHangs: true });
    app = booted.app;
    await waitFor(
      () => booted.probe.publishes === 1 && booted.probe.ticks.mail.length === 1,
      'the publish and the mail batch to start',
    );

    const closed = await closeLikeMain(app, booted.env);
    await pause(500);

    // A clean close, not the timeout: exit 0 and nothing logged as an error.
    expect(closed.exits).toEqual([0]);
    expect(closed.errors).toEqual([]);
    // The mail batch has no bound of its own, so the budget ended it: the
    // longest wait, beside the relay's grace rather than after it.
    expect(closed.tookMs).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    expect(closed.tookMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    // And started nothing new while closing.
    expect(booted.probe.publishes).toBe(1);
    expect(booted.probe.ticks.mail).toHaveLength(1);
    expect(booted.probe.claims).toHaveLength(1);
  }, 30_000);
});
