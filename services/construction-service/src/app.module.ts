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
  toLogContext,
  type AuthGuardOptions,
  kafkaConnection,
} from '@rasta/nest-common';
import { createLogger, setLogContextProvider, type Logger } from '@rasta/logging';
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
import { EventPublisher } from './events/publisher';
import { ProjectRepository } from './project/project.repository';
import { ProjectService } from './project/project.service';
import { NeedService } from './project/need.service';
import { ProjectController } from './project/project.controller';
import { ProjectAccess } from './access/access';
import { ProjectLifecycleController } from './project/lifecycle.controller';
import { ExecutionService } from './project/execution.service';
import { ApprovalRepository } from './approval/approval.repository';
import { ApprovalService } from './approval/approval.service';
import { PolicyService } from './approval/policy.service';
import { PolicySuspensionService } from './approval/policy-suspension.service';
import { PolicyReconciliationRepository } from './approval/policy-reconciliation.repository';
import { PolicyReconciliationSweeper } from './approval/policy-reconciliation.sweeper';
import {
  OrganizationMovedConsumer,
  organizationMovesConsumerFactory,
} from './events/organization-moved.consumer';
import {
  SupplierStandingConsumer,
  supplierStandingConsumerFactory,
} from './events/supplier-standing.consumer';
import { ContractorStandingRepository } from './tender/contractor-standing.repository';
import { StandingBootstrap } from './tender/standing-bootstrap';
import { StandingAuthority } from './tender/standing-authority';
import { SupplierSnapshotClient } from './tender/supplier-snapshot.client';
import { OrganizationDirectory } from './organization/organization-directory';
import { PolicyController } from './approval/policy.controller';
import { ApprovalController } from './approval/approval.controller';
import { ProgressService } from './progress/progress.service';
import { TenderRepository } from './tender/tender.repository';
import { TenderService } from './tender/tender.service';
import { TenderController } from './tender/tender.controller';
import { CriteriaRepository } from './tender/criteria.repository';
import { CriteriaService } from './tender/criteria.service';
import { CriteriaController } from './tender/criteria.controller';
import { PublicationRepository } from './tender/publication.repository';
import { PublicationService } from './tender/publication.service';
import { PublicationController } from './tender/publication.controller';
import { EnvKekProvider } from './tender/sealing/key-provider';
import { IdempotencyStore } from './shared/idempotency';
import { HealthController, MetricsController } from './health/health.controller';
import {
  policyReconciliationBacklog,
  policyReconciliationOldestDueAgeSeconds,
} from './observability/metrics';
import {
  ENV,
  LOGGER,
  STANDING_OF_SOURCE,
  STANDING_SNAPSHOT_SOURCE,
  TENDER_KEY_PROVIDER,
} from './tokens';
import { loadConstructionEnv, SERVICE_NAME, type ConstructionEnv } from './config/env';

/**
 * construction-service wiring (CON-001).
 *
 * ## One consumer, no workflow — by decision
 *
 * `docs/04` § 4.12 lists supplier, fleet and document as dependencies and
 * Temporal for tender deadlines. None is wired here: CON-001 PR 1 needs none of
 * them, and a port with no implementation to choose between is scaffolding that
 * looks like work. Temporal arrives with CON-002's deadlines (ADR-063).
 *
 * The consumed events (`SUPPLIER_QUALIFIED`, `CONTRACT_SIGNED`, `ASSET_*`,
 * `AVAILABILITY_CHANGED`) all feed CON-002 or the fleet analysis. A handler
 * that consumed them and did nothing would write a `processed_event` row that
 * looks like work done (ADR-032).
 *
 * The one consumer is `ORGANIZATION_MOVED` (Q-83): an approval policy a union
 * wrote must stop governing an organization that left the union's subtree. It
 * writes no `processed_event` row either, by design — see
 * `OrganizationMovedConsumer`.
 */
