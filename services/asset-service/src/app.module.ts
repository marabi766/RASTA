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
  OutboxPurgeScheduler,
  OutboxShutdown,
  OutboxRelay,
  outboxPurgeSettings,
  RequestContextMiddleware,
  RolesGuard,
  TokenVerifier,
  toLogContext,
  type AuthGuardOptions,
  kafkaConnection,
} from '@rasta/nest-common';
import { outboxShutdownBudgetMs } from '@rasta/config';
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
import { AssetRepository } from './asset/asset.repository';
import {
  DOCUMENT_LOOKUP,
  DocumentLookupClient,
  type DocumentLookup,
} from './asset/document-lookup';
import { IdempotencyStore } from './asset/idempotency';
import { AssetService } from './asset/asset.service';
import { TRANSFER_INSURANCE_POLICY, type TransferInsurancePolicy } from './insurance/ownership';
import {
  FLEET_SERVICE,
  MAINTENANCE_SERVICE,
  TRANSFER_CLEARANCE,
  TransferClearanceClient,
  type TransferClearance,
} from './asset/transfer-clearance';
import { AssetController } from './asset/asset.controller';
import { AssetInternalController, TransferRecordService } from './asset/transfer-record';
import { AssetSnapshotService } from './asset/asset-snapshot';
import { InsurancePolicyStandingService } from './insurance/policy-standing';
import { InsuranceService } from './insurance/insurance.service';
import { InsuranceExpirySweepScheduler } from './insurance/expiry-sweep.scheduler';
import { ClaimService } from './insurance/claim.service';
import { TimelineConsumer } from './consumers/timeline.consumer';
import { AssetWorkStateClient } from './consumers/work-state';
import { HealthController, MetricsController } from './health/health.controller';
import { loadAssetEnv, SERVICE_NAME, type AssetEnv } from './config/env';

export const ENV = Symbol('ASSET_ENV');
export const LOGGER = Symbol('ASSET_LOGGER');

/**
 * Topics the dossier is built from.
 *
 * Listed here rather than derived, because subscribing to a topic is a
 * deployment fact — it decides consumer-group membership and lag — and should
 * be visible in one place when someone asks what this service listens to.
 *
 * The topics exist from day one even though several producers do not; an empty
 * topic costs nothing, and the alternative is editing this list on every
 * service launch.
 */
/** A minting `InternalTokenService`, from the secret the guard verifies with. */
const internalTokens = (env: AssetEnv): InternalTokenService =>
  new InternalTokenService(
    env.INTERNAL_TOKEN_SECRET,
    env.INTERNAL_TOKEN_ISSUER,
    env.INTERNAL_TOKEN_TTL_SECONDS,
  );

const CONSUMED_TOPICS = [
  'rasta.fleet.v1',
  'rasta.maintenance.v1',
  'rasta.marketplace.v1',
  'rasta.construction.v1',
];

