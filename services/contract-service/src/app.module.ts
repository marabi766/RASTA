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
import {
  TenderAwardedConsumer,
  tenderAwardedConsumerFactory,
} from './events/tender-awarded.consumer';
import {
  OrganizationMovedConsumer,
  organizationMovesConsumerFactory,
} from './events/organization-moved.consumer';
import { PolicyReconciliationRepository } from './policy/policy-reconciliation.repository';
import { PolicyReconciliationSweeper } from './policy/policy-reconciliation.sweeper';
import { PolicySuspensionService } from './policy/policy-suspension.service';
import {
  policyReconciliationBacklog,
  policyReconciliationOldestDueAgeSeconds,
} from './observability/metrics';
import { AwardSourceClient } from './award/award-source.client';
import { ContractAccess } from './access/access';
import { ContractRepository } from './contract/contract.repository';
import { ContractService } from './contract/contract.service';
import { ContractController } from './contract/contract.controller';
import { AmendmentController } from './amendment/amendment.controller';
import { AmendmentRepository } from './amendment/amendment.repository';
import { AmendmentService } from './amendment/amendment.service';
import { MilestoneController } from './milestone/milestone.controller';
import { MilestoneRepository } from './milestone/milestone.repository';
import { MilestoneService } from './milestone/milestone.service';
import { AuthorityRefusals } from './signing/authority-refusals';
import { SigningAuthority } from './signing/signing-authority';
import { PolicyAccess } from './policy/policy.access';
import { PolicyController } from './policy/policy.controller';
import { PolicyRepository } from './policy/policy.repository';
import { PolicyService } from './policy/policy.service';
import { OrganizationDirectory } from './organization/organization-directory';
import { IdempotencyStore } from './shared/idempotency';
import { HealthController, MetricsController } from './health/health.controller';
import { AWARD_SOURCE, ENV, LOGGER } from './tokens';
import { loadContractEnv, SERVICE_NAME, type ContractEnv } from './config/env';

/**
 * contract-service wiring (CON-003 PR 1, ADR-068).
 *
 * ## Two consumers, one sweeper, no workflow — by decision
 *
 * The contract boundary starts with a draft the system makes from an awarded tender: a consumer
 * (`TENDER_AWARDED`, which reads the award from construction-service before it writes anything)
 * and a read API for the two parties. No Temporal (nothing here has a deadline; silence is never
 * consent, ADR-043). Since PR 2 a second consumer (`ORGANIZATION_MOVED`, a trigger that queues a
 * re-check — Q-83) and the sweeper that works that queue suspend a signing policy whose union has
 * lost the employer; nothing a user calls writes through either. Statements, their separate
 * technical and financial approvals and the settlement boundary with economic-service are later
 * changes (ADR-068 § 9) and bring their own wiring.
 */