@Module({
  controllers: [
    ProjectController,
    ProjectLifecycleController,
    PolicyController,
    ApprovalController,
    TenderController,
    CriteriaController,
    PublicationController,
    HealthController,
    MetricsController,
  ],
  providers: [
    { provide: ENV, useFactory: () => loadConstructionEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: ConstructionEnv): Logger => {
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
    { provide: EXCEPTION_FILTER_LOGGER, inject: [LOGGER], useFactory: (l: Logger) => l },

    {
      provide: PrismaService,
      inject: [ENV],
      useFactory: (env: ConstructionEnv) => new PrismaService(env.DATABASE_URL),
    },

    {
      provide: KafkaEventPublisher,
      inject: [ENV],
      useFactory: (env: ConstructionEnv) =>
        new KafkaEventPublisher(kafkaConnection(env, env.KAFKA_CLIENT_ID)),
    },

    PrismaOutboxStore,
    EventPublisher,
    ProjectAccess,
    IdempotencyStore,
    ProjectRepository,
    TenderRepository,
    ProjectService,
    TenderService,
    CriteriaRepository,
    CriteriaService,
    PublicationRepository,
    PublicationService,
    {
      // ADR-066 § 2. A malformed or half-set configuration stops the boot; an
      // absent one leaves a provider that publishes nothing (fail closed).
      provide: TENDER_KEY_PROVIDER,
      inject: [ENV],
      useFactory: (env: ConstructionEnv) =>
        new EnvKekProvider(env.CONSTRUCTION_TENDER_KEKS, env.CONSTRUCTION_TENDER_KEK_CURRENT),
    },
    NeedService,
    ApprovalRepository,
    ApprovalService,
    PolicyService,
    OrganizationDirectory,
    PolicyReconciliationRepository,
    PolicySuspensionService,
    {
      provide: PolicyReconciliationSweeper,
      inject: [PolicyReconciliationRepository, PolicySuspensionService, OrganizationDirectory, ENV],
      useFactory: (
        repository: PolicyReconciliationRepository,
        suspension: PolicySuspensionService,
        directory: OrganizationDirectory,
        env: ConstructionEnv,
      ) =>
        new PolicyReconciliationSweeper(repository, suspension, directory, {
          intervalMs: env.CONSTRUCTION_RECONCILE_INTERVAL_MS,
          batchSize: env.CONSTRUCTION_RECONCILE_BATCH_SIZE,
          leaseSeconds: env.CONSTRUCTION_RECONCILE_LEASE_SECONDS,
          backoffSeconds: env.CONSTRUCTION_RECONCILE_BACKOFF_SECONDS,
          backoffMaxSeconds: env.CONSTRUCTION_RECONCILE_BACKOFF_MAX_SECONDS,
        }),
    },
    ExecutionService,
    ProgressService,

    {
      provide: OrganizationMovedConsumer,
      inject: [ENV, LOGGER, PolicySuspensionService],
      useFactory: (env: ConstructionEnv, logger: Logger, suspension: PolicySuspensionService) =>
        new OrganizationMovedConsumer(
          organizationMovesConsumerFactory(
            kafkaConnection(env, `${env.KAFKA_CLIENT_ID}-organization-moves`),
            logger,
          ),
          suspension,
          logger,
        ),
    },

    ContractorStandingRepository,
    // ADR-061 § 4: the standing before the consumer group existed is read from
    // supplier-service, and nobody is eligible until it has been (StandingBootstrap).
    SupplierSnapshotClient,
    { provide: STANDING_SNAPSHOT_SOURCE, useExisting: SupplierSnapshotClient },
    // Eligibility to bid is decided from supplier-service's own record at the moment
    // of the bid; the read model above is advisory (StandingAuthority).
    { provide: STANDING_OF_SOURCE, useExisting: SupplierSnapshotClient },
    StandingAuthority,
    StandingBootstrap,
    {
      provide: SupplierStandingConsumer,
      inject: [ENV, LOGGER, ContractorStandingRepository],
      useFactory: (env: ConstructionEnv, logger: Logger, standing: ContractorStandingRepository) =>
        new SupplierStandingConsumer(
          supplierStandingConsumerFactory(
            kafkaConnection(env, `${env.KAFKA_CLIENT_ID}-supplier-standing`),
            logger,
          ),
          standing,
          logger,
        ),
    },

    {
      provide: InternalTokenService,
      inject: [ENV],
      useFactory: (env: ConstructionEnv) =>
        new InternalTokenService(
          env.INTERNAL_TOKEN_SECRET,
          env.INTERNAL_TOKEN_ISSUER,
          env.INTERNAL_TOKEN_TTL_SECONDS,
        ),
    },

    {
      provide: OutboxRelay,
      inject: [PrismaOutboxStore, KafkaEventPublisher, ENV, LOGGER],
      useFactory: (
        store: PrismaOutboxStore,
        publisher: KafkaEventPublisher,
        env: ConstructionEnv,
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

    {
      provide: AUTH_OPTIONS,
      inject: [ENV, InternalTokenService],
      useFactory: (
        env: ConstructionEnv,
        internalTokens: InternalTokenService,
      ): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
        tokenVerifier: new TokenVerifier({
          jwksUri: env.OIDC_JWKS_URI,
          issuer: env.OIDC_ISSUER_URL,
          audience: env.OIDC_AUDIENCE,
        }),
        internalTokens,
      }),
    },

    // Authenticate, then authorize. Registered globally so an endpoint is
    // closed unless it opts out with @Public (AGENTS.md A-12, S-02).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule, OnModuleInit, OnApplicationShutdown {
  private gaugeTimer?: NodeJS.Timeout;

  constructor(
    private readonly relay: OutboxRelay,
    private readonly moves: OrganizationMovedConsumer,
    private readonly standing: SupplierStandingConsumer,
    private readonly bootstrap: StandingBootstrap,
    private readonly sweeper: PolicyReconciliationSweeper,
    private readonly reconciliations: PolicyReconciliationRepository,
    private readonly store: PrismaOutboxStore,
    private readonly idempotency: IdempotencyStore,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    // Middleware rather than an interceptor: it must wrap the guards too, so
    // the auth guard has a context to record the resolved tenant into, and so
    // every mutation below it can read the correlation id it stamps on rows.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  async onModuleInit(): Promise<void> {
    // The consumer first: a topic it cannot subscribe to must stop the boot
    // (`EventConsumer` never auto-creates topics), not leave a service that
    // looks healthy and never hears a move.
    await this.moves.start();
    await this.standing.start();
    // After the consumer, never before: every event from here on is received live,
    // and every fact before it is in the snapshot read next. Not awaited — the
    // service serves while it loads, answering "not loaded" (fail closed) until done.
    this.bootstrap.start();
    this.sweeper.start();
    this.relay.start();

    const sample = async () => {
      try {
        outboxPendingTotal.set({ service: SERVICE_NAME }, await this.store.pendingCount());
        outboxLeasesActive.set({ service: SERVICE_NAME }, await this.store.activeLeaseCount());
        outboxPendingAgeSeconds.set(
          { service: SERVICE_NAME },
          await this.store.oldestPendingAgeSeconds(),
        );
        // The queue behind ORGANIZATION_MOVED, from the database (docs/23
        // D-041): alert when the oldest due task keeps ageing.
        const backlog = await this.reconciliations.backlog();
        policyReconciliationBacklog.set({ service: SERVICE_NAME }, backlog.open);
        policyReconciliationOldestDueAgeSeconds.set(
          { service: SERVICE_NAME },
          backlog.oldestDueAgeSeconds,
        );
        // Expired idempotency records are unusable by definition; removing
        // them keeps the table bounded (docs/06 § 6.8).
        await this.idempotency.purgeExpired();
      } catch {
        // Upkeep must never take the service down. The relay's own logging
        // covers a persistent database problem.
      }
    };

    void sample();
    this.gaugeTimer = setInterval(() => void sample(), 30_000);
    this.gaugeTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
    await this.moves.stop();
    await this.standing.stop();
    await this.bootstrap.stop();
    await this.sweeper.stop();
    await this.relay.stop();
  }
}
