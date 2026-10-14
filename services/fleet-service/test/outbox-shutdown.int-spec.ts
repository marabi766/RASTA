import { EventEmitter } from 'node:events';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTH_OPTIONS,
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
import { AppModule } from '../src/app.module';
import { ENV } from '../src/tokens';
import { loadFleetEnv, SERVICE_NAME, type FleetEnv } from '../src/config/env';
import { AssetSyncConsumer } from '../src/consumers/asset-sync.consumer';
import { KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { databaseUrl } from './helpers';

/**
 * Codex r2 on #247: the whole shutdown path through the real AppModule.
 *
 * The purge drained in Nest's destroy phase and the relay's grace started
 * only in `onApplicationShutdown`, so two bounds that each fit
 * SHUTDOWN_TIMEOUT_MS ran one after the other and overran it: the process
 * exited 1, forced, mid-close. Here a relay publish and a purge batch both
 * never end, and the real `installGracefulShutdown` closes the real module —
 * its providers, `OutboxShutdown`, Prisma — under the real process deadline.
 *
 * The settings make the old order fail by construction: relay grace 6 s, purge
 * batch bound 5.2 s (100 ms wait + 100 ms statement + 5 s margin), timeout
 * 9 s. In sequence that is 11.2 s; concurrently, by one deadline, 6 s.
 *
 * Only the outbox store and the broker are stand-ins. The relay and the purge
 * claim and delete across the whole table by design, so the shared database's
 * own outbox is left alone: a relay whose publish never returns would hold
 * other suites' rows under its lease.
 */
const SHUTDOWN_TIMEOUT_MS = 9000;
const GRACE_SECONDS = 6;

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

describe('fleet-service shutdown: relay and purge by one deadline (D-052)', () => {
  let app: INestApplication;
  let env: FleetEnv;
  const calls = { publish: 0, purge: 0, claims: 0 };

  beforeAll(async () => {
    env = loadFleetEnv({
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
    });

    let claimed = false;
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
      })
      .overrideProvider(AssetSyncConsumer)
      .useValue({ onModuleInit: async () => undefined, onModuleDestroy: async () => undefined })
      .overrideProvider(AUTH_OPTIONS)
      .useValue({
        serviceName: SERVICE_NAME,
        tokenVerifier: {} as unknown as TokenVerifier,
        internalTokens: {} as unknown as InternalTokenService,
      } satisfies AuthGuardOptions)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    // Closed by the test; a second close is a no-op either way.
    await app?.close().catch(() => undefined);
  });

  it('finishes the close under SHUTDOWN_TIMEOUT_MS with a publish and a purge batch that never end', async () => {
    expect(app.get(OutboxRelay)).toBeInstanceOf(OutboxRelay);
    const purge = app.get(OutboxPurgeScheduler);
    expect(purge.stopBoundMs).toBe(5200);

    // The relay's poll claims the probe and its publish hangs; the purge's
    // batch hangs too.
    void purge.runOnce();
    const deadline = Date.now() + 10_000;
    while ((calls.publish === 0 || calls.purge === 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(calls).toMatchObject({ publish: 1, purge: 1 });

    const exits: number[] = [];
    const errors: string[] = [];
    const signals = new EventEmitter();
    const shutdown = installGracefulShutdown(app, {
      serviceName: SERVICE_NAME,
      timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      exit: (code) => exits.push(code),
      signalSource: signals,
      logger: { warn: () => undefined, error: (message) => errors.push(message) },
    });

    const startedAt = Date.now();
    await shutdown.shutdown('SIGTERM');
    const tookMs = Date.now() - startedAt;

    // A clean close, not the timeout: exit 0 and nothing logged as an error.
    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    expect(tookMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    // It did wait for the relay's grace — the longer of the two bounds, run
    // beside the purge's rather than after it.
    expect(tookMs).toBeGreaterThanOrEqual(GRACE_SECONDS * 1000 - 100);
    expect(tookMs).toBeLessThan(GRACE_SECONDS * 1000 + 2000);
    // And started nothing new while closing.
    expect(calls.purge).toBe(1);
    expect(calls.publish).toBe(1);
  }, 30_000);
});
