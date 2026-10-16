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
import { InventoryAccess } from './access/access';
import { WarehouseController } from './warehouse/warehouse.controller';
import { WarehouseRepository } from './warehouse/warehouse.repository';
import { WarehouseService } from './warehouse/warehouse.service';
import { StockController } from './stock/stock.controller';
import { StockRepository } from './stock/stock.repository';
import { StockService } from './stock/stock.service';
import { ReservationController } from './reservation/reservation.controller';
import { ReservationExpiry } from './reservation/expiry';
import { ReservationRepository } from './reservation/reservation.repository';
import { ReservationService } from './reservation/reservation.service';
import { ReservationSweeper } from './reservation/reservation.sweeper';
import { ShipmentController } from './shipment/shipment.controller';
import { ShipmentRepository } from './shipment/shipment.repository';
import { ShipmentService } from './shipment/shipment.service';
import { ReturnShipmentController } from './return-shipment/return-shipment.controller';
import { ReturnShipmentRepository } from './return-shipment/return-shipment.repository';
import { ReturnShipmentService } from './return-shipment/return-shipment.service';
import { CommandRunner } from './shared/command-runner';
import { IdempotencyStore } from './shared/idempotency';
import { inventoryReservationsOverdue } from './observability/metrics';
import { HealthController, MetricsController } from './health/health.controller';
import { ENV, LOGGER } from './tokens';
import { loadInventoryEnv, SERVICE_NAME, type InventoryEnv } from './config/env';

/**
 * inventory-service wiring (COM-006 PR 1, ADR-056).
 *
 * ## No consumer, one sweeper — by decision
 *
 * Nothing here consumes another service's events (ADR-056 § 7, ADR-032: no empty consumers);
 * every command arrives over REST from a person. The one background job is the sweeper that
 * releases reservations past their `expiresAt` (Q-102); the outbox relay publishes what the
 * commands wrote — stock, warehouse and, since PR 2, shipment events. The integration ports
 * (PR 3) bring their own wiring.
 *
 * `ReservationController` is registered before `StockController`: both live under `/v1/stock`,
 * and the router must meet `stock/reservations` before `stock/:id`.
 */
@Module({
  controllers: [
    WarehouseController,
    ReservationController,
    StockController,
    ShipmentController,
    ReturnShipmentController,
    HealthController,
    MetricsController,
  ],
  providers: [
    { provide: ENV, useFactory: () => loadInventoryEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: InventoryEnv): Logger => {
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
      useFactory: (env: InventoryEnv) => new PrismaService(env.DATABASE_URL),
    },

    {
      provide: KafkaEventPublisher,
      inject: [ENV],
      useFactory: (env: InventoryEnv) =>
        new KafkaEventPublisher(kafkaConnection(env, env.KAFKA_CLIENT_ID)),
    },

    PrismaOutboxStore,
    EventPublisher,
    InventoryAccess,
    CommandRunner,
    WarehouseRepository,
    WarehouseService,
    StockRepository,
    StockService,
    ReservationRepository,
    ReservationExpiry,
    ReservationService,
    ShipmentRepository,
    ShipmentService,
    ReturnShipmentRepository,
    ReturnShipmentService,

    {
      provide: ReservationSweeper,
      inject: [ReservationRepository, ReservationExpiry, ENV],
      useFactory: (
        reservations: ReservationRepository,
        expiry: ReservationExpiry,
        env: InventoryEnv,
      ) =>
        new ReservationSweeper(reservations, expiry, {
          intervalMs: env.INVENTORY_RESERVATION_SWEEP_INTERVAL_SECONDS * 1000,
          batchSize: env.INVENTORY_RESERVATION_SWEEP_BATCH_SIZE,
        }),
    },

    // Idempotent commands (docs/06 § 6.8): this service's own store for every POST — every one
    // an operator's command, a shipment's included (its consignee only reads), authorized before
    // its key is claimed or replayed.
    {
      provide: IdempotencyStore,
      inject: [PrismaService, ENV, InventoryAccess],
      useFactory: (prisma: PrismaService, env: InventoryEnv, access: InventoryAccess) =>
        new IdempotencyStore(prisma, env, () => {
          access.assertOperator();
        }),
    },

    {
      provide: InternalTokenService,
      inject: [ENV],
      useFactory: (env: InventoryEnv) =>
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
        env: InventoryEnv,
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
      useFactory: (store: PrismaOutboxStore, env: InventoryEnv, logger: Logger) =>
        new OutboxPurgeScheduler({
          store,
          service: SERVICE_NAME,
          logger,
          ...outboxPurgeSettings(env),
        }),
    },
    {
      // D-052: the relay, the purge and the reservation sweeper stop together in the destroy
      // phase, by one deadline inside SHUTDOWN_TIMEOUT_MS. The sweeper too: stopped later, it
      // could keep writing outbox rows while the relay drained.
      provide: OutboxShutdown,
      inject: [OutboxRelay, OutboxPurgeScheduler, ReservationSweeper, ENV],
      useFactory: (
        relay: OutboxRelay,
        purge: OutboxPurgeScheduler,
        sweeper: ReservationSweeper,
        env: InventoryEnv,
      ) =>
        new OutboxShutdown({
          relay,
          purge,
          workers: [sweeper],
          budgetMs: outboxShutdownBudgetMs(env),
        }),
    },

    {
      provide: AUTH_OPTIONS,
      inject: [ENV, InternalTokenService],
      useFactory: (env: InventoryEnv, internalTokens: InternalTokenService): AuthGuardOptions => ({
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
    private readonly sweeper: ReservationSweeper,
    private readonly reservations: ReservationRepository,
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
    // First of all (D-045): nothing is served, swept or relayed as a role that could lift
    // this service's database guards.
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
        // Reservations the sweeper has not reached yet, from the database (ADR-050).
        inventoryReservationsOverdue.set(
          { service: SERVICE_NAME },
          await this.reservations.overdueCount(),
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
    // The relay, the purge and the sweeper already stopped in OutboxShutdown's onModuleDestroy,
    // concurrently and by one deadline; this joins that stop and returns at once.
    await this.outboxShutdown.stop();
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
  }
}
