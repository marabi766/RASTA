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
import { OrganizationRepository } from './organization/organization.repository';
import { OrganizationService } from './organization/organization.service';
import { OrganizationController } from './organization/organization.controller';
import { HealthController, MetricsController } from './health/health.controller';
import { loadOrganizationEnv, SERVICE_NAME, type OrganizationEnv } from './config/env';

export const ENV = Symbol('ORGANIZATION_ENV');
export const LOGGER = Symbol('ORGANIZATION_LOGGER');

@Module({
  controllers: [OrganizationController, HealthController, MetricsController],
  providers: [
    { provide: ENV, useFactory: () => loadOrganizationEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: OrganizationEnv): Logger => {
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
      useFactory: (env: OrganizationEnv) => new PrismaService(env.DATABASE_URL),
    },

    {
      provide: KafkaEventPublisher,
      inject: [ENV],
      useFactory: (env: OrganizationEnv) =>
        new KafkaEventPublisher({
          brokers: env.KAFKA_BROKERS.split(',').map((b) => b.trim()),
          clientId: env.KAFKA_CLIENT_ID,
        }),
    },

    PrismaOutboxStore,
    OrganizationRepository,

    {
      provide: OrganizationService,
      inject: [OrganizationRepository, ENV],
      useFactory: (repository: OrganizationRepository, env: OrganizationEnv) =>
        new OrganizationService(repository, env.MAX_HIERARCHY_DEPTH),
    },

    {
      provide: OutboxRelay,
      inject: [PrismaOutboxStore, KafkaEventPublisher, ENV, LOGGER],
      useFactory: (
        store: PrismaOutboxStore,
        publisher: KafkaEventPublisher,
        env: OrganizationEnv,
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
      useFactory: (env: OrganizationEnv): AuthGuardOptions => ({
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
