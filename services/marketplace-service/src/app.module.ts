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
import { IdempotencyStore } from './shared/idempotency';
import { OrderRepository } from './order/order.repository';
import { OrderService } from './order/order.service';
import { OrderController } from './order/order.controller';
import { ReturnDispatchSourceService } from './returns/dispatch-source';
import { InternalReturnController } from './returns/internal-return.controller';
import { OrderReturnsController, ReturnController } from './returns/return.controller';
import { ReturnRepository } from './returns/return.repository';
import { ReturnService } from './returns/return.service';
import {
  MARKETPLACE_DEAD_LETTER_TOPIC,
  RETURN_MIRROR_CONSUMED_TOPICS,
  RETURN_MIRROR_CONSUMER,
  ReturnMirrorConsumer,
  returnMirrorConsumerFactory,
} from './returns/return-mirror.consumer';
import { CatalogueService } from './offer/catalogue.service';
import { OfferController, ProductController } from './offer/catalogue.controller';
import { EconomicClient } from './economic/economic.client';
import { OrganizationHierarchy } from './organization/organization-hierarchy';
import { OrderSagaClient } from './temporal/saga.client';
import { OrderSagaWorker } from './temporal/worker';
import { HealthController, MetricsController } from './health/health.controller';
import { ENV, LOGGER } from './tokens';
import { loadMarketplaceEnv, SERVICE_NAME, type MarketplaceEnv } from './config/env';

/**
 * marketplace-service wiring.
 *
 * ## One Kafka consumer: the return mirror (RUN-005 PR 3)
 *
 * `ReturnMirrorConsumer` reads inventory-service's `RETURN_SHIPMENT_*` events
 * on `rasta.inventory.v1` and moves the return request they name through
 * IN_TRANSIT … RESOLVED, after checking each against the request (ADR-048,
 * docs/23 D-058). Its effect is a state change with its own history and outbox
 * event, so the `processed_event` marker it writes is true (ADR-032). Off by
 * default and gated on an authenticated broker (`assertReturnMirrorMayStart`).
 *
 * `docs/04` § 4.8's six consumed events stay unwired, each for its own reason
 * (ADR-041 § 4): `PAYMENT_*` would be a second path for a fact the saga already
 * gets synchronously, and `SUPPLIER_*` / `STOCK_RESERVED` have no producer.
 */
