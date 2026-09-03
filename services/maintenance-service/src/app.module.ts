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
import { MaintenanceRepository } from './maintenance/maintenance.repository';
import { ScheduleService } from './maintenance/schedule.service';
import { RequestService } from './maintenance/request.service';
import { RepairOrderService } from './maintenance/repair-order.service';
import { DueAnnouncerService } from './maintenance/due-announcer.service';
import { DueScanner } from './maintenance/due-scanner';
import { WorkshopDirectory, UnverifiedWorkshopDirectory } from './maintenance/workshop.directory';
import { ScheduleController } from './maintenance/schedule.controller';
import { RequestController } from './maintenance/request.controller';
import { RepairOrderController } from './maintenance/repair-order.controller';
import { AssetSyncConsumer } from './consumers/asset-sync.consumer';
import { UsageConsumer } from './consumers/usage.consumer';
import { requestsAwaitingApproval, requestsOpenTotal } from './observability/metrics';
import { HealthController, MetricsController } from './health/health.controller';
import { ENV, LOGGER } from './tokens';
import {
  loadMaintenanceEnv,
  MAINTENANCE_DLQ_TOPIC,
  SERVICE_NAME,
  type MaintenanceEnv,
} from './config/env';

/**
 * Topics this service reads, and why they are two subscriptions rather than
 * one.
 *
 * The two consumers do different jobs that fail differently, and docs/07 §
 * 7.10 asks for one consumer group per (service, purpose):
 *
 *   usage        `rasta.fleet.v1` — the trigger for usage-based service
 *                schedules. Losing an event here understates a machine hours
 *                and defers a service that is actually due.
 *   asset-sync   `rasta.asset.v1` — the reference replica. Losing an event
 *                here means a slightly stale listing.
 *
 * Sharing one group would put both behind the same lag, the same dead-letter
 * topic and the same offset, so a backlog in the noisy one would delay the
 * important one.
 *
 * Both read from the beginning. A service that only knows about machines
 * registered, and hours run, after it was first deployed cannot evaluate a
 * schedule.
 */
const FLEET_TOPICS = ['rasta.fleet.v1'];
const ASSET_TOPICS = ['rasta.asset.v1'];

// A note on the three providers nothing below injects — `UsageConsumer`,
// `AssetSyncConsumer` and `DueScanner`. Nest instantiates every provider a
// module declares, so their `onModuleInit` runs and they subscribe and start
// their timer without anyone holding a reference. Injecting them into
// `AppModule` purely to keep them alive would be a lie about the dependency.

@Module({
  controllers: [
    ScheduleController,
    RequestController,
    RepairOrderController,
    HealthController,
    MetricsController,
  ],
  providers: [
    { provide: ENV, useFactory: () => loadMaintenanceEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: MaintenanceEnv): Logger => {
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
      useFactory: (env: MaintenanceEnv) => new PrismaService(env.DATABASE_URL),
    },

    {
      provide: KafkaEventPublisher,
      inject: [ENV],
      useFactory: (env: MaintenanceEnv) =>
        new KafkaEventPublisher({
          brokers: brokersOf(env),
          clientId: env.KAFKA_CLIENT_ID,
        }),
    },

    PrismaOutboxStore,
    MaintenanceRepository,
    ScheduleService,
    RequestService,
    RepairOrderService,
    DueAnnouncerService,
    DueScanner,

    // The boundary with supplier-service, bound to the one implementation this
    // platform can honestly provide today. Filling the gap is a second class
    // and this one line (ADR-029).
    { provide: WorkshopDirectory, useClass: UnverifiedWorkshopDirectory },

    {
      provide: UsageConsumer,
      inject: [ENV, LOGGER, MaintenanceRepository, DueAnnouncerService],
      useFactory: (
        env: MaintenanceEnv,
        logger: Logger,
        repository: MaintenanceRepository,
        announcer: DueAnnouncerService,
      ) =>
        new UsageConsumer(
          (handler) =>
            new EventConsumer(
              {
                brokers: brokersOf(env),
                clientId: `${env.KAFKA_CLIENT_ID}-usage`,
                groupId: 'maintenance-service.usage',
                topics: FLEET_TOPICS,
                deadLetterTopic: MAINTENANCE_DLQ_TOPIC,
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
          announcer,
        ),
    },

    {
      provide: AssetSyncConsumer,
      inject: [ENV, LOGGER, MaintenanceRepository],
      useFactory: (env: MaintenanceEnv, logger: Logger, repository: MaintenanceRepository) =>
        new AssetSyncConsumer(
          (handler) =>
            new EventConsumer(
              {
                brokers: brokersOf(env),
                clientId: `${env.KAFKA_CLIENT_ID}-asset-sync`,
                groupId: 'maintenance-service.asset-sync',
                topics: ASSET_TOPICS,
                deadLetterTopic: MAINTENANCE_DLQ_TOPIC,
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
        ),
    },

    {
      provide: OutboxRelay,
      inject: [PrismaOutboxStore, KafkaEventPublisher, ENV, LOGGER],
      useFactory: (
        store: PrismaOutboxStore,
        publisher: KafkaEventPublisher,
        env: MaintenanceEnv,
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
      useFactory: (env: MaintenanceEnv): AuthGuardOptions => ({
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

  constructor(
    private readonly relay: OutboxRelay,
    private readonly store: PrismaOutboxStore,
    private readonly repository: MaintenanceRepository,
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
        // Both gauges span tenants by design — they are operational figures no
        // tenant ever sees. They go through the repository's `runUnscoped`
        // path so the crossing stays greppable and lands in the audit log.
        requestsOpenTotal.set(
          { service: SERVICE_NAME },
          await this.repository.countOpenRequestsAcrossTenants(),
        );
        requestsAwaitingApproval.set(
          { service: SERVICE_NAME },
          await this.repository.countAwaitingApprovalAcrossTenants(),
        );
      } catch {
        // Metrics must never take the service down.
      }
    };

    this.gaugeTimer = setInterval(() => void sample(), 15_000);
    this.gaugeTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    // Let an in-flight batch finish so it is not republished on restart.
    await this.relay.stop();
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
  }
}

function brokersOf(env: MaintenanceEnv): string[] {
  return env.KAFKA_BROKERS.split(',').map((broker) => broker.trim());
}
