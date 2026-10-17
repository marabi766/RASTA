import {
  Inject,
  Module,
  type MiddlewareConsumer,
  type NestModule,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import {
  AllExceptionsFilter,
  AuthGuard,
  AUTH_OPTIONS,
  EXCEPTION_FILTER_LOGGER,
  InternalTokenService,
  RequestContextMiddleware,
  RolesGuard,
  TokenVerifier,
  toLogContext,
  type AuthGuardOptions,
  kafkaConnection,
} from '@rasta/nest-common';
import { createLogger, setLogContextProvider, type Logger } from '@rasta/logging';
import { PrismaService } from './prisma/prisma.service';
import { DashboardAccess } from './access/access';
import { MaintenanceFactRepository } from './maintenance/maintenance-fact.repository';
import {
  MaintenanceFactsConsumer,
  maintenanceFactsConsumerFactory,
} from './maintenance/maintenance-facts.consumer';
import { DashboardService } from './maintenance/dashboard.service';
import { DashboardController } from './maintenance/dashboard.controller';
import { HealthController, MetricsController } from './health/health.controller';
import { ENV, LOGGER } from './tokens';
import { loadAnalyticsEnv, SERVICE_NAME, type AnalyticsEnv } from './config/env';

/**
 * analytics-service wiring (RUN-001 PR 1, ADR-071).
 *
 * ## A consumer and a read API — no outbox, no write route
 *
 * One projection (`analytics-service.maintenance-facts`: `MAINTENANCE_COMPLETED` →
 * `fact_maintenance`) and one tenant dashboard that reads it. This service publishes no domain
 * event (`docs/04` § 4.15: "only a consumer"), so it owns no `outbox_message`, runs no relay and
 * has nothing to drain on shutdown; the only topic it writes is its own dead-letter topic. No
 * route writes: there is no `POST` anywhere, and a caller who tries one gets the router's `404`.
 *
 * ## The projection starts only where the broker authenticates who publishes
 *
 * `ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED` is off by default and refused at startup over an
 * unauthenticated connection (`config/env.ts`). Off, the dashboards answer from the facts held and
 * the readiness probe says `disabled`.
 *
 * ## The guards are global
 *
 * `AuthGuard` then `RolesGuard`: an endpoint is closed unless it opts out with `@Public`
 * (AGENTS.md A-12, S-02), which only the probes and the metrics scrape target do.
 */
@Module({
  controllers: [DashboardController, HealthController, MetricsController],
  providers: [
    { provide: ENV, useFactory: (): AnalyticsEnv => loadAnalyticsEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: AnalyticsEnv): Logger => {
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
    { provide: EXCEPTION_FILTER_LOGGER, inject: [LOGGER], useFactory: (l: Logger): Logger => l },

    {
      provide: PrismaService,
      inject: [ENV],
      useFactory: (env: AnalyticsEnv): PrismaService => new PrismaService(env.DATABASE_URL),
    },

    DashboardAccess,
    MaintenanceFactRepository,
    DashboardService,

    {
      provide: MaintenanceFactsConsumer,
      inject: [ENV, LOGGER, PrismaService, MaintenanceFactRepository],
      useFactory: (
        env: AnalyticsEnv,
        logger: Logger,
        prisma: PrismaService,
        facts: MaintenanceFactRepository,
      ): MaintenanceFactsConsumer =>
        new MaintenanceFactsConsumer(
          maintenanceFactsConsumerFactory(
            kafkaConnection(env, `${env.KAFKA_CLIENT_ID}-maintenance-facts`),
            logger,
          ),
          prisma,
          facts,
          logger,
        ),
    },

    {
      provide: InternalTokenService,
      inject: [ENV],
      useFactory: (env: AnalyticsEnv): InternalTokenService =>
        new InternalTokenService(
          env.INTERNAL_TOKEN_SECRET,
          env.INTERNAL_TOKEN_ISSUER,
          env.INTERNAL_TOKEN_TTL_SECONDS,
        ),
    },

    {
      provide: AUTH_OPTIONS,
      inject: [ENV, InternalTokenService],
      useFactory: (env: AnalyticsEnv, internalTokens: InternalTokenService): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
        tokenVerifier: new TokenVerifier({
          jwksUri: env.OIDC_JWKS_URI,
          issuer: env.OIDC_ISSUER_URL,
          audience: env.OIDC_AUDIENCE,
        }),
        // Verifiable, and deliberately never sufficient: no route here carries `@AllowService`,
        // so a valid internal token authenticates a caller who is then refused by
        // `assertNotServiceCaller()` — nothing reads analytics programmatically in MVP.
        internalTokens,
      }),
    },

    // Authenticate, then authorize. Global, so an endpoint is closed unless it opts out with
    // `@Public` (AGENTS.md A-12, S-02).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule, OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: MaintenanceFactsConsumer,
    @Inject(ENV) private readonly env: AnalyticsEnv,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    // Middleware rather than an interceptor: it must wrap the guards too, so the auth guard has
    // a context to record the resolved tenant into.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  async onModuleInit(): Promise<void> {
    // First of all (D-045): nothing is served or consumed as a role that could lift this
    // service's append-only guards.
    await this.prisma.assertRuntimeRole();

    // A topic it cannot subscribe to stops the boot (`EventConsumer` never auto-creates
    // topics), rather than leaving a service that looks healthy and never hears an event.
    if (this.env.ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED) await this.projection.start();
  }

  async onModuleDestroy(): Promise<void> {
    // In the destroy phase, before Prisma disconnects: an event in flight is abandoned
    // uncommitted and delivered again, and its marker keeps a second effect out.
    await this.projection.stop();
  }
}
