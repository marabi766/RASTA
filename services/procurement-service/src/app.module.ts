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
  EXCEPTION_FILTER_LOGGER,
  InternalTokenService,
  OutboxPurgeScheduler,
  OutboxRelay,
  OutboxShutdown,
  outboxPurgeSettings,
  RequestContextMiddleware,
  RolesGuard,
  TokenVerifier,
  toLogContext,
  type AuthGuardOptions,
  kafkaConnection,
} from '@rasta/nest-common';
import { outboxShutdownBudgetMs } from '@rasta/config';
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
import { EventPublisher } from './events/publisher';
import { ProcurementAccess } from './access/access';
import { DemandRepository } from './demand/demand.repository';
import { DemandService } from './demand/demand.service';
import { AggregationController, DemandController } from './demand/demand.controller';
import { DatabaseClock } from './shared/clock';
import { IdempotencyStore } from './shared/idempotency';
import { HealthController, MetricsController } from './health/health.controller';
import { ENV, LOGGER } from './tokens';
import { loadProcurementEnv, SERVICE_NAME, type ProcurementEnv } from './config/env';

/**
 * procurement-service wiring (COM-007 PR 1, ADR-070).
 *
 * ## No consumer, no sweeper, no workflow — by decision
 *
 * The procurement boundary starts with an organization's demands and the window each joins: a
 * command API for the buyer and the outbox that announces every change. No Temporal (ADR-070
 * § 11: a window is a column and every decision reads the database clock after the lock), no
 * consumer (nothing here listens to another service yet), and no sweeper: a window whose end has
 * passed is ended by the next demand for its product, in that demand's transaction; the sweeper
 * that ends it on time is ADR-070 plan PR 2. Nothing here calls another service.
 */
@Module({
  controllers: [DemandController, AggregationController, HealthController, MetricsController],
  providers: [
    { provide: ENV, useFactory: () => loadProcurementEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: ProcurementEnv): Logger => {
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
      useFactory: (env: ProcurementEnv) => new PrismaService(env.DATABASE_URL),
    },

    {
      provide: KafkaEventPublisher,
      inject: [ENV],
      useFactory: (env: ProcurementEnv) =>
        new KafkaEventPublisher(kafkaConnection(env, env.KAFKA_CLIENT_ID)),
    },

    PrismaOutboxStore,
    EventPublisher,
    DatabaseClock,
    ProcurementAccess,
    DemandRepository,
    DemandService,

    // Idempotent commands (docs/06 § 6.8): this service's own store for every command.
    {
      provide: IdempotencyStore,
      inject: [PrismaService, ENV],
      useFactory: (prisma: PrismaService, env: ProcurementEnv) => new IdempotencyStore(prisma, env),
    },

    {
      // The auth guard verifies a service's internal token too: no route accepts one today
      // (ProcurementAccess refuses a service caller), but a request bearing one is judged, not
      // misread as anonymous.
      provide: InternalTokenService,
      inject: [ENV],
      useFactory: (env: ProcurementEnv) =>
        new InternalTokenService(
          env.INTERNAL_TOKEN_SECRET,
          env.INTERNAL_TOKEN_ISSUER,
          env.INTERNAL_TOKEN_TTL_SECONDS,
        ),
    },

    {
      provide: OutboxRelay,
      inject: [PrismaOutboxStore, KafkaEventPublisher, ENV, LOGGER],
      useFactory: (
        store: PrismaOutboxStore,
        publisher: KafkaEventPublisher,
        env: ProcurementEnv,
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
          // Counters only. Both outbox gauges are sampled from the database below, never
          // maintained by inc/dec — an arithmetic gauge drifts on every restart and every
          // missed error path (ADR-050).
          onFenced: (count) => outboxAckFencedTotal.inc({ service: SERVICE_NAME }, count),
          onReclaimed: (count) => outboxLeaseReclaimedTotal.inc({ service: SERVICE_NAME }, count),
          onClaimAttempt: (count) => outboxClaimAttemptsTotal.inc({ service: SERVICE_NAME }, count),
        }),
    },

    {
      // D-052: published rows past OUTBOX_PURGE_RETENTION_HOURS, in bounded batches.
      provide: OutboxPurgeScheduler,
      inject: [PrismaOutboxStore, ENV, LOGGER],
      useFactory: (store: PrismaOutboxStore, env: ProcurementEnv, logger: Logger) =>
        new OutboxPurgeScheduler({
          store,
          service: SERVICE_NAME,
          logger,
          ...outboxPurgeSettings(env),
        }),
    },
    {
      // D-052: the relay and the purge stop together in the destroy phase, by one deadline inside
      // SHUTDOWN_TIMEOUT_MS; the publisher closes last, by the same deadline (D-052 phase 4b).
      provide: OutboxShutdown,
      inject: [OutboxRelay, OutboxPurgeScheduler, KafkaEventPublisher, ENV],
      useFactory: (
        relay: OutboxRelay,
        purge: OutboxPurgeScheduler,
        publisher: KafkaEventPublisher,
        env: ProcurementEnv,
      ) =>
        new OutboxShutdown({
          relay,
          purge,
          workers: [],
          publishers: [publisher],
          budgetMs: outboxShutdownBudgetMs(env),
        }),
    },

    {
      provide: AUTH_OPTIONS,
      inject: [ENV, InternalTokenService],
      useFactory: (
        env: ProcurementEnv,
        internalTokens: InternalTokenService,
      ): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
        tokenVerifier: new TokenVerifier({
          jwksUri: env.OIDC_JWKS_URI,
          issuer: env.OIDC_ISSUER_URL,
          audience: env.OIDC_AUDIENCE,
        }),
        internalTokens,
      }),
    },

    // Authenticate, then authorize. Registered globally so an endpoint is closed unless it
    // opts out with @Public (AGENTS.md A-12, S-02).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule, OnModuleInit, OnApplicationShutdown {
  private gaugeTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: OutboxRelay,
    private readonly purge: OutboxPurgeScheduler,
    private readonly outboxShutdown: OutboxShutdown,
    private readonly store: PrismaOutboxStore,
    private readonly idempotency: IdempotencyStore,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    // Middleware rather than an interceptor: it must wrap the guards too, so the auth guard
    // has a context to record the resolved tenant into, and so every mutation below it can
    // read the correlation id it stamps on rows.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  async onModuleInit(): Promise<void> {
    // First of all (D-045): nothing is served or relayed as a role that could lift this
    // service's database guards.
    await this.prisma.assertRuntimeRole();

    this.relay.start();
    this.purge.start();

    const sample = async () => {
      try {
        outboxPendingTotal.set({ service: SERVICE_NAME }, await this.store.pendingCount());
        outboxLeasesActive.set({ service: SERVICE_NAME }, await this.store.activeLeaseCount());
        outboxPendingAgeSeconds.set(
          { service: SERVICE_NAME },
          await this.store.oldestPendingAgeSeconds(),
        );
      } catch {
        // Upkeep must never take the service down. The relay's own logging covers a
        // persistent database problem.
      }
      try {
        // Expired Idempotency-Key records, removed by age alone: unscoped by necessity, safe
        // because they are already unusable.
        await this.idempotency.purgeExpired();
      } catch {
        // Upkeep must never take the service down either.
      }
    };

    void sample();
    this.gaugeTimer = setInterval(() => void sample(), 30_000);
    this.gaugeTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
    // The relay and the purge already stopped in OutboxShutdown's onModuleDestroy, by one
    // deadline; this joins that stop and returns at once.
    await this.outboxShutdown.stop();
  }
}
