import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import {
  AllExceptionsFilter,
  EXCEPTION_FILTER_LOGGER,
  RequestContextMiddleware,
  toLogContext,
} from '@rasta/nest-common';
import { createLogger, setLogContextProvider, type Logger } from '@rasta/logging';
import { HealthController } from './health/health.controller';
import { ENV, LOGGER } from './tokens';
import { loadAuditEnv, SERVICE_NAME, type AuditEnv } from './config/env';

/**
 * audit-service wiring — bootstrap only.
 *
 * ## What is absent, and why absence is the correct state
 *
 * ADR-053 specifies an append-only evidence store fed by a consumer on every
 * domain topic. None of it is here: no Prisma client, no consumer, no
 * repository, no query API. The ADR is `Proposed` and AUD-001 has not started,
 * so a port, a stub or an empty handler would be scaffolding that reads as
 * work — and a registered consumer that wrote a `processed_event` row while
 * computing nothing is precisely the failure ADR-032 refuses.
 *
 * ## No AuthGuard is registered, and that is not a hole
 *
 * Every other service binds `AuthGuard` and `RolesGuard` globally so an
 * endpoint is closed unless it opts out with `@Public` (AGENTS.md S-02). Here
 * the only two routes are the health probes, which are `@Public` in every
 * service on the platform — so a global guard would have nothing to protect,
 * while `authEnvSchema` would demand a JWKS endpoint this process never calls.
 *
 * The guard belongs with the first non-public endpoint, which is AUD-002's
 * query API. Registering it there is a change to this file; registering it now
 * would mean shipping auth configuration that verifies no token.
 *
 * ## Audit does not own an outbox
 *
 * Deliberate, and specified (ADR-053 § 4): this service is a terminal sink. It
 * is therefore never registered in `scripts/verify-outbox-claim-migration.mjs`,
 * whose discovery guard correctly ignores a service with no `OutboxMessage`
 * model.
 */
@Module({
  controllers: [HealthController],
  providers: [
    { provide: ENV, useFactory: (): AuditEnv => loadAuditEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: AuditEnv): Logger => {
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

    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Stamps the correlation id every structured log line carries. Applied even
    // though only health routes exist, so the first real endpoint inherits a
    // context that is already there rather than discovering it is missing.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
