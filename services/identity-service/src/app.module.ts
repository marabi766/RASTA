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
  OutboxRelay,
  RequestContextMiddleware,
  TokenVerifier,
  type AuthGuardOptions,
} from '@rasta/nest-common';
import { createLogger, setLogContextProvider, type Logger } from '@rasta/logging';
import { toLogContext } from '@rasta/nest-common';
import {
  outboxAckFencedTotal,
  outboxClaimAttemptsTotal,
  outboxLeaseReclaimedTotal,
  outboxLeasesActive,
  outboxPendingAgeSeconds,
  outboxPendingTotal,
} from '@rasta/observability';
import { PrismaService } from './prisma/prisma.service';
import { PrismaOutboxStore } from './outbox/outbox.store';
import { KafkaEventPublisher } from './outbox/kafka.publisher';
import { KeycloakAdminClient } from './keycloak/keycloak.client';
import { KeycloakProjector } from './keycloak/keycloak.projector';
import { IdentityRepository } from './identity/identity.repository';
import { IdentityService } from './identity/identity.service';
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
import {
  securityEventOutboxClosedBacklogAgeSeconds,
  securityEventOutboxClosedBacklogTotal,
  securityEventOutboxLeasesActive,
  securityEventOutboxOpenWindows,
  securityEventOutboxPendingAgeSeconds,
  securityEventOutboxPendingTotal,
} from './observability/security-event.metrics';

export const ENV = Symbol('IDENTITY_ENV');
export const LOGGER = Symbol('IDENTITY_LOGGER');

/** How often both outbox gauges are sampled from the database. */
const OUTBOX_GAUGE_INTERVAL_MS = 15_000;

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
    KeycloakProjector,
    IdentityService,

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
    private readonly relay: OutboxRelay,
    private readonly store: PrismaOutboxStore,
    @Inject(SECURITY_EVENT_RELAY) private readonly securityRelay: OutboxRelay,
    private readonly securityStore: SecurityEventOutboxStore,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    // Middleware, not an interceptor: it must wrap guards too, so the auth
    // guard has a context to record the resolved tenant into.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  onModuleInit(): void {
    this.relay.start();
    this.securityRelay.start();
    this.startOutboxGauges();
  }

  async onApplicationShutdown(): Promise<void> {
    // Let an in-flight batch finish so it is not republished on restart. Both
    // relays settle what they own; neither waits beyond its shutdown grace.
    await Promise.all([this.relay.stop(), this.securityRelay.stop()]);
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
  }

  private gaugeTimer?: NodeJS.Timeout;

  /**
   * Feeds the stuck-relay and audit-gap alerts. Age matters more than count: a
   * large backlog draining quickly is fine, while three rows stuck for ten
   * minutes is not.
   */
  private startOutboxGauges(): void {
    const sample = async () => {
      try {
        outboxPendingTotal.set({ service: SERVICE_NAME }, await this.store.pendingCount());
        outboxLeasesActive.set({ service: SERVICE_NAME }, await this.store.activeLeaseCount());
        outboxPendingAgeSeconds.set(
          { service: SERVICE_NAME },
          await this.store.oldestPendingAgeSeconds(),
        );
      } catch {
        // Metrics must never take the service down.
      }
      // Sampled separately, so a failure on one queue never blanks the other's.
      try {
        securityEventOutboxPendingTotal.set(await this.securityStore.pendingCount());
        securityEventOutboxLeasesActive.set(await this.securityStore.activeLeaseCount());
        securityEventOutboxPendingAgeSeconds.set(
          await this.securityStore.oldestPendingAgeSeconds(),
        );
        // Phase C2: an open window is expected to wait; a closed one is not.
        const backlog = await this.securityStore.aggregationBacklog();
        securityEventOutboxOpenWindows.set(backlog.openWindows);
        securityEventOutboxClosedBacklogTotal.set(backlog.closedBacklog);
        securityEventOutboxClosedBacklogAgeSeconds.set(backlog.closedBacklogAgeSeconds);
      } catch {
        // Metrics must never take the service down.
      }
    };

    this.gaugeTimer = setInterval(() => void sample(), OUTBOX_GAUGE_INTERVAL_MS);
    this.gaugeTimer.unref?.();
  }
}
