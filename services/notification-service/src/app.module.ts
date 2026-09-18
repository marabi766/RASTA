import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { hostname } from 'node:os';
import {
  AllExceptionsFilter,
  EventConsumer,
  EXCEPTION_FILTER_LOGGER,
  InternalTokenService,
  RequestContextMiddleware,
  toLogContext,
} from '@rasta/nest-common';
import { createLogger, setLogContextProvider, type Logger } from '@rasta/logging';
import { HealthController } from './health/health.controller';
import { PrismaService } from './prisma/prisma.service';
import { NotificationRepository } from './notification/notification.repository';
import { DispatcherConsumer } from './intake/dispatcher.consumer';
import { ResolutionWorker } from './resolution/resolution.worker';
import { IdentityHttpRecipientAdapter } from './recipients/identity-http.adapter';
import { CachedRecipientPort } from './recipients/cached-recipient.port';
import { RECIPIENT_PORT, type RecipientPort } from './recipients/recipient.port';
import { SUBSCRIBED_TOPICS } from './rules/rules';
import { withAddressScrubbing, type ScrubbedLogger } from './logging/scrub';
import { ENV, LOGGER, SCRUBBED_LOGGER } from './tokens';
import {
  brokersOf,
  DISPATCHER_CONSUMER_GROUP,
  loadNotificationEnv,
  NOTIFICATION_DLQ_TOPIC,
  SERVICE_NAME,
  type NotificationEnv,
} from './config/env';

/**
 * notification-service wiring — NTF-001, the in-app half of ADR-054.
 *
 * ## What is here
 *
 * One consumer group over the two source topics that carry the three
 * supported events, a repository whose two transactions are the whole
 * idempotency story, a resolution worker that calls identity-service on its
 * own clock, and the intake/dedupe metrics.
 *
 * ## No `AuthGuard` is registered, and that is still not a hole
 *
 * The only routes are the two health probes, `@Public` in every service on the
 * platform. The first non-public endpoint arrives with the read API in
 * NTF-002, and the global guard lands with it. `InternalTokenService` is
 * registered for the **outbound** direction only: it mints the `SERVICE` token
 * identity-service verifies.
 *
 * ## No outbox, still
 *
 * NTF-004 publishes `NOTIFICATION_SENT` / `NOTIFICATION_FAILED` from a standard
 * outbox. Nothing here publishes, so the schema declares no `OutboxMessage`
 * and the discovery guard in `verify-outbox-claim-migration.mjs` correctly
 * ignores this service.
 *
 * ## `allowAutoTopicCreation: false`, and why a missing topic must be fatal
 *
 * The platform `EventConsumer` hard-codes it. Subscribing to a topic that does
 * not exist therefore fails at startup, which is the only outcome that cannot
 * be mistaken for working.
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

    // Every message this service composes passes through the address scrubber
    // (ADR-054 § 10, R-5) before it reaches pino.
    {
      provide: SCRUBBED_LOGGER,
      inject: [LOGGER],
      useFactory: (logger: Logger): ScrubbedLogger =>
        withAddressScrubbing({
          info: (message) => logger.info(message),
          warn: (message) => logger.warn(message),
          error: (message) => logger.error(message),
          debug: (message) => logger.debug(message),
        }),
    },

    {
      provide: PrismaService,
      inject: [ENV],
      useFactory: (env: NotificationEnv): PrismaService => new PrismaService(env.DATABASE_URL),
    },

    NotificationRepository,

    {
      provide: InternalTokenService,
      inject: [ENV],
      useFactory: (env: NotificationEnv): InternalTokenService =>
        new InternalTokenService(
          env.INTERNAL_TOKEN_SECRET,
          env.INTERNAL_TOKEN_ISSUER,
          env.INTERNAL_TOKEN_TTL_SECONDS,
        ),
    },

    {
      provide: RECIPIENT_PORT,
      inject: [ENV, InternalTokenService],
      useFactory: (env: NotificationEnv, tokens: InternalTokenService): RecipientPort =>
        new CachedRecipientPort(
          new IdentityHttpRecipientAdapter(
            {
              baseUrl: env.IDENTITY_SERVICE_URL,
              timeoutMs: env.NOTIFICATION_IDENTITY_REQUEST_TIMEOUT_MS,
            },
            tokens,
          ),
          env.NOTIFICATION_RECIPIENT_CACHE_TTL_SECONDS * 1000,
        ),
    },

    {
      provide: DispatcherConsumer,
      inject: [ENV, SCRUBBED_LOGGER, NotificationRepository],
      useFactory: (
        env: NotificationEnv,
        logger: ScrubbedLogger,
        repository: NotificationRepository,
      ): DispatcherConsumer =>
        new DispatcherConsumer(
          (handler) =>
            new EventConsumer(
              {
                brokers: brokersOf(env),
                clientId: env.KAFKA_CLIENT_ID,
                groupId: env.KAFKA_CONSUMER_GROUP ?? DISPATCHER_CONSUMER_GROUP,
                topics: [...SUBSCRIBED_TOPICS],
                // A first deployment must not replay seven days of warnings
                // into people's inboxes. Nothing durable is lost: an active
                // expiry condition is re-published by the next sweep (ADR § 8).
                fromBeginning: false,
                deadLetterTopic: NOTIFICATION_DLQ_TOPIC,
              },
              handler,
              {
                log: (message) => logger.info(message),
                warn: (message) => logger.warn(message),
                error: (message) => logger.error(message),
              },
            ),
          repository,
          env.NOTIFICATION_DEDUPE_RETENTION_DAYS,
          logger,
        ),
    },

    {
      provide: ResolutionWorker,
      inject: [ENV, SCRUBBED_LOGGER, NotificationRepository, RECIPIENT_PORT],
      useFactory: (
        env: NotificationEnv,
        logger: ScrubbedLogger,
        repository: NotificationRepository,
        recipients: RecipientPort,
      ): ResolutionWorker =>
        new ResolutionWorker(
          repository,
          recipients,
          {
            pollIntervalMs: env.NOTIFICATION_RESOLUTION_POLL_INTERVAL_MS,
            batchSize: env.NOTIFICATION_RESOLUTION_BATCH_SIZE,
            leaseSeconds: env.NOTIFICATION_RESOLUTION_LEASE_SECONDS,
            backoffMaxSeconds: env.NOTIFICATION_RESOLUTION_BACKOFF_MAX_SECONDS,
            maxRecipients: env.NOTIFICATION_MAX_RECIPIENTS_PER_INTENT,
            inAppTtlDays: env.NOTIFICATION_IN_APP_TTL_DAYS,
            owner: `${SERVICE_NAME}@${hostname()}#${process.pid}`,
          },
          logger,
        ),
    },

    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule, OnModuleInit {
  constructor(
    private readonly dispatcher: DispatcherConsumer,
    private readonly worker: ResolutionWorker,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  async onModuleInit(): Promise<void> {
    await this.dispatcher.start();
    this.worker.start();
  }
}
