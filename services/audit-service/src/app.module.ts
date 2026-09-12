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
  RequestContextMiddleware,
  RolesGuard,
  TokenVerifier,
  toLogContext,
  type AuthGuardOptions,
} from '@rasta/nest-common';
import { createLogger, setLogContextProvider, type Logger } from '@rasta/logging';
import { HealthController } from './health/health.controller';
import { PrismaService } from './prisma/prisma.service';
import { AuditRepository } from './audit/audit.repository';
import { AuditController } from './audit/audit.controller';
import { AuditQueryService } from './audit/audit.query.service';
import { AuditVerificationService } from './audit/audit.verification.service';
import {
  AuditEventDetailQueryPipe,
  AuditEventQueryPipe,
  AuditVerifyQueryPipe,
} from './audit/audit.query.pipes';
import { DomainProjectorConsumer } from './consumers/domain-projector.consumer';
import { DOMAIN_PROJECTOR_CONSUMER, DOMAIN_TOPICS } from './audit/audit.mapper';
import { auditPartitionRows } from './observability/metrics';
import { ENV, LOGGER } from './tokens';
import { brokersOf, loadAuditEnv, SERVICE_NAME, type AuditEnv } from './config/env';

/**
 * audit-service wiring — the domain projector (AUD-001) and the read API
 * (AUD-002).
 *
 * ## What is here
 *
 * One consumer group over the ten produced domain topics, a repository that
 * writes the audit row, its chain link, its idempotency marker and the
 * organization hierarchy projection in a single transaction, the ingestion
 * metrics — that is path A (ADR-053 § 1) — and three authenticated read
 * endpoints behind the platform's global guards, one of which recomputes the
 * chain (AUD-003, ADR-053 § 6).
 *
 * ## The guards are global, and the health probes are the only exception
 *
 * `AuthGuard` then `RolesGuard`, in that order: authenticate, then authorize.
 * Registered globally so an endpoint is closed unless it says otherwise
 * (AGENTS.md S-02), which is why the two probes carry `@Public` with a stated
 * reason and nothing else does.
 *
 * ## What is deliberately still absent
 *
 *   write API      Never. `docs/04` § 4.15: writing is from Kafka only. There
 *                  is no `POST /v1/audit-events` and a caller that tries one
 *                  gets a router `404`, which is a structural proof rather than
 *                  a promise.
 *   export         AUD-002 stops at search and read. Export is asynchronous,
 *                  `SYSTEM_ADMIN`-only and audited in its own right
 *                  (ADR-053 § 10), and belongs with the work that builds it.
 *   correction     AUD-004, not AUD-003. ADR-053 § 7 routes a correction
 *                  through path B, and path B is the trail consumer below. With
 *                  no producer, no outbox and no write API, the only way to
 *                  record one today would be the direct insert § 7 forbids, so
 *                  `correction_of` stays an inert column and no route exists.
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
  controllers: [HealthController, AuditController],
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
    AuditQueryService,
    AuditVerificationService,

    // Registered as classes, not as factory providers, because the controller
    // reaches them as `@Query(AuditEventQueryPipe)`. Nest resolves a
    // class-referenced enhancer from the metatype it scanned off the route and
    // never consults a same-token `useFactory`, so a factory here would be
    // silently ignored and the container would try to construct the class with
    // an unresolvable parameter. Each pipe injects `ENV` instead and reads
    // `AUDIT_MAX_QUERY_WINDOW_DAYS` itself, so the 400 for an over-wide window
    // still names the ceiling this deployment runs (`audit.query.pipes.ts`).
    AuditEventQueryPipe,
    AuditEventDetailQueryPipe,
    AuditVerifyQueryPipe,

    {
      provide: InternalTokenService,
      inject: [ENV],
      useFactory: (env: AuditEnv): InternalTokenService =>
        new InternalTokenService(
          env.INTERNAL_TOKEN_SECRET,
          env.INTERNAL_TOKEN_ISSUER,
          env.INTERNAL_TOKEN_TTL_SECONDS,
        ),
    },

    {
      provide: AUTH_OPTIONS,
      inject: [ENV, InternalTokenService],
      useFactory: (env: AuditEnv, internalTokens: InternalTokenService): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
        tokenVerifier: new TokenVerifier({
          jwksUri: env.OIDC_JWKS_URI,
          issuer: env.OIDC_ISSUER_URL,
          audience: env.OIDC_AUDIENCE,
        }),
        // Verifiable, and deliberately never sufficient. No route here carries
        // `@AllowService`, so a valid internal token authenticates a caller who
        // is then refused by `RolesGuard` and again by `assertNotServiceCaller()`
        // — ADR-053 § 10: nothing in MVP reads audit programmatically.
        internalTokens,
      }),
    },

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
                // Without this the shared consumer logs a malformed message
                // and drops it — an audit service losing the one message it
                // could not parse, which is the message most worth keeping.
                //
                // One DLQ for all ten source topics, and it is audit's own
                // rather than each producer's: a message that failed *this*
                // service's validation is this service's problem to replay,
                // and routing it back to `rasta.asset.v1.dlq` would put it in
                // front of a team that has nothing to fix. The original topic
                // rides along in the `x-dlq-topic` header.
                deadLetterTopic: 'rasta.audit.v1.dlq',
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

    // Authenticate, then authorize. Global, so an endpoint is closed unless it
    // opts out with `@Public` (AGENTS.md A-12, S-02).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
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