@Module({
  controllers: [
    ContractController,
    AmendmentController,
    MilestoneController,
    PolicyController,
    HealthController,
    MetricsController,
  ],
  providers: [
    { provide: ENV, useFactory: () => loadContractEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: ContractEnv): Logger => {
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
      useFactory: (env: ContractEnv) => new PrismaService(env.DATABASE_URL),
    },

    {
      provide: KafkaEventPublisher,
      inject: [ENV],
      useFactory: (env: ContractEnv) =>
        new KafkaEventPublisher(kafkaConnection(env, env.KAFKA_CLIENT_ID)),
    },

    PrismaOutboxStore,
    EventPublisher,
    ContractAccess,
    ContractRepository,
    SigningAuthority,
    AuthorityRefusals,
    ContractService,
    AmendmentRepository,
    AmendmentService,
    MilestoneRepository,
    MilestoneService,
    PolicyAccess,
    PolicyRepository,
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
        env: ContractEnv,
      ) =>
        new PolicyReconciliationSweeper(repository, suspension, directory, {
          intervalMs: env.CONTRACT_RECONCILE_INTERVAL_MS,
          batchSize: env.CONTRACT_RECONCILE_BATCH_SIZE,
          leaseSeconds: env.CONTRACT_RECONCILE_LEASE_SECONDS,
          backoffSeconds: env.CONTRACT_RECONCILE_BACKOFF_SECONDS,
          backoffMaxSeconds: env.CONTRACT_RECONCILE_BACKOFF_MAX_SECONDS,
        }),
    },

    {
      provide: OrganizationMovedConsumer,
      inject: [ENV, LOGGER, PolicySuspensionService],
      useFactory: (env: ContractEnv, logger: Logger, suspension: PolicySuspensionService) =>
        new OrganizationMovedConsumer(
          organizationMovesConsumerFactory(
            kafkaConnection(env, `${env.KAFKA_CLIENT_ID}-organization-moves`),
            logger,
          ),
          suspension,
          logger,
        ),
    },

    // Idempotent commands (docs/06 § 6.8): this service's own store for `sign` and `cancel`.
    {
      provide: IdempotencyStore,
      inject: [PrismaService, ENV],
      useFactory: (prisma: PrismaService, env: ContractEnv) => new IdempotencyStore(prisma, env),
    },

    {
      provide: InternalTokenService,
      inject: [ENV],
      useFactory: (env: ContractEnv) =>
        new InternalTokenService(
          env.INTERNAL_TOKEN_SECRET,
          env.INTERNAL_TOKEN_ISSUER,
          env.INTERNAL_TOKEN_TTL_SECONDS,
        ),
    },

    // ADR-061 § 4: the amount of a contract — on no event — and the award it comes from are
    // read from construction-service, authenticated and signed for the tender owner's
    // organization, and a contract is made from that answer only.
    {
      provide: AWARD_SOURCE,
      inject: [ENV, InternalTokenService],
      useFactory: (env: ContractEnv, tokens: InternalTokenService) =>
        new AwardSourceClient({
          baseUrl: env.CONSTRUCTION_SERVICE_URL,
          timeoutMs: env.CONTRACT_AWARD_REQUEST_TIMEOUT_MS,
          tokens,
        }),
    },

    {
      provide: TenderAwardedConsumer,
      inject: [ENV, LOGGER, PrismaService, ContractRepository, EventPublisher, AWARD_SOURCE],
      useFactory: (
        env: ContractEnv,
        logger: Logger,
        prisma: PrismaService,
        contracts: ContractRepository,
        publisher: EventPublisher,
        awards: AwardSourceClient,
      ) =>
        new TenderAwardedConsumer(
          tenderAwardedConsumerFactory(
            kafkaConnection(env, `${env.KAFKA_CLIENT_ID}-tender-awarded`),
            logger,
            {
              maxRetries: env.CONTRACT_CONSUMER_MAX_RETRIES,
              retryBackoffMs: env.CONTRACT_CONSUMER_RETRY_BACKOFF_MS,
            },
          ),
          prisma,
          contracts,
          publisher,
          awards,
          logger,
        ),
    },

    {
      provide: OutboxRelay,
      inject: [PrismaOutboxStore, KafkaEventPublisher, ENV, LOGGER],
      useFactory: (
        store: PrismaOutboxStore,
        publisher: KafkaEventPublisher,
        env: ContractEnv,
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
          // Counters only. Both outbox gauges are sampled from the database below, never
          // maintained by inc/dec — an arithmetic gauge drifts on every restart and every
          // missed error path (ADR-050).
          onFenced: (count) => outboxAckFencedTotal.inc({ service: SERVICE_NAME }, count),
          onReclaimed: (count) => outboxLeaseReclaimedTotal.inc({ service: SERVICE_NAME }, count),
          onClaimAttempt: (count) => outboxClaimAttemptsTotal.inc({ service: SERVICE_NAME }, count),
        }),
    },

    {
      provide: AUTH_OPTIONS,
      inject: [ENV, InternalTokenService],
      useFactory: (env: ContractEnv, internalTokens: InternalTokenService): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
        tokenVerifier: new TokenVerifier({
          jwksUri: env.OIDC_JWKS_URI,
          issuer: env.OIDC_ISSUER_URL,
          audience: env.OIDC_AUDIENCE,
        }),
        internalTokens,
      }),
    },

    // Authenticate, then authorize. Registered globally so an endpoint is closed unless it
    // opts out with @Public (AGENTS.md A-12, S-02).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule, OnModuleInit, OnApplicationShutdown {
  private gaugeTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: OutboxRelay,
    private readonly awarded: TenderAwardedConsumer,
    private readonly moves: OrganizationMovedConsumer,
    private readonly sweeper: PolicyReconciliationSweeper,
    private readonly reconciliations: PolicyReconciliationRepository,
    private readonly store: PrismaOutboxStore,
    private readonly idempotency: IdempotencyStore,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    // Middleware rather than an interceptor: it must wrap the guards too, so the auth guard
    // has a context to record the resolved tenant into, and so every mutation below it can
    // read the correlation id it stamps on rows.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  async onModuleInit(): Promise<void> {
    // First of all (D-045): nothing is served, relayed or consumed as a role that could lift
    // this service's database guards.
    await this.prisma.assertRuntimeRole();

    // The consumer first: a topic it cannot subscribe to must stop the boot (`EventConsumer`
    // never auto-creates topics), not leave a service that looks healthy and never hears an award.
    await this.awarded.start();
    await this.moves.start();
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
        // The queue behind ORGANIZATION_MOVED, from the database (docs/23 D-041): alert when the
        // oldest due task keeps ageing.
        const backlog = await this.reconciliations.backlog();
        policyReconciliationBacklog.set({ service: SERVICE_NAME }, backlog.open);
        policyReconciliationOldestDueAgeSeconds.set(
          { service: SERVICE_NAME },
          backlog.oldestDueAgeSeconds,
        );
      } catch {
        // Upkeep must never take the service down. The relay's own logging covers a
        // persistent database problem.
      }
      try {
        // Expired Idempotency-Key records, removed by age alone: unscoped by necessity, safe
        // because they are already unusable.
        await this.idempotency.purgeExpired();
      } catch {
        // Upkeep must never take the service down either.
      }
    };

    void sample();
    this.gaugeTimer = setInterval(() => void sample(), 30_000);
    this.gaugeTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
    await this.awarded.stop();
    await this.moves.stop();
    await this.sweeper.stop();
    await this.relay.stop();
  }
}
