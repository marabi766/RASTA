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
  type AuthGuardOptions,
} from '@rasta/nest-common';
import { createLogger, setLogContextProvider, type Logger } from '@rasta/logging';
import { toLogContext } from '@rasta/nest-common';
import { outboxPendingAgeSeconds, outboxPendingTotal } from '@rasta/observability';
import { PrismaService } from './prisma/prisma.service';
import { PrismaOutboxStore } from './outbox/outbox.store';
import { KafkaEventPublisher } from './outbox/kafka.publisher';
import { KeycloakAdminClient } from './keycloak/keycloak.client';
import { IdentityRepository } from './identity/identity.repository';
import { IdentityService } from './identity/identity.service';
import {
  MembershipController,
  RegistrationController,
  UserController,
} from './identity/identity.controller';
import { HealthController, MetricsController } from './health/health.controller';
import { loadIdentityEnv, SERVICE_NAME, type IdentityEnv } from './config/env';

export const ENV = Symbol('IDENTITY_ENV');
export const LOGGER = Symbol('IDENTITY_LOGGER');

@Module({
  controllers: [
    UserController,
    MembershipController,
    RegistrationController,
    HealthController,
    MetricsController,
  ],
  providers: [
    { provide: ENV, useFactory: () => loadIdentityEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: IdentityEnv): Logger => {
        const logger = createLogger({
          serviceName: SERVICE_NAME,
          serviceVersion: env.SERVICE_VERSION,
          environment: env.NODE_ENV,
          level: env.LOG_LEVEL,
          pretty: env.NODE_ENV === 'development',
        });
        // Wires request context into every log line without logging having to
        // know anything about Nest.
        setLogContextProvider(() => toLogContext());
        return logger;
      },
    },
    { provide: EXCEPTION_FILTER_LOGGER, inject: [LOGGER], useFactory: (l: Logger) => l },

    {
      provide: PrismaService,
      inject: [ENV],
      useFactory: (env: IdentityEnv) => new PrismaService(env.DATABASE_URL),
    },

    {
      provide: KeycloakAdminClient,
      inject: [ENV],
      useFactory: (env: IdentityEnv) =>
        new KeycloakAdminClient({
          baseUrl: env.KEYCLOAK_URL,
          realm: env.KEYCLOAK_REALM,
          clientId: env.KEYCLOAK_BACKEND_CLIENT_ID,
          clientSecret: env.KEYCLOAK_BACKEND_CLIENT_SECRET,
          enabled: env.KEYCLOAK_SYNC_ENABLED,
        }),
    },

    {
      provide: KafkaEventPublisher,
      inject: [ENV],
      useFactory: (env: IdentityEnv) =>
        new KafkaEventPublisher({
          brokers: env.KAFKA_BROKERS.split(',').map((b) => b.trim()),
          clientId: env.KAFKA_CLIENT_ID,
        }),
    },

    PrismaOutboxStore,
    IdentityRepository,
    IdentityService,

    {
      provide: OutboxRelay,
      inject: [PrismaOutboxStore, KafkaEventPublisher, ENV, LOGGER],
      useFactory: (
        store: PrismaOutboxStore,
        publisher: KafkaEventPublisher,
        env: IdentityEnv,
        logger: Logger,
      ) =>
        new OutboxRelay({
          store,
          publisher,
          pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
          batchSize: env.OUTBOX_BATCH_SIZE,
          logger,
          onBatchPublished: (count) => {
            outboxPendingTotal.dec({ service: SERVICE_NAME }, count);
          },
        }),
    },

    {
      provide: AUTH_OPTIONS,
      inject: [ENV],
      useFactory: (env: IdentityEnv): AuthGuardOptions => ({
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

    // Order matters: authenticate, then authorize. Registered globally so an
    // endpoint is closed unless it opts out with @Public (AGENTS.md A-12).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule, OnModuleInit, OnApplicationShutdown {
  constructor(
    private readonly relay: OutboxRelay,
    private readonly store: PrismaOutboxStore,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    // Middleware, not an interceptor: it must wrap guards too, so the auth
    // guard has a context to record the resolved tenant into.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  onModuleInit(): void {
    this.relay.start();
    this.startOutboxGauges();
  }

  async onApplicationShutdown(): Promise<void> {
    // Let an in-flight batch finish so it is not republished on restart.
    await this.relay.stop();
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
  }

  private gaugeTimer?: NodeJS.Timeout;

  /**
   * Feeds the stuck-relay alert. Age matters more than count: a large backlog
   * draining quickly is fine, while three rows stuck for ten minutes is not.
   */
  private startOutboxGauges(): void {
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
}
