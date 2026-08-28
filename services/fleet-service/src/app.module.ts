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
import { outboxPendingAgeSeconds, outboxPendingTotal } from '@rasta/observability';
import { PrismaService } from './prisma/prisma.service';
import { PrismaOutboxStore } from './outbox/outbox.store';
import { KafkaEventPublisher } from './outbox/kafka.publisher';
import { FleetRepository } from './fleet/fleet.repository';
import { DriverService } from './fleet/driver.service';
import { AssignmentService } from './fleet/assignment.service';
import { UsageService } from './fleet/usage.service';
import { AvailabilityService } from './fleet/availability.service';
import { DriverController } from './fleet/driver.controller';
import { AssignmentController } from './fleet/assignment.controller';
import { FleetController, UsageController } from './fleet/fleet.controller';
import { AssetSyncConsumer } from './consumers/asset-sync.consumer';
import { assignmentsActiveTotal } from './observability/metrics';
import { HealthController, MetricsController } from './health/health.controller';
import { ENV, LOGGER } from './tokens';
import { loadFleetEnv, SERVICE_NAME, type FleetEnv } from './config/env';

/**
 * Topics the asset replica is built from.
 *
 * Listed here rather than derived, because subscribing to a topic is a
 * deployment fact — it decides consumer-group membership and lag — and should
 * be visible in one place when someone asks what this service listens to.
 *
 * `rasta.maintenance.v1` has no producer yet. Subscribing anyway costs nothing
 * — an empty topic is free — and means launching maintenance-service is a
 * deployment rather than a change here.
 */
const CONSUMED_TOPICS = ['rasta.asset.v1', 'rasta.insurance.v1', 'rasta.maintenance.v1'];

@Module({
  controllers: [
    DriverController,
    AssignmentController,
    UsageController,
    FleetController,
    HealthController,
    MetricsController,
  ],
  providers: [
    { provide: ENV, useFactory: () => loadFleetEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: FleetEnv): Logger => {
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
      useFactory: (env: FleetEnv) => new PrismaService(env.DATABASE_URL),
    },

    {
      provide: KafkaEventPublisher,
      inject: [ENV],
      useFactory: (env: FleetEnv) =>
        new KafkaEventPublisher({
          brokers: brokersOf(env),
          clientId: env.KAFKA_CLIENT_ID,
        }),
    },

    PrismaOutboxStore,
    FleetRepository,
    DriverService,
    AssignmentService,
    UsageService,
    AvailabilityService,

    {
      provide: AssetSyncConsumer,
      inject: [ENV, LOGGER, FleetRepository],
      useFactory: (env: FleetEnv, logger: Logger, repository: FleetRepository) =>
        new AssetSyncConsumer(
          (handler) =>
            new EventConsumer(
              {
                brokers: brokersOf(env),
                clientId: `${env.KAFKA_CLIENT_ID}-asset-sync`,
                // One group per (service, purpose), never shared: a second
                // consumer on the same group would steal partitions and each
                // would see half the stream (docs/07 § 7.10).
                groupId: 'fleet-service.asset-sync',
                topics: CONSUMED_TOPICS,
                deadLetterTopic: 'rasta.fleet.v1.dlq',
                // The replica reads from the start. A fleet that only knows
                // about machines registered after this service was first
                // deployed is not a fleet.
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
        env: FleetEnv,
        logger: Logger,
      ) =>
        new OutboxRelay({
          store,
          publisher,
          pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
          batchSize: env.OUTBOX_BATCH_SIZE,
          logger,
          onBatchPublished: (count) => outboxPendingTotal.dec({ service: SERVICE_NAME }, count),
        }),
    },

    {
      provide: AUTH_OPTIONS,
      inject: [ENV],
      useFactory: (env: FleetEnv): AuthGuardOptions => ({
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
    private readonly prisma: PrismaService,
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
        outboxPendingAgeSeconds.set(
          { service: SERVICE_NAME },
          await this.store.oldestPendingAgeSeconds(),
        );
        // Counted across every tenant, which is why it does not go through the
        // scoped client: this is an operational gauge for the deployment, not
        // a figure any tenant sees.
        assignmentsActiveTotal.set({ service: SERVICE_NAME }, await this.countActiveAssignments());
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

  private async countActiveAssignments(): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM assignment WHERE ended_at IS NULL
    `;
    return Number(rows[0]?.count ?? 0n);
  }
}

function brokersOf(env: FleetEnv): string[] {
  return env.KAFKA_BROKERS.split(',').map((broker) => broker.trim());
}
