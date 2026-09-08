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
import { loadNotificationEnv, SERVICE_NAME, type NotificationEnv } from './config/env';

/**
 * notification-service wiring — bootstrap only.
 *
 * ## What is absent, and why absence is the correct state
 *
 * ADR-054 specifies intents, recipient resolution, preferences, templates,
 * in-app delivery and an email channel behind a provider abstraction. None of
 * it is here: no Prisma client, no dispatcher consumer group, no outbox relay,
 * no template renderer, no provider port. The ADR is `Proposed` and NTF-001 has
 * not started.
 *
 * A provider port would be the tempting exception, and it is refused for the
 * reason ADR-054 § 6 gives: Q-37 has not chosen a production email provider or
 * a sender identity, so a port with one implementation to choose between is
 * scaffolding shaped like a decision. **No email has ever been sent from this
 * platform**, and nothing here changes that.
 *
 * ## No outbox, yet
 *
 * This service will own one (ADR-054), and it does not today. It is therefore
 * absent from `scripts/verify-outbox-claim-migration.mjs`, whose discovery
 * guard `assertEveryOutboxServiceIsAccountedFor()` skips a service with no
 * `prisma/schema.prisma` and refuses the run the moment an unregistered
 * `model OutboxMessage` appears. Registering it now would fail immediately on a
 * migration that does not exist; leaving it unregistered is safe precisely
 * because that guard will catch the omission on its own.
 *
 * ## No AuthGuard is registered, and that is not a hole
 *
 * The only two routes are the health probes, which are `@Public` in every
 * service on the platform, so a global guard would have nothing to protect
 * while `authEnvSchema` demanded a JWKS endpoint this process never calls. The
 * guard lands with the first non-public endpoint, in NTF-002.
 */
@Module({
  controllers: [HealthController],
  providers: [
    { provide: ENV, useFactory: (): NotificationEnv => loadNotificationEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: NotificationEnv): Logger => {
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
