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
import { AggregationSettingController } from './setting/setting.controller';
import { AggregationSettingRepository } from './setting/setting.repository';
import { AggregationSettingService } from './setting/setting.service';
import { WindowEnd } from './demand/window-end';
import { WindowSweepRepository } from './demand/window-sweep.repository';
import { WindowSweepService } from './demand/window-sweep.service';
import { AggregationWindowSweeper } from './demand/aggregation-window.sweeper';
import { AggregationController, DemandController } from './demand/demand.controller';
import { DatabaseClock } from './shared/clock';
import { IdempotencyStore } from './shared/idempotency';
import { HealthController, MetricsController } from './health/health.controller';
import { ENV, LOGGER } from './tokens';
import { loadProcurementEnv, SERVICE_NAME, type ProcurementEnv } from './config/env';
import {
  windowDemandsToFollow,
  windowMaxExtensionCount,
  windowSweepDue,
  windowSweepMaxAttempts,
  windowSweepOldestDueAgeSeconds,
} from './observability/metrics';

/**
 * procurement-service wiring (COM-007 PRs 1 and 2, ADR-070).
 *
 * ## No consumer, no workflow — by decision
 *
 * The procurement boundary starts with an organization's demands and the window each joins: a
 * command API for the buyer and the outbox that announces every change. No Temporal (ADR-070
 * § 11: a window is a column and every decision reads the database clock after the lock) and no
 * consumer (nothing here listens to another service yet). A window whose end has passed is ended
 * on time by the leased, fenced `AggregationWindowSweeper` (plan PR 2) — or first by the next
 * demand for its product, in that demand's transaction, with the same transition. Nothing here
 * calls another service.
 */
@Module({
  controllers: [
    DemandController,
    AggregationController,
    AggregationSettingController,
    HealthController,
    MetricsController,
  ],
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
    AggregationSettingRepository,
    AggregationSettingService,
    WindowEnd,
    DemandService,

    // ADR-070 § 2 (plan PR 2): a bounded, leased, fenced sweep ends windows past their end. A
    // demand stays out of an ended window by the clock whether or not it runs.
    WindowSweepRepository,
    WindowSweepService,
    {
      provide: AggregationWindowSweeper,
      inject: [WindowSweepRepository, WindowSweepService, ENV],
      useFactory: (
        repository: WindowSweepRepository,
        service: WindowSweepService,
        env: ProcurementEnv,
      ) =>
        new AggregationWindowSweeper(repository, service, {
          intervalMs: env.PROCUREMENT_WINDOW_SWEEP_INTERVAL_MS,
          batchSize: env.PROCUREMENT_WINDOW_SWEEP_BATCH_SIZE,
          leaseSeconds: env.PROCUREMENT_WINDOW_SWEEP_LEASE_SECONDS,
          retryBackoffBaseSeconds: env.PROCUREMENT_WINDOW_SWEEP_BACKOFF_BASE_SECONDS,
          retryBackoffMaxSeconds: env.PROCUREMENT_WINDOW_SWEEP_BACKOFF_MAX_SECONDS,
        }),
    },

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
      // D-052: the relay, the purge and the window sweeper stop together in the destroy phase, by
      // one deadline inside SHUTDOWN_TIMEOUT_MS — so no sweep writes an outbox row after the relay
      // drained; the publisher closes last, by the same deadline (D-052 phase 4b).
      provide: OutboxShutdown,
      inject: [
        OutboxRelay,
        OutboxPurgeScheduler,
        AggregationWindowSweeper,
        KafkaEventPublisher,
        ENV,
      ],
      useFactory: (
        relay: OutboxRelay,
        purge: OutboxPurgeScheduler,
        sweeper: AggregationWindowSweeper,
        publisher: KafkaEventPublisher,
        env: ProcurementEnv,
      ) =>
        new OutboxShutdown({
          relay,
          purge,
          workers: [sweeper],
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
    private readonly sweeper: AggregationWindowSweeper,
    private readonly sweeps: WindowSweepRepository,
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

    this.sweeper.start();
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
        // Windows past their end not yet ended, and ended ones whose demands still follow
        // (ADR-070 § 2): alert when the oldest keeps ageing or one keeps failing.
        const backlog = await this.sweeps.backlog();
        windowSweepDue.set({ service: SERVICE_NAME }, backlog.due);
        windowSweepOldestDueAgeSeconds.set({ service: SERVICE_NAME }, backlog.oldestDueAgeSeconds);
        windowDemandsToFollow.set({ service: SERVICE_NAME }, backlog.demandsToFollow);
        windowSweepMaxAttempts.set({ service: SERVICE_NAME }, backlog.maxAttempts);
        windowMaxExtensionCount.set({ service: SERVICE_NAME }, backlog.maxExtensionCount);
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
    // The relay, the purge and the sweeper already stopped in OutboxShutdown's onModuleDestroy,
    // by one deadline; this joins that stop and returns at once.
    await this.outboxShutdown.stop();
  }
}
