import {
  Inject,
  Module,
  type MiddlewareConsumer,
  type NestModule,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import {
  AuthGuard,
  AUTH_OPTIONS,
  EXCEPTION_FILTER_LOGGER,
  InternalTokenService,
  OutboxPurgeScheduler,
  OutboxRelay,
  OutboxShutdown,
  outboxPurgeSettings,
  RequestContextMiddleware,
  TokenVerifier,
  type AuthGuardOptions,
  kafkaConnection,
} from '@rasta/nest-common';
import { outboxShutdownBudgetMs } from '@rasta/config';
import { createLogger, setLogContextProvider, type Logger } from '@rasta/logging';
import { EventConsumer, toLogContext } from '@rasta/nest-common';
import {
  outboxAckFencedTotal,
  outboxClaimAttemptsTotal,
  outboxLeaseReclaimedTotal,
} from '@rasta/observability';
import { PrismaService } from './prisma/prisma.service';
import { PrismaOutboxStore } from './outbox/outbox.store';
import { KafkaEventPublisher } from './outbox/kafka.publisher';
import { KeycloakAdminClient } from './keycloak/keycloak.client';
import {
  KEYCLOAK_PROJECTOR_OPTIONS,
  KeycloakProjector,
  type KeycloakProjectorOptions,
} from './keycloak/keycloak.projector';
import { KeycloakProjectionConsumer } from './keycloak/keycloak-projection.consumer';
import { FENCE_POOL_CONNECTIONS, KeycloakWriteFences } from './keycloak/keycloak-write-fence';
import { IdentityRepository } from './identity/identity.repository';
import { IdentityService } from './identity/identity.service';
import { MembershipExpiryScanner } from './identity/membership-expiry.scanner';
import { KeycloakFenceSampler, pooledFenceSampleSource } from './keycloak/keycloak-fence-sampler';
import {
  MembershipController,
  RegistrationController,
  UserController,
} from './identity/identity.controller';
import { HealthController, MetricsController } from './health/health.controller';
import { AuditCorrectionController } from './audit-correction/audit-correction.controller';
import { AuditCorrectionService } from './audit-correction/audit-correction.service';
import { AuditCorrectionCommandRepository } from './audit-correction/audit-correction.repository';
import { AuditLookupClient } from './audit-correction/audit-lookup.client';
import { ROLE_GRANT_POLICY } from './identity/role-grants';
import { PROVISIONING_SCOPE_POLICY } from './identity/provisioning-scope';
import {
  IDENTITY_TOPIC,
  loadIdentityEnv,
  provisioningScopePolicy,
  roleGrantPolicy,
  SERVICE_NAME,
  type IdentityEnv,
} from './config/env';
import { SecurityEventOutboxStore } from './security-events/security-event-outbox.store';
import { RefusalAuditRecorder } from './security-events/refusal-audit.recorder';
import { RefusalAuditExceptionFilter } from './security-events/refusal-audit.filter';
import { withAuthGuardRefusalAudit } from './security-events/auth-guard-refusal';
import { IdentityRolesGuard } from './security-events/identity-roles.guard';
import {
  createSecurityEventRelay,
  SECURITY_EVENT_RELAY,
} from './security-events/security-event.relay';
import { OutboxGauges } from './observability/outbox-gauges';

export const ENV = Symbol('IDENTITY_ENV');
/** The Keycloak write fences' own pool (D-069): never the one business transactions hold. */
export const FENCE_PRISMA = Symbol('IDENTITY_FENCE_PRISMA');
/** The fence sampler's own pool of one (#402 r3 R3-2). */
export const SAMPLER_PRISMA = Symbol('IDENTITY_SAMPLER_PRISMA');
export const LOGGER = Symbol('IDENTITY_LOGGER');

@Module({
  controllers: [
    UserController,
    MembershipController,
    RegistrationController,
    AuditCorrectionController,
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
      // A second, small pool: a fence is inserted while the business
      // transaction holds the user lock, so it must never wait for a
      // connection of a pool that transactions queued on that lock can
      // exhaust (D-069, KeycloakWriteFences).
      provide: FENCE_PRISMA,
      inject: [ENV],
      useFactory: (env: IdentityEnv) =>
        new PrismaService(env.DATABASE_URL, { connections: FENCE_POOL_CONNECTIONS }),
    },
    {
      provide: KeycloakWriteFences,
      inject: [FENCE_PRISMA],
      useFactory: (pool: PrismaService) => new KeycloakWriteFences(pool),
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
        new KafkaEventPublisher(kafkaConnection(env, env.KAFKA_CLIENT_ID)),
    },

    {
      provide: ROLE_GRANT_POLICY,
      inject: [ENV],
      useFactory: (env: IdentityEnv) => roleGrantPolicy(env),
    },

    {
      provide: PROVISIONING_SCOPE_POLICY,
      inject: [ENV],
      useFactory: (env: IdentityEnv) => provisioningScopePolicy(env),
    },

    PrismaOutboxStore,
    IdentityRepository,
    {
      provide: KEYCLOAK_PROJECTOR_OPTIONS,
      inject: [ENV],
      useFactory: (env: IdentityEnv): KeycloakProjectorOptions => ({
        writeSettleSeconds: env.KEYCLOAK_WRITE_SETTLE_SECONDS,
      }),
    },
    KeycloakProjector,
    IdentityService,
    {
      provide: MembershipExpiryScanner,
      inject: [ENV, IdentityRepository, IdentityService, KeycloakProjector, KeycloakWriteFences],
      useFactory: (
        env: IdentityEnv,
        repository: IdentityRepository,
        identity: IdentityService,
        projector: KeycloakProjector,
        fences: KeycloakWriteFences,
      ) =>
        new MembershipExpiryScanner(
          repository,
          identity,
          {
            enabled: env.MEMBERSHIP_EXPIRY_SCAN_ENABLED,
            intervalSeconds: env.MEMBERSHIP_EXPIRY_SCAN_INTERVAL_SECONDS,
            batchSize: env.MEMBERSHIP_EXPIRY_SCAN_BATCH_SIZE,
          },
          projector,
          fences,
        ),
    },

    // The fence and lapse gauges, sampled on their own timers and their own
    // connection — never by the sweep's serial pass (#402 r3 R3-2). A pool of
    // one: it can starve neither the business pool nor the fence pool's two
    // connections every Keycloak write needs, and neither can starve it.
    // Closed, like every pool, by OutboxShutdown once the sampler stopped.
    {
      provide: SAMPLER_PRISMA,
      inject: [ENV],
      useFactory: (env: IdentityEnv) =>
        new PrismaService(env.DATABASE_URL, { connections: 1, waitSeconds: 1 }),
    },
    {
      provide: KeycloakFenceSampler,
      inject: [SAMPLER_PRISMA, IdentityRepository],
      useFactory: (own: PrismaService, repository: IdentityRepository) =>
        new KeycloakFenceSampler(pooledFenceSampleSource(own, repository)),
    },

    // The durable half of the Keycloak projection (ADR-060 § 5): re-projects
    // the user each membership or role event names, from this service's own
    // topic. Off with Keycloak sync, which is also what keeps test and offline
    // boots from reaching for a broker they do not have.
    {
      provide: KeycloakProjectionConsumer,
      inject: [ENV, LOGGER, KeycloakProjector],
      useFactory: (env: IdentityEnv, logger: Logger, projector: KeycloakProjector) =>
        new KeycloakProjectionConsumer(
          env.KEYCLOAK_SYNC_ENABLED
            ? (handler) =>
                new EventConsumer(
                  {
                    ...kafkaConnection(env, `${env.KAFKA_CLIENT_ID}-keycloak-projection`),
                    // Its own group: the outbox relay publishes this topic, and
                    // any other reader of it must not share partitions with
                    // this one (docs/07 § 7.10).
                    groupId: 'identity-service.keycloak-projection',
                    topics: [IDENTITY_TOPIC],
                    deadLetterTopic: `${IDENTITY_TOPIC}.dlq`,
                    // Not from the beginning: history is what the backfill
                    // command is for. This path only has to follow changes.
                    fromBeginning: false,
                  },
                  handler,
                  {
                    log: (m) => logger.info(m),
                    warn: (m) => logger.warn(m),
                    error: (m, trace) => logger.error({ err: trace }, m),
                  },
                )
            : null,
          projector,
        ),
    },

    // ------------------------------------------------------------------------
    // Audit correction command (ADR-053 § 7, AUD-003 correction). Writes only to this
    // service's standard outbox; reaches audit-service only through its narrow
    // internal lookup, with a service token minted for exactly that target.
    // ------------------------------------------------------------------------
    AuditCorrectionCommandRepository,
    AuditCorrectionService,
    {
      provide: AuditLookupClient,
      inject: [ENV],
      useFactory: (env: IdentityEnv) =>
        new AuditLookupClient({
          baseUrl: env.AUDIT_SERVICE_URL,
          timeoutMs: env.AUDIT_REQUEST_TIMEOUT_MS,
          tokens: new InternalTokenService(
            env.INTERNAL_TOKEN_SECRET,
            env.INTERNAL_TOKEN_ISSUER,
            env.INTERNAL_TOKEN_TTL_SECONDS,
          ),
        }),
    },

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
          leaseSeconds: env.OUTBOX_CLAIM_LEASE_SECONDS,
          backoff: {
            baseSeconds: env.OUTBOX_CLAIM_BACKOFF_SECONDS,
            maxSeconds: env.OUTBOX_CLAIM_BACKOFF_MAX_SECONDS,
          },
          shutdownGraceSeconds: env.OUTBOX_SHUTDOWN_GRACE_SECONDS,
          logger,
          // Counters only. Both outbox gauges are sampled from the database
          // below, never maintained by inc/dec — an arithmetic gauge drifts on
          // every restart and every missed error path (ADR-050).
          onFenced: (count) => outboxAckFencedTotal.inc({ service: SERVICE_NAME }, count),
          onReclaimed: (count) => outboxLeaseReclaimedTotal.inc({ service: SERVICE_NAME }, count),
          onClaimAttempt: (count) => outboxClaimAttemptsTotal.inc({ service: SERVICE_NAME }, count),
        }),
    },

    // ------------------------------------------------------------------------
    // Refusal audit (ADR-053 § 4, AUD-004 Phases C1–C2).
    //
    // A second queue and a second relay, beside the domain outbox above and
    // sharing nothing with it but the Kafka producer. The refusal filter counts
    // each refusal into `security_event_outbox` in its own bounded transaction
    // — one row per identity per aggregation window; the refusal relay
    // publishes a row once its window has closed. Neither Kafka nor
    // audit-service is on the request path: a refusal is decided and answered
    // whether or not either is reachable.
    // ------------------------------------------------------------------------
    SecurityEventOutboxStore,
    {
      provide: OutboxGauges,
      inject: [PrismaOutboxStore, SecurityEventOutboxStore],
      useFactory: (store: PrismaOutboxStore, securityStore: SecurityEventOutboxStore) =>
        new OutboxGauges(store, securityStore),
    },

    {
      provide: RefusalAuditRecorder,
      inject: [SecurityEventOutboxStore, ENV, LOGGER],
      useFactory: (store: SecurityEventOutboxStore, env: IdentityEnv, logger: Logger) =>
        new RefusalAuditRecorder({
          store,
          timeoutMs: env.SECURITY_EVENT_CAPTURE_TIMEOUT_MS,
          aggregationWindowSeconds: env.SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS,
          producerVersion: env.SERVICE_VERSION,
          logger,
        }),
    },

    {
      provide: SECURITY_EVENT_RELAY,
      inject: [SecurityEventOutboxStore, KafkaEventPublisher, ENV, LOGGER],
      useFactory: (
        store: SecurityEventOutboxStore,
        publisher: KafkaEventPublisher,
        env: IdentityEnv,
        logger: Logger,
      ): OutboxRelay =>
        createSecurityEventRelay({
          store,
          publisher,
          pollIntervalMs: env.SECURITY_EVENT_FLUSH_INTERVAL_MS,
          batchSize: env.SECURITY_EVENT_FLUSH_BATCH_SIZE,
          // Lease, backoff and shutdown grace are ADR-050's, shared with the
          // domain relay: one set of claim semantics, configured once.
          leaseSeconds: env.OUTBOX_CLAIM_LEASE_SECONDS,
          backoff: {
            baseSeconds: env.OUTBOX_CLAIM_BACKOFF_SECONDS,
            maxSeconds: env.OUTBOX_CLAIM_BACKOFF_MAX_SECONDS,
          },
          shutdownGraceSeconds: env.OUTBOX_SHUTDOWN_GRACE_SECONDS,
          logger,
        }),
    },

    {
      // D-052: published `outbox_message` rows past OUTBOX_PURGE_RETENTION_HOURS,
      // in bounded batches. `security_event_outbox` is a separate table and is
      // not purged.
      provide: OutboxPurgeScheduler,
      inject: [PrismaOutboxStore, ENV, LOGGER],
      useFactory: (store: PrismaOutboxStore, env: IdentityEnv, logger: Logger) =>
        new OutboxPurgeScheduler({
          store,
          service: SERVICE_NAME,
          logger,
          ...outboxPurgeSettings(env),
        }),
    },
    {
      // D-052: both relays, the purge, the expiry scanner, the Keycloak
      // projection consumer, the projector's recovery projections (D-070 D,
      // #458 r1 F2: a request's recovery has no other owner), the fence
      // sampler and the outbox gauges stop together in the destroy phase, by
      // one deadline inside SHUTDOWN_TIMEOUT_MS. Before, the relays stopped in
      // `onApplicationShutdown`, after the consumer's unbounded stop, while the
      // scanner went on writing outbox rows.
      //
      // The one owner of the whole teardown, the pools included (#458 r2 F2):
      // every pool closes here, last, once everything that uses it has
      // returned — no pool has a destroy hook of its own, which Nest would run
      // beside this one.
      provide: OutboxShutdown,
      inject: [
        OutboxRelay,
        OutboxPurgeScheduler,
        SECURITY_EVENT_RELAY,
        MembershipExpiryScanner,
        KeycloakProjectionConsumer,
        KeycloakProjector,
        KeycloakFenceSampler,
        OutboxGauges,
        KafkaEventPublisher,
        PrismaService,
        FENCE_PRISMA,
        SAMPLER_PRISMA,
        ENV,
      ],
      useFactory: (
        relay: OutboxRelay,
        purge: OutboxPurgeScheduler,
        securityRelay: OutboxRelay,
        scanner: MembershipExpiryScanner,
        projection: KeycloakProjectionConsumer,
        projector: KeycloakProjector,
        sampler: KeycloakFenceSampler,
        gauges: OutboxGauges,
        publisher: KafkaEventPublisher,
        prisma: PrismaService,
        fencePool: PrismaService,
        samplerPool: PrismaService,
        env: IdentityEnv,
      ) =>
        new OutboxShutdown({
          relay,
          purge,
          workers: [securityRelay, scanner, projection, projector, sampler, gauges],
          // Closed once the drain has returned, by the same deadline (D-052 phase 4b).
          publishers: [publisher],
          // Last of all, by the same deadline: each waits for its transactions
          // still in flight, then refuses everything and disconnects.
          databases: [prisma, fencePool, samplerPool],
          budgetMs: outboxShutdownBudgetMs(env),
        }),
    },

    {
      provide: AUTH_OPTIONS,
      inject: [ENV],
      // The platform options, plus refusal-audit observation of the guard's
      // own tenant refusal (AUD-004 Phase C10). The guard is the platform's,
      // unchanged, and remains the only authentication and tenant resolver;
      // the observer only marks the refusal it has already decided.
      useFactory: (env: IdentityEnv): AuthGuardOptions =>
        withAuthGuardRefusalAudit({
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
    // The role guard is the platform `RolesGuard` behind a thin identity
    // adaptor that marks allowlisted role refusals for audit (AUD-004 Phase
    // C3); every authorization decision is still the shared guard's.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: IdentityRolesGuard },
    // The platform exception filter, wrapped: every response is the platform's,
    // and allowlisted refusals are additionally captured for audit.
    { provide: APP_FILTER, useClass: RefusalAuditExceptionFilter },
  ],
})
export class AppModule implements NestModule, OnModuleInit, OnApplicationShutdown {
  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: OutboxRelay,
    @Inject(SECURITY_EVENT_RELAY) private readonly securityRelay: OutboxRelay,
    private readonly purge: OutboxPurgeScheduler,
    private readonly gauges: OutboxGauges,
    private readonly outboxShutdown: OutboxShutdown,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    // Middleware, not an interceptor: it must wrap guards too, so the auth
    // guard has a context to record the resolved tenant into.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  async onModuleInit(): Promise<void> {
    // First of all (D-045): nothing is served, relayed or consumed as a role
    // that could lift this service's database guards.
    await this.prisma.assertRuntimeRole();

    this.relay.start();
    this.securityRelay.start();
    this.purge.start();
    this.gauges.start();
  }

  async onApplicationShutdown(): Promise<void> {
    // Everything — both relays, the purge, the scanner, the projection
    // consumer, the recoveries, the sampler, the outbox gauges, then the
    // publisher and the pools — already stopped in OutboxShutdown's
    // onModuleDestroy, by one deadline; this joins that stop and returns at once.
    await this.outboxShutdown.stop();
  }
}
