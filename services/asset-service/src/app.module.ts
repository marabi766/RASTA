import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import {
  AllExceptionsFilter,
  AuthGuard,
  AUTH_OPTIONS,
  EventConsumer,
  EXCEPTION_FILTER_LOGGER,
  InternalTokenService,
  OutboxRelay,
  RequestContextMiddleware,
  RolesGuard,
  TokenVerifier,
  toLogContext,
  type AuthGuardOptions,
} from '@rasta/nest-common';
import { createLogger, setLogContextProvider, type Logger } from '@rasta/logging';
import {
  outboxAckFencedTotal,
  outboxClaimAttemptsTotal,
  outboxLeaseReclaimedTotal,
  outboxLeasesActive,
  outboxPendingAgeSeconds,
  outboxPendingTotal,
} from '@rasta/observability';
import { PrismaService } from './prisma/prisma.service';
import { PrismaOutboxStore } from './outbox/outbox.store';
import { KafkaEventPublisher } from './outbox/kafka.publisher';
import { AssetRepository } from './asset/asset.repository';
import { AssetService } from './asset/asset.service';
import { AssetController } from './asset/asset.controller';
import { InsuranceService } from './insurance/insurance.service';
import { TimelineConsumer } from './consumers/timeline.consumer';
import { HealthController, MetricsController } from './health/health.controller';
import { loadAssetEnv, SERVICE_NAME, type AssetEnv } from './config/env';

export const ENV = Symbol('ASSET_ENV');
export const LOGGER = Symbol('ASSET_LOGGER');

/**
 * Topics the dossier is built from.
 *
 * Listed here rather than derived, because subscribing to a topic is a
 * deployment fact — it decides consumer-group membership and lag — and should
 * be visible in one place when someone asks what this service listens to.
 *
 * The topics exist from day one even though several producers do not; an empty
 * topic costs nothing, and the alternative is editing this list on every
 * service launch.
 */
const CONSUMED_TOPICS = [
  'rasta.fleet.v1',
  'rasta.maintenance.v1',
  'rasta.marketplace.v1',
  'rasta.construction.v1',
];

