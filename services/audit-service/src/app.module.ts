import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import {
  AllExceptionsFilter,
  EventConsumer,
  EXCEPTION_FILTER_LOGGER,
  RequestContextMiddleware,
  toLogContext,
} from '@rasta/nest-common';
import { createLogger, setLogContextProvider, type Logger } from '@rasta/logging';
import { HealthController } from './health/health.controller';
import { PrismaService } from './prisma/prisma.service';
import { AuditRepository } from './audit/audit.repository';
import { DomainProjectorConsumer } from './consumers/domain-projector.consumer';
import { DOMAIN_PROJECTOR_CONSUMER, DOMAIN_TOPICS } from './audit/audit.mapper';
import { auditPartitionRows } from './observability/metrics';
import { ENV, LOGGER } from './tokens';
import { brokersOf, loadAuditEnv, SERVICE_NAME, type AuditEnv } from './config/env';

/**
 * audit-service wiring — AUD-001, the domain projector.
 *
 * ## What is here
 *
 * One consumer group over the ten produced domain topics, a repository that
 * writes the audit row and its idempotency marker in a single transaction, and
 * the ingestion metrics. That is the whole of path A (ADR-053 § 1).
 *
 * ## What is deliberately still absent
 *
 *   query API      AUD-002. No endpoint returns an audit row, which is also why
 *                  no `AuthGuard` is registered: the only routes are the two
 *                  `@Public` health probes, so a global guard would protect
 *                  nothing while `authEnvSchema` demanded a JWKS endpoint this
 *                  process never calls.
 *   hash chain     AUD-003. `record_hash` and `previous_hash` exist as columns
 *                  and are never written. A null there means "no chain yet".
 *   trail consumer AUD-004. `rasta.audit.trail.v1` is path B. Consuming it here
 *                  would have this service auditing its own writes.
 *   outbox         Never. audit-service is a terminal sink (ADR § 14), which is
 *                  why it owns no `OutboxMessage` model and the discovery guard
 *                  in `verify-outbox-claim-migration.mjs` correctly ignores it.
 *
 * ## `allowAutoTopicCreation: false`, and why a missing topic must be fatal
 *
 * If the broker silently created a missing topic, this service would subscribe
 * to an empty one and report perfect health while recording nothing. Startup
 * failing loudly is the only outcome that cannot be mistaken for working.
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

    {
      provide: PrismaService,
      inject: [ENV],
      useFactory: (env: AuditEnv): PrismaService => new PrismaService(env.DATABASE_URL),
    },

    AuditRepository,

    {
      provide: DomainProjectorConsumer,
      inject: [ENV, LOGGER, AuditRepository],
      useFactory: (
        env: AuditEnv,
        logger: Logger,
        repository: AuditRepository,
      ): DomainProjectorConsumer =>
        new DomainProjectorConsumer(
          (handler) =>
            new EventConsumer(
              {
                brokers: brokersOf(env),
                clientId: env.KAFKA_CLIENT_ID,
                groupId: DOMAIN_PROJECTOR_CONSUMER,
                topics: [...DOMAIN_TOPICS],
                // The audit store must be able to reconstruct from the start of
                // whatever the broker still holds. Safe because every write is
                // idempotent on `(eventId, consumerName)`.
                //
                // It is not a backup: domain topics retain seven days
                // (`create-topics.sh`), so replay recovers a week, not years.
                // The database and its backups are the durable record
                // (ADR § 8).
                fromBeginning: true,
                // `allowAutoTopicCreation: false` is not passed here because
                // the platform `EventConsumer` already hard-codes it
                // (`event-consumer.ts`). Restating it as an option would imply
                // a caller could turn it back on. Subscribing to a topic that
                // does not exist therefore fails at startup, which is the only
                // outcome that cannot be mistaken for working: an
                // auto-created empty topic would leave this service reporting
                // perfect health while recording nothing.
              },
              handler,
              {
                log: (message: string) => logger.info(message),
                warn: (message: string) => logger.warn(message),
                error: (message: string) => logger.error(message),
              },
            ),
          repository,
          logger,
        ),
    },

    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule, OnModuleInit, OnApplicationShutdown {
  private gaugeTimer?: NodeJS.Timeout;

  constructor(
    private readonly projector: DomainProjectorConsumer,
    private readonly repository: AuditRepository,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  async onModuleInit(): Promise<void> {
    await this.projector.start();

    // Sampled from the catalogue, never maintained by inc/dec: an arithmetic
    // gauge drifts on every restart, and a drifting capacity number is worse
    // than no capacity number.
    const sample = async (): Promise<void> => {
      try {
        for (const { partition, rows } of await this.repository.partitionRowCounts()) {
          auditPartitionRows.set({ partition }, rows);
        }
      } catch {
        // Upkeep must never take the service down; ingestion failures have
        // their own counter and the relay's logging covers a persistent fault.
      }
    };

    void sample();
    this.gaugeTimer = setInterval(() => void sample(), 60_000);
    this.gaugeTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
  }
}
