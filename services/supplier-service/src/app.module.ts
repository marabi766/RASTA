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
import { EventPublisher } from './events/publisher';
import { SupplierRepository } from './supplier/supplier.repository';
import { SupplierService } from './supplier/supplier.service';
import { QualificationService } from './supplier/qualification.service';
import { SuspensionService } from './supplier/suspension.service';
import { SupplierController } from './supplier/supplier.controller';
import { HealthController, MetricsController } from './health/health.controller';
import { ConcludedOutcomeRepository } from './performance/concluded-outcome.repository';
import { PerformanceEventRepository } from './performance/performance-event.repository';
import {
  PERFORMANCE_CONSUMED_TOPICS,
  PERFORMANCE_CONSUMER,
  PerformanceConsumer,
  SUPPLIER_DEAD_LETTER_TOPIC,
} from './performance/performance.consumer';
import { ENV, LOGGER } from './tokens';
import { brokersOf, loadSupplierEnv, SERVICE_NAME, type SupplierEnv } from './config/env';

/**
 * supplier-service wiring.
 *
 * ## No external boundary is bound here, and that is the phase's shape
 *
 * document-service, maintenance-service and marketplace-service all appear in
 * this service's eventual dependency list, and none of them is wired. There is
 * no port, no client and no stub, because a port with no implementation to
 * choose between is scaffolding that looks like work.
 *
 * The one that will come first is document-service: `qualification_evidence`
 * stores identifiers this service never resolves, and resolving them needs a
 * service-to-service metadata endpoint that does not exist. When it does, it
 * belongs here as a symbol in `tokens.ts` with a named implementation — the same
 * shape `WorkshopDirectory` uses on the maintenance side of this same gap
 * (ADR-029).
 *
 * ## One Kafka consumer: the performance facts (ADR-052 step 5)
 *
 * `PerformanceConsumer` reads `rasta.marketplace.v1` and records what each
 * event says about a supplier — a promise, a delivery, a rating, an attributed
 * dispute or cancellation, a concluded order — and nothing else. Its effect is
 * a stored fact, so the `processed_event` marker it writes is true: ADR-032's
 * objection to a handler that swallows an event does not apply. No score is
 * computed from those facts yet (step 6, docs/24 Q-77..Q-79).
 *
 * maintenance-service's `REPAIR_COMPLETED` / `REPAIR_CANCELLED` carry nothing
 * a component can measure (no promise, no rating, no structured attribution),
 * and contract-service and construction-service publish no rating, so none of
 * those topics is subscribed.
 */
@Module({
  controllers: [SupplierController, HealthController, MetricsController],
  providers: [
    { provide: ENV, useFactory: () => loadSupplierEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: SupplierEnv): Logger => {
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
      useFactory: (env: SupplierEnv) => new PrismaService(env.DATABASE_URL),
    },

    {
      provide: KafkaEventPublisher,
      inject: [ENV],
      useFactory: (env: SupplierEnv) =>
        new KafkaEventPublisher({
          brokers: brokersOf(env),
          clientId: env.KAFKA_CLIENT_ID,
        }),
    },

    PrismaOutboxStore,
    EventPublisher,
    SupplierRepository,
    SupplierService,
    QualificationService,
    SuspensionService,
    PerformanceEventRepository,
    ConcludedOutcomeRepository,

    {
      provide: PerformanceConsumer,
      inject: [ENV, LOGGER, PrismaService, PerformanceEventRepository, ConcludedOutcomeRepository],
      useFactory: (
        env: SupplierEnv,
        logger: Logger,
        prisma: PrismaService,
        events: PerformanceEventRepository,
        outcomes: ConcludedOutcomeRepository,
      ) =>
        new PerformanceConsumer(
          (handler) =>
            new EventConsumer(
              {
                brokers: brokersOf(env),
                clientId: `${env.KAFKA_CLIENT_ID}-performance`,
                groupId: PERFORMANCE_CONSUMER,
                topics: [...PERFORMANCE_CONSUMED_TOPICS],
                deadLetterTopic: SUPPLIER_DEAD_LETTER_TOPIC,
                // A performance history is rebuilt from whatever the topic still
                // retains (ADR-052 § 12); starting at deploy time would begin it
                // empty. Rows are idempotent on the source event id.
                fromBeginning: true,
              },
              handler,
              {
                log: (m) => logger.info(m),
                warn: (m) => logger.warn(m),
                error: (m, trace) => logger.error({ err: trace }, m),
              },
            ),
          prisma,
          events,
          outcomes,
          logger,
        ),
    },

    {
      provide: InternalTokenService,
      inject: [ENV],
      useFactory: (env: SupplierEnv) =>
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
        env: SupplierEnv,
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
      inject: [ENV, InternalTokenService],
      useFactory: (env: SupplierEnv, internalTokens: InternalTokenService): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
        tokenVerifier: new TokenVerifier({
          jwksUri: env.OIDC_JWKS_URI,
          issuer: env.OIDC_ISSUER_URL,
          audience: env.OIDC_AUDIENCE,
        }),
        internalTokens,
      }),
    },

    // Authenticate, then authorize. Registered globally so an endpoint is
    // closed unless it opts out with @Public (AGENTS.md A-12, S-02).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule, OnModuleInit, OnApplicationShutdown {
  private gaugeTimer?: NodeJS.Timeout;

  constructor(
    private readonly relay: OutboxRelay,
    private readonly store: PrismaOutboxStore,
    private readonly prisma: PrismaService,
    private readonly performance: PerformanceConsumer,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    // Middleware rather than an interceptor: it must wrap the guards too, so
    // the auth guard has a context to record the resolved tenant into, and so
    // every mutation below it can read the correlation id it stamps on rows.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  async onModuleInit(): Promise<void> {
    // First of all: nothing is relayed or served as a role that could disable
    // the triggers that make the performance tables append-only.
    await this.prisma.assertRuntimeRole();

    this.relay.start();
    await this.performance.start();

    const sample = async () => {
      try {
        outboxPendingTotal.set({ service: SERVICE_NAME }, await this.store.pendingCount());
        outboxLeasesActive.set({ service: SERVICE_NAME }, await this.store.activeLeaseCount());
        outboxPendingAgeSeconds.set(
          { service: SERVICE_NAME },
          await this.store.oldestPendingAgeSeconds(),
        );
      } catch {
        // Upkeep must never take the service down. The relay's own logging
        // covers a persistent database problem.
      }
    };

    void sample();
    this.gaugeTimer = setInterval(() => void sample(), 30_000);
    this.gaugeTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
    await this.performance.stop();
    await this.relay.stop();
  }
}