@Module({
  controllers: [
    OrderController,
    OrderReturnsController,
    ReturnController,
    InternalReturnController,
    ProductController,
    OfferController,
    HealthController,
    MetricsController,
  ],
  providers: [
    { provide: ENV, useFactory: () => loadMarketplaceEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: MarketplaceEnv): Logger => {
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
      useFactory: (env: MarketplaceEnv) => new PrismaService(env.DATABASE_URL),
    },

    {
      provide: KafkaEventPublisher,
      inject: [ENV],
      useFactory: (env: MarketplaceEnv) =>
        new KafkaEventPublisher(kafkaConnection(env, env.KAFKA_CLIENT_ID)),
    },

    PrismaOutboxStore,
    EventPublisher,
    IdempotencyStore,
    OrderRepository,
    OrderService,
    ReturnRepository,
    ReturnService,
    ReturnDispatchSourceService,
    CatalogueService,
    OrderSagaClient,
    OrderSagaWorker,

    {
      provide: ReturnMirrorConsumer,
      inject: [ENV, LOGGER, PrismaService, ReturnRepository, EventPublisher],
      useFactory: (
        env: MarketplaceEnv,
        logger: Logger,
        prisma: PrismaService,
        repository: ReturnRepository,
        events: EventPublisher,
      ) =>
        new ReturnMirrorConsumer(
          // Disabled by default, and refused at startup without an authenticated broker.
          returnMirrorConsumerFactory(
            env,
            (handler) =>
              new EventConsumer(
                {
                  ...kafkaConnection(env, `${env.KAFKA_CLIENT_ID}-return-mirror`),
                  groupId: RETURN_MIRROR_CONSUMER,
                  topics: [...RETURN_MIRROR_CONSUMED_TOPICS],
                  deadLetterTopic: MARKETPLACE_DEAD_LETTER_TOPIC,
                  // A request authorized before the consumer first ran may already have its
                  // shipment's events on the topic; the request's version makes a replay of
                  // anything already applied a no-op.
                  fromBeginning: true,
                },
                handler,
                {
                  log: (m) => logger.info(m),
                  warn: (m) => logger.warn(m),
                  error: (m, trace) => logger.error({ err: trace }, m),
                },
              ),
          ),
          prisma,
          repository,
          events,
          { partialDispatchAllowed: env.MARKETPLACE_RETURN_PARTIAL_DISPATCH_ALLOWED },
          logger,
        ),
    },

    {
      // The same secret and issuer the auth guard verifies with, so a token
      // this service mints for economic-service is one economic-service can
      // check (ADR-035).
      provide: InternalTokenService,
      inject: [ENV],
      useFactory: (env: MarketplaceEnv) =>
        new InternalTokenService(
          env.INTERNAL_TOKEN_SECRET,
          env.INTERNAL_TOKEN_ISSUER,
          env.INTERNAL_TOKEN_TTL_SECONDS,
        ),
    },

    EconomicClient,

    /**
     * The owner of the organization hierarchy (A-13), asked whether a union
     * administrator decides a dispute for an order whose buyer is within its
     * union (docs/24 Q-136). Its token is minted by the service above.
     */
    {
      provide: OrganizationHierarchy,
      inject: [ENV, InternalTokenService],
      useFactory: (env: MarketplaceEnv, tokens: InternalTokenService) =>
        new OrganizationHierarchy({
          baseUrl: env.ORGANIZATION_SERVICE_URL,
          timeoutMs: env.MARKETPLACE_ORGANIZATION_REQUEST_TIMEOUT_MS,
          tokens,
        }),
    },

    {
      provide: OutboxRelay,
      inject: [PrismaOutboxStore, KafkaEventPublisher, ENV, LOGGER],
      useFactory: (
        store: PrismaOutboxStore,
        publisher: KafkaEventPublisher,
        env: MarketplaceEnv,
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
      // D-052: published rows past OUTBOX_PURGE_RETENTION_HOURS, in bounded batches.
      provide: OutboxPurgeScheduler,
      inject: [PrismaOutboxStore, ENV, LOGGER],
      useFactory: (store: PrismaOutboxStore, env: MarketplaceEnv, logger: Logger) =>
        new OutboxPurgeScheduler({
          store,
          service: SERVICE_NAME,
          logger,
          ...outboxPurgeSettings(env),
        }),
    },
    {
      // D-052: the relay, the purge, the Temporal worker and the return mirror
      // stop together in the destroy phase, by one deadline inside
      // SHUTDOWN_TIMEOUT_MS.
      provide: OutboxShutdown,
      inject: [
        OutboxRelay,
        OutboxPurgeScheduler,
        OrderSagaWorker,
        ReturnMirrorConsumer,
        KafkaEventPublisher,
        ENV,
      ],
      useFactory: (
        relay: OutboxRelay,
        purge: OutboxPurgeScheduler,
        saga: OrderSagaWorker,
        mirror: ReturnMirrorConsumer,
        publisher: KafkaEventPublisher,
        env: MarketplaceEnv,
      ) =>
        new OutboxShutdown({
          relay,
          purge,
          workers: [saga, mirror],
          // Closed last, once the drain has returned, by the same deadline (D-052 phase 4b).
          publishers: [publisher],
          budgetMs: outboxShutdownBudgetMs(env),
        }),
    },

    {
      provide: AUTH_OPTIONS,
      inject: [ENV, InternalTokenService],
      useFactory: (
        env: MarketplaceEnv,
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

    // Authenticate, then authorize. Registered globally so an endpoint is
    // closed unless it opts out with @Public (AGENTS.md A-12).
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
    private readonly mirror: ReturnMirrorConsumer,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    // Middleware rather than an interceptor: it must wrap the guards too, so
    // the auth guard has a context to record the resolved tenant into.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  async onModuleInit(): Promise<void> {
    // First of all (D-045): nothing is served, relayed or consumed as a role
    // that could lift this service's database guards.
    await this.prisma.assertRuntimeRole();

    this.relay.start();
    this.purge.start();
    await this.mirror.start();

    const sample = async () => {
      try {
        outboxPendingTotal.set({ service: SERVICE_NAME }, await this.store.pendingCount());
        outboxLeasesActive.set({ service: SERVICE_NAME }, await this.store.activeLeaseCount());
        outboxPendingAgeSeconds.set(
          { service: SERVICE_NAME },
          await this.store.oldestPendingAgeSeconds(),
        );
        // Expired idempotency records, removed by age alone. Unscoped by
        // necessity — the timer runs outside any request — and safe because
        // the predicate can only match records that are already unusable.
        await this.idempotency.purgeExpired();
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
    // The relay, the purge and the saga worker already stopped in
    // OutboxShutdown's onModuleDestroy, concurrently and by one deadline; this
    // joins that stop and returns at once.
    await this.outboxShutdown.stop();
  }
}