@Module({
  controllers: [AssetController, AssetInternalController, HealthController, MetricsController],
  providers: [
    { provide: ENV, useFactory: () => loadAssetEnv() },

    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: AssetEnv): Logger => {
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
      useFactory: (env: AssetEnv) => new PrismaService(env.DATABASE_URL),
    },

    {
      provide: KafkaEventPublisher,
      inject: [ENV],
      useFactory: (env: AssetEnv) =>
        new KafkaEventPublisher(kafkaConnection(env, env.KAFKA_CLIENT_ID)),
    },

    PrismaOutboxStore,
    AssetRepository,
    // docs/24 Q-66: which coverages follow the vehicle across a transfer.
    {
      provide: TRANSFER_INSURANCE_POLICY,
      inject: [ENV],
      useFactory: (env: AssetEnv): TransferInsurancePolicy => ({
        coveragesFollowingVehicle: env.INSURANCE_COVERAGES_FOLLOWING_VEHICLE,
      }),
    },
    // ADR-062: the owners of a machine's open work, asked before a transfer.
    // Its own `InternalTokenService`, from the same secret the guard verifies
    // with: minting and verifying are separate roles.
    {
      provide: TRANSFER_CLEARANCE,
      inject: [ENV],
      useFactory: (env: AssetEnv): TransferClearance =>
        new TransferClearanceClient({
          baseUrls: {
            [FLEET_SERVICE]: env.FLEET_SERVICE_URL,
            [MAINTENANCE_SERVICE]: env.MAINTENANCE_SERVICE_URL,
          },
          timeoutMs: env.ASSET_TRANSFER_CLEARANCE_TIMEOUT_MS,
          fenceTtlSeconds: env.ASSET_TRANSFER_FENCE_TTL_SECONDS,
          tokens: new InternalTokenService(
            env.INTERNAL_TOKEN_SECRET,
            env.INTERNAL_TOKEN_ISSUER,
            env.INTERNAL_TOKEN_TTL_SECONDS,
          ),
        }),
    },
    // EXP-002 slice 7: who owns a document, asked before a reference to it is
    // stored. Its own minting `InternalTokenService`, as the clearance has.
    {
      provide: DOCUMENT_LOOKUP,
      inject: [ENV],
      useFactory: (env: AssetEnv): DocumentLookup =>
        new DocumentLookupClient({
          baseUrl: env.DOCUMENT_SERVICE_URL,
          timeoutMs: env.ASSET_DOCUMENT_LOOKUP_TIMEOUT_MS,
          tokens: new InternalTokenService(
            env.INTERNAL_TOKEN_SECRET,
            env.INTERNAL_TOKEN_ISSUER,
            env.INTERNAL_TOKEN_TTL_SECONDS,
          ),
        }),
    },
    AssetService,
    {
      // Idempotency-Key on POST /v1/assets (#169).
      provide: IdempotencyStore,
      inject: [PrismaService, ENV],
      useFactory: (prisma: PrismaService, env: AssetEnv) => new IdempotencyStore(prisma, env),
    },
    TransferRecordService,
    AssetSnapshotService,
    InsurancePolicyStandingService,

    {
      provide: InsuranceService,
      inject: [AssetRepository, AssetService, ENV],
      useFactory: (repository: AssetRepository, assets: AssetService, env: AssetEnv) =>
        new InsuranceService(repository, assets, env.EXPIRY_WARNING_DAYS),
    },

    {
      provide: ClaimService,
      inject: [AssetRepository, AssetService, ENV],
      useFactory: (repository: AssetRepository, assets: AssetService, env: AssetEnv) =>
        new ClaimService(repository, assets, {
          decisionRoles: env.INSURANCE_CLAIM_DECISION_ROLES,
          approvalCeilingMinor: env.INSURANCE_CLAIM_APPROVAL_CEILING_MINOR,
        }),
    },

    {
      provide: TimelineConsumer,
      inject: [ENV, LOGGER, AssetRepository, AssetService],
      useFactory: (
        env: AssetEnv,
        logger: Logger,
        repository: AssetRepository,
        assets: AssetService,
      ) =>
        new TimelineConsumer(
          (handler) =>
            new EventConsumer(
              {
                ...kafkaConnection(env, `${env.KAFKA_CLIENT_ID}-timeline`),
                groupId: 'asset-service.timeline',
                topics: CONSUMED_TOPICS,
                deadLetterTopic: 'rasta.asset.v1.dlq',
                // Projectors read from the start: a dossier that begins at the
                // moment this service was first deployed is not a dossier.
                fromBeginning: true,
              },
              handler,
              {
                log: (m) => logger.info(m),
                warn: (m) => logger.warn(m),
                error: (m, trace) => logger.error({ err: trace }, m),
              },
            ),
          repository,
          assets,
          // D-039: a `.retry` delivery derives the status from what the owners
          // of a machine's work say now, not from the replayed payload.
          new AssetWorkStateClient({
            from: SERVICE_NAME,
            fleet: {
              baseUrl: env.FLEET_SERVICE_URL,
              timeoutMs: env.ASSET_TRANSFER_CLEARANCE_TIMEOUT_MS,
              tokens: internalTokens(env),
            },
            maintenance: {
              baseUrl: env.MAINTENANCE_SERVICE_URL,
              timeoutMs: env.ASSET_TRANSFER_CLEARANCE_TIMEOUT_MS,
              tokens: internalTokens(env),
            },
          }),
        ),
    },

    {
      provide: OutboxRelay,
      inject: [PrismaOutboxStore, KafkaEventPublisher, ENV, LOGGER],
      useFactory: (
        store: PrismaOutboxStore,
        publisher: KafkaEventPublisher,
        env: AssetEnv,
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
      // D-052: published rows past OUTBOX_PURGE_RETENTION_HOURS, in bounded batches.
      provide: OutboxPurgeScheduler,
      inject: [PrismaOutboxStore, ENV, LOGGER],
      useFactory: (store: PrismaOutboxStore, env: AssetEnv, logger: Logger) =>
        new OutboxPurgeScheduler({
          store,
          service: SERVICE_NAME,
          logger,
          ...outboxPurgeSettings(env),
        }),
    },
    {
      provide: InsuranceExpirySweepScheduler,
      inject: [InsuranceService, LOGGER],
      useFactory: (insurance: InsuranceService, logger: Logger) =>
        new InsuranceExpirySweepScheduler(insurance, logger),
    },
    {
      // D-052: the relay, the purge, the expiry sweep and the timeline
      // consumer stop together in the destroy phase, by one deadline inside
      // SHUTDOWN_TIMEOUT_MS. The sweep too (Codex r3 on #247): stopped later, it
      // could keep writing outbox rows while the relay drained. The consumer
      // too (Codex on #267): its stop had no bound of its own.
      provide: OutboxShutdown,
      inject: [
        OutboxRelay,
        OutboxPurgeScheduler,
        InsuranceExpirySweepScheduler,
        TimelineConsumer,
        ENV,
      ],
      useFactory: (
        relay: OutboxRelay,
        purge: OutboxPurgeScheduler,
        expirySweep: InsuranceExpirySweepScheduler,
        timeline: TimelineConsumer,
        env: AssetEnv,
      ) =>
        new OutboxShutdown({
          relay,
          purge,
          workers: [expirySweep, timeline],
          budgetMs: outboxShutdownBudgetMs(env),
        }),
    },

    {
      provide: AUTH_OPTIONS,
      inject: [ENV],
      useFactory: (env: AssetEnv): AuthGuardOptions => ({
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

    // Authenticate, then authorize. Registered globally so an endpoint is
    // closed unless it opts out with @Public (AGENTS.md A-12).
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
    private readonly purge: OutboxPurgeScheduler,
    private readonly outboxShutdown: OutboxShutdown,
    private readonly store: PrismaOutboxStore,
    private readonly expirySweep: InsuranceExpirySweepScheduler,
    private readonly idempotency: IdempotencyStore,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    // Middleware rather than an interceptor: it must wrap the guards too, so
    // the auth guard has a context to record the resolved tenant into.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }

  async onModuleInit(): Promise<void> {
    // First of all (D-045): nothing is served, relayed or consumed as a role
    // that could lift this service's database guards.
    await this.prisma.assertRuntimeRole();

    this.relay.start();
    this.purge.start();

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
      try {
        // Expired Idempotency-Key records (#169), removed by age alone:
        // unscoped by necessity, safe because they are already unusable.
        await this.idempotency.purgeExpired();
      } catch {
        // Upkeep must never take the service down either.
      }
    };

    this.gaugeTimer = setInterval(() => void sample(), 15_000);
    this.gaugeTimer.unref?.();

    this.expirySweep.start();
  }

  async onApplicationShutdown(): Promise<void> {
    // The relay, the purge, the expiry sweep and the timeline consumer already
    // stopped in OutboxShutdown's onModuleDestroy, concurrently and by one
    // deadline; this joins that stop and returns at once.
    await this.outboxShutdown.stop();
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
  }
}
