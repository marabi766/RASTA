import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AUDIT_TRAIL_TOPIC } from '@rasta/contracts';
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
import { AuditTrailConsumer } from './consumers/audit-trail.consumer';
import {
  AUDIT_DEAD_LETTER_TOPIC,
  DOMAIN_PROJECTOR_CONSUMER,
  DOMAIN_TOPICS,
} from './audit/audit.mapper';
import { AUDIT_TRAIL_CONSUMER } from './audit/audit-trail.mapper';
import { auditPartitionRows } from './observability/metrics';
import { ENV, LOGGER } from './tokens';
import { brokersOf, loadAuditEnv, SERVICE_NAME, type AuditEnv } from './config/env';

/** The logger the shared `EventConsumer` writes to, over the service logger. */
function consumerLogger(logger: Logger): ConstructorParameters<typeof EventConsumer>[2] {
  return {
    log: (message: string) => logger.info(message),
    warn: (message: string) => logger.warn(message),
    error: (message: string) => logger.error(message),
  };
}

/**
 * audit-service wiring — both input paths of ADR-053 § 1 and the read API.
 *
 * ## What is here
 *
 * Two consumer groups, each with its own name, topic set and idempotency
 * namespace:
 *
 *   path A  `audit-service.domain-projector` over the ten produced domain
 *           topics (AUD-001). Total: every envelope becomes a row.
 *   path B  `audit-service.trail` over `rasta.audit.trail.v1` (AUD-004 Phase
 *           B). Validating: an `AUDIT_EVENT_RECORDED` v1 message whose envelope,
 *           payload or tenant agreement fails is refused, never repaired.
 *
 * Both write through one repository that stores the audit row, its chain link,
 * its idempotency marker — and, for path A only, the organization hierarchy
 * projection — in a single transaction. Beside them: the ingestion metrics and
 * three authenticated read endpoints behind the platform's global guards, one
 * of which recomputes the chain (AUD-003, ADR-053 § 6).
 *
 * ## Both group names are constants, never `KAFKA_CONSUMER_GROUP`
 *
 * The platform's Kafka environment carries one `KAFKA_CONSUMER_GROUP`, and this
 * service runs two groups. Reading that variable into either factory would let
 * one deployment setting rename a group whose name is also its `processed_event`
 * key — and a renamed path-B group would silently share, or restart, the other
 * path's idempotency namespace. Each factory therefore names its group
 * explicitly, and `app.module.spec.ts` proves the variable changes neither.
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
 *                  a promise. The trail consumer does not change this: it is a
 *                  second Kafka reader, not a door.
 *   producers      One, for one refusal. `identity-service` publishes
 *                  `AUDIT_EVENT_RECORDED` for a refused active-organization
 *                  switch through its own `security_event_outbox` (AUD-004 Phase
 *                  C1). Windowed refusal aggregation, every other refusal and
 *                  every other service's producer are not built.
 *   correction     A correction a producer publishes is recorded — as a fresh
 *     command      row whose `correction_of` names the record it corrects, never
 *                  as an edit. Nothing accepts a correction *command*: that
 *                  belongs to the producer side (ADR-053 § 7), and this service
 *                  producing and consuming its own correction would be the
 *                  direct write § 7 exists to forbid.
 *   export         Asynchronous, `SYSTEM_ADMIN`-only and audited in its own
 *                  right (ADR-053 § 10); belongs with the work that builds it.
 *   outbox         Never. audit-service is a terminal sink (ADR § 14), which is
 *                  why it owns no `OutboxMessage` model and the discovery guard
 *                  in `verify-outbox-claim-migration.mjs` correctly ignores it.
 *
 * ## `allowAutoTopicCreation: false`, and why a missing topic must be fatal
 *
 * If the broker silently created a missing topic, this service would subscribe
 * to an empty one and report perfect health while recording nothing. Startup
 * failing loudly is the only outcome that cannot be mistaken for working — and
 * that holds for the trail topic as much as for the ten domain topics.
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
                // A constant, never `env.KAFKA_CONSUMER_GROUP` — see the header.
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
                deadLetterTopic: AUDIT_DEAD_LETTER_TOPIC,
                // `allowAutoTopicCreation: false` is not passed here because
                // the platform `EventConsumer` already hard-codes it
                // (`event-consumer.ts`). Restating it as an option would imply
                // a caller could turn it back on.
              },
              handler,
              consumerLogger(logger),
            ),
          repository,
          logger,
        ),
    },

    {
      provide: AuditTrailConsumer,
      inject: [ENV, LOGGER, AuditRepository],
      useFactory: (
        env: AuditEnv,
        logger: Logger,
        repository: AuditRepository,
      ): AuditTrailConsumer =>
        new AuditTrailConsumer(
          (handler) =>
            new EventConsumer(
              {
                brokers: brokersOf(env),
                clientId: env.KAFKA_CLIENT_ID,
                // Fixed, for the reason in the header: this name is also the
                // path-B `processed_event` key.
                groupId: AUDIT_TRAIL_CONSUMER,
                // The trail topic alone. Never merged into `DOMAIN_TOPICS`, and
                // no domain topic is added here.
                topics: [AUDIT_TRAIL_TOPIC],
                // Replay-safe for the same reason as path A. The trail topic is
                // retained for thirty days locally and never expires in a real
                // deployment (`create-topics.sh`).
                fromBeginning: true,
                // A refused trail message is kept, not dropped: its original
                // bytes are what a fixed producer's operator replays.
                deadLetterTopic: AUDIT_DEAD_LETTER_TOPIC,
              },
              handler,
              consumerLogger(logger),
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
    private readonly trail: AuditTrailConsumer,
    private readonly repository: AuditRepository,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  async onModuleInit(): Promise<void> {
    // Both paths, and a failure to start either one fails startup. A service
    // that came up with one path silently absent would pass every check that
    // looked only at the other. Each consumer stops itself on shutdown through
    // its own `onModuleDestroy`, which Nest calls for every provider.
    await this.projector.start();
    await this.trail.start();

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