@Module({
  controllers: [AssetController, HealthController, MetricsController],
  providers: [
    { provide: ENV, useFactory: () => loadAssetEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: AssetEnv): Logger => {
        const logger = createLogger({
          serviceName: SERVICE_NAME,
          serviceVersion: env.SERVICE_VERSION,
          environment: env.NODE_ENV,
          level: env.LOG_LEVEL,
          pretty: env.NODE_ENV === 'development',
        });
        setLogContextProvider(() => toLogContext());
        return logger;
      },
    },
    { provide: EXCEPTION_FILTER_LOGGER, inject: [LOGGER], useFactory: (l: Logger) => l },

    {
      provide: PrismaService,
      inject: [ENV],
      useFactory: (env: AssetEnv) => new PrismaService(env.DATABASE_URL),
    },

    {
      provide: KafkaEventPublisher,
      inject: [ENV],
      useFactory: (env: AssetEnv) =>
        new KafkaEventPublisher({
          brokers: brokersOf(env),
          clientId: env.KAFKA_CLIENT_ID,
        }),
    },

    PrismaOutboxStore,
    AssetRepository,
    AssetService,

    {
      provide: InsuranceService,
      inject: [AssetRepository, AssetService, ENV],
      useFactory: (repository: AssetRepository, assets: AssetService, env: AssetEnv) =>
        new InsuranceService(repository, assets, env.EXPIRY_WARNING_DAYS),
    },

    {
      provide: TimelineConsumer,
      inject: [ENV, LOGGER, AssetRepository, AssetService],
      useFactory: (
        env: AssetEnv,
        logger: Logger,
        repository: AssetRepository,
        assets: AssetService,
      ) =>
        new TimelineConsumer(
          (handler) =>
            new EventConsumer(
              {
                brokers: brokersOf(env),
                clientId: `${env.KAFKA_CLIENT_ID}-timeline`,
                groupId: 'asset-service.timeline',
                topics: CONSUMED_TOPICS,
                deadLetterTopic: 'rasta.asset.v1.dlq',
                // Projectors read from the start: a dossier that begins at the
                // moment this service was first deployed is not a dossier.
                fromBeginning: true,
              },
              handler,
              {
                log: (m) => logger.info(m),
                warn: (m) => logger.warn(m),
                error: (m, trace) => logger.error({ err: trace }, m),
              },
            ),
          repository,
          assets,
        ),
    },

    {
      provide: OutboxRelay,
      inject: [PrismaOutboxStore, KafkaEventPublisher, ENV, LOGGER],
      useFactory: (
        store: PrismaOutboxStore,
        publisher: KafkaEventPublisher,
        env: AssetEnv,
        logger: Logger,
      ) =>
        new OutboxRelay({
          store,
          publisher,
          pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
          batchSize: env.OUTBOX_BATCH_SIZE,
          leaseSeconds: env.OUTBOX_CLAIM_LEASE_SECONDS,
          backoff: {
            baseSeconds: env.OUTBOX_CLAIM_BACKOFF_SECONDS,
            maxSeconds: env.OUTBOX_CLAIM_BACKOFF_MAX_SECONDS,
          },
          shutdownGraceSeconds: env.OUTBOX_SHUTDOWN_GRACE_SECONDS,
          logger,
          // Counters only. Both outbox gauges are sampled from the database
          // below, never maintained by inc/dec — an arithmetic gauge drifts on
          // every restart and every missed error path (ADR-050).
          onFenced: (count) => outboxAckFencedTotal.inc({ service: SERVICE_NAME }, count),
          onReclaimed: (count) => outboxLeaseReclaimedTotal.inc({ service: SERVICE_NAME }, count),
          onClaimAttempt: (count) => outboxClaimAttemptsTotal.inc({ service: SERVICE_NAME }, count),
        }),
    },

    {
      provide: AUTH_OPTIONS,
      inject: [ENV],
      useFactory: (env: AssetEnv): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
        tokenVerifier: new TokenVerifier({
          jwksUri: env.OIDC_JWKS_URI,
          issuer: env.OIDC_ISSUER_URL,
          audience: env.OIDC_AUDIENCE,
        }),
        internalTokens: new InternalTokenService(
          env.INTERNAL_TOKEN_SECRET,
          env.INTERNAL_TOKEN_ISSUER,
          env.INTERNAL_TOKEN_TTL_SECONDS,
        ),
      }),
    },

    // Authenticate, then authorize. Registered globally so an endpoint is
    // closed unless it opts out with @Public (AGENTS.md A-12).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule, OnModuleInit, OnApplicationShutdown {
  private gaugeTimer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly relay: OutboxRelay,
    private readonly store: PrismaOutboxStore,
    private readonly insurance: InsuranceService,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    // Middleware rather than an interceptor: it must wrap the guards too, so
    // the auth guard has a context to record the resolved tenant into.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  onModuleInit(): void {
    this.relay.start();

    const sample = async () => {
      try {
        outboxPendingTotal.set({ service: SERVICE_NAME }, await this.store.pendingCount());
        outboxLeasesActive.set({ service: SERVICE_NAME }, await this.store.activeLeaseCount());
        outboxPendingAgeSeconds.set(
          { service: SERVICE_NAME },
          await this.store.oldestPendingAgeSeconds(),
        );
      } catch {
        // Metrics must never take the service down.
      }
    };

    this.gaugeTimer = setInterval(() => void sample(), 15_000);
    this.gaugeTimer.unref?.();

    // An interval, not a scheduler, for the MVP. It is honest about what it
    // is: with several replicas every one of them sweeps, which the outbox
    // and idempotent consumers already absorb. When Temporal takes over the
    // scheduled work (ADR-013), this moves there and the method stays.
    this.sweepTimer = setInterval(
      () => {
        void this.insurance.runExpirySweep().catch(() => {
          // Already logged inside; a failed sweep retries on the next tick.
        });
      },
      6 * 60 * 60 * 1000,
    );
    this.sweepTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    // Let an in-flight batch finish so it is not republished on restart.
    await this.relay.stop();
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }
}

function brokersOf(env: AssetEnv): string[] {
  return env.KAFKA_BROKERS.split(',').map((broker) => broker.trim());
}
